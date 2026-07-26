// Разбор SSE-потока Qwen Chat.
//
// Раньше этот парсер существовал в двух копиях: одна в Node-ветке, вторая —
// строкой внутри page.evaluate. Копии успели разойтись (браузерная не умела
// отдавать чанки наружу), поэтому стриминг работал только на одном из двух
// путей. Теперь разбор один, а браузер отдаёт наружу сырые строки.

/** Итог разбора потока. */
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

    /** Обрабатывает произвольный кусок текста потока. */
    feedText(text) {
        if (!text) return;
        this.buffer += text;
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';
        for (const line of lines) this.feedLine(line);
    }

    /** Обрабатывает одну строку SSE. */
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
            // Битый чанк — поток продолжаем читать.
            return;
        }

        this.feedChunk(chunk);
    }

    /** Обрабатывает уже разобранный чанк. */
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
        if (delta?.content) {
            this.content += delta.content;
            if (this.onChunk) {
                this.onChunk(delta.content);
                this.streamed = true;
            }
        }
        if (delta?.status === 'finished' || choice.finish_reason) this.finished = true;
    }

    /** Дочитывает остаток буфера (поток закончился без перевода строки). */
    flush() {
        if (this.buffer) {
            const rest = this.buffer;
            this.buffer = '';
            this.feedLine(rest);
        }
    }

    /** Ответ в формате chat.completion. */
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
 * Разбирает не-SSE ответ с кодом 200.
 * Qwen регулярно отвечает JSON-ом с success=false и HTTP 200.
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
        // Не JSON — ниже вернём общую ошибку.
    }

    return { ok: false, error: 'Unexpected non-SSE 200 response', errorBody: body };
}
