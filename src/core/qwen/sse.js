// Parsing of the Qwen Chat SSE stream.
//
// Previously this parser existed in two copies: one in the Node branch, the second —
// as a string inside page.evaluate. The copies diverged (the browser one could not
// emit chunks outward), so streaming worked only on one of the two paths.
// Now the parsing is shared, and the browser emits raw strings outward.

/** Result of stream parsing. */
export class SseAccumulator {
    /** @param {{onChunk?: (chunk: string) => void}} [options] */
    constructor({ onChunk = null } = {}) {
        this.onChunk = typeof onChunk === 'function' ? onChunk : null;
        this.buffer = '';
        this.content = '';
        this.responseId = null;
        this.usage = null;
        this.finished = false;
        this.streamed = false;
        /** @type {{status: number, errorBody: string}|null} */
        this.error = null;
    }

    /** Processes arbitrary chunk of stream text. */
    feedText(text) {
        if (!text) return;
        this.buffer += text;
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';
        for (const line of lines) this.feedLine(line);
    }

    /** Processes one SSE line. */
    feedLine(rawLine) {
        if (this.finished || this.error) return;

        const line = String(rawLine || '').trim();
        if (!line || !line.startsWith('data:')) return;

        const payload = line.slice(5).trim();
        if (!payload) return;
        if (payload === '[DONE]') {
            this.finished = true;
            return;
        }

        let chunk;
        try {
            chunk = JSON.parse(payload);
        } catch {
            // Broken chunk — continue reading stream.
            return;
        }

        this.feedChunk(chunk);
    }

    /** Processes already parsed chunk. */
    feedChunk(chunk) {
        if (!chunk || typeof chunk !== 'object') return;

        if (chunk.code === 'RateLimited' || (chunk.code && chunk.detail)) {
            this.error = { status: 429, errorBody: JSON.stringify(chunk) };
            this.finished = true;
            return;
        }
        if (chunk.error && !chunk.choices) {
            this.error = { status: 500, errorBody: JSON.stringify(chunk) };
            this.finished = true;
            return;
        }

        if (chunk['response.created']?.response_id) this.responseId = chunk['response.created'].response_id;
        if (chunk.response_id) this.responseId = chunk.response_id;
        if (chunk.usage) this.usage = chunk.usage;

        const choice = chunk.choices?.[0];
        if (!choice) return;

        const delta = choice.delta;
        if (!delta) return;

        // Qwen streams thinking before the answer when thinking_enabled is true.
        // Phases: "think"/"DeepThinking"/"thinking_summary"/"KeepAlive" carry
        // reasoning; only "answer" (or a phase-less chunk, for non-thinking
        // models) carries the final answer the client should see.
        const phase = delta.phase;
        const isAnswer = !phase || phase === 'answer';
        if (isAnswer && delta.content) {
            this.content += delta.content;
            if (this.onChunk) {
                this.onChunk(delta.content);
                this.streamed = true;
            }
        }
        // A `status: "finished"` chunk only marks the end of the current phase.
        // Thinking phases (think/DeepThinking/thinking_summary/KeepAlive) end
        // with status "finished" while the answer phase still follows — so only
        // treat it as stream-end on the answer phase (or a phase-less chunk,
        // as non-thinking models send).
        if (choice.finish_reason || (delta.status === 'finished' && isAnswer)) this.finished = true;
    }

    /** Reads the remaining buffer (the stream ended without a newline). */
    flush() {
        if (this.buffer) {
            const rest = this.buffer;
            this.buffer = '';
            this.feedLine(rest);
        }
    }

    /** Response in chat.completion format. */
    toCompletion(model) {
        return {
            id: this.responseId || `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
                index: 0,
                message: { role: 'assistant', content: this.content },
                finish_reason: 'stop'
            }],
            usage: this.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            response_id: this.responseId
        };
    }
}

/**
 * Parses a non-SSE response with status code 200.
 * Qwen regularly responds with JSON containing success=false and HTTP 200.
 * @returns {{ok: true, data: object} | {ok: false, status?: number, errorBody: string, error?: string}}
 */
export function parseNonSseBody(body) {
    try {
        const parsed = JSON.parse(body);
        const topLevelCode = parsed?.code;
        const nestedCode = parsed?.data?.code;
        const hasStructuredError =
            parsed?.success === false ||
            Boolean(parsed?.error) ||
            Boolean(parsed?.data?.error) ||
            Boolean(topLevelCode) ||
            Boolean(nestedCode);

        if (hasStructuredError) {
            const isRateLimited = topLevelCode === 'RateLimited' || nestedCode === 'RateLimited';
            return { ok: false, status: isRateLimited ? 429 : 500, errorBody: body };
        }

        if (parsed.choices || parsed.id || (parsed.success === true && parsed.data)) {
            return { ok: true, data: parsed };
        }
    } catch {
        // Not JSON — a generic error will be returned below.
    }

    return { ok: false, error: 'Unexpected non-SSE 200 response', errorBody: body };
}
