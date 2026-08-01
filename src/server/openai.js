// OpenAI response format: JSON and SSE.
// Single source of truth for all compatible endpoints.

import { completionId, unixSeconds } from '../shared/ids.js';

/** chat.completion response body. */
export function buildCompletionResponse(result) {
    const message = result.toolCalls
        ? { role: 'assistant', content: result.content || null, tool_calls: result.toolCalls.map(stripIndex) }
        : { role: 'assistant', content: result.content ?? '' };

    return {
        id: result.id || completionId(),
        object: 'chat.completion',
        created: result.created || unixSeconds(),
        model: result.model,
        choices: [{
            index: 0,
            message,
            finish_reason: result.toolCalls ? 'tool_calls' : 'stop'
        }],
        usage: result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        // Metadata for continuing dialog in Qwen terms.
        chatId: result.chatId,
        parentId: result.parentId,
        x_qwen_chat_id: result.chatId,
        x_qwen_parent_id: result.parentId
    };
}

function stripIndex(call) {
    const { index, ...rest } = call;
    return rest;
}

/** SSE stream writer in chat.completion.chunk format. */
export class CompletionStream {
    constructor(res, model) {
        this.res = res;
        this.model = model;
        this.id = completionId();
        this.closed = false;

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Connection', 'keep-alive');
        // Disables nginx buffering — otherwise stream arrives in batch at end.
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders?.();
    }

    write(payload) {
        if (this.closed) return;
        this.res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }

    chunk(delta, finishReason = null) {
        this.write({
            id: this.id,
            object: 'chat.completion.chunk',
            created: unixSeconds(),
            model: this.model,
            choices: [{ index: 0, delta, finish_reason: finishReason }]
        });
    }

    /** First chunk with role — many clients wait for it. */
    start() {
        this.chunk({ role: 'assistant' });
    }

    content(text) {
        if (!text) return;
        this.chunk({ content: text });
    }

    /** Tool calls as separate deltas, as OpenAI does. */
    toolCalls(calls) {
        calls.forEach((call, position) => {
            this.chunk({
                tool_calls: [{
                    index: call.index ?? position,
                    id: call.id,
                    type: 'function',
                    function: call.function
                }]
            });
        });
    }

    error(message) {
        this.chunk({ content: `Error: ${message}` });
    }

    end(finishReason = 'stop') {
        if (this.closed) return;
        this.chunk({}, finishReason);
        this.res.write('data: [DONE]\n\n');
        this.res.end();
        this.closed = true;
    }
}

/** Error body in OpenAI format. */
export function buildErrorResponse(message, type = 'server_error', details = null) {
    return { error: { message, type, ...(details ? { details } : {}) } };
}
