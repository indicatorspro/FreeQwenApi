// Формат ответов OpenAI: JSON и SSE.
// Один источник истины для всех совместимых эндпоинтов.

import { completionId, unixSeconds } from '../shared/ids.js';

/** Тело ответа chat.completion. */
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
        // Метаданные для продолжения диалога в терминах Qwen.
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

/** Писатель SSE-потока в формате chat.completion.chunk. */
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
        // Отключает буферизацию у nginx — иначе поток доходит пачкой в конце.
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

    /** Первый чанк с ролью — его ждут многие клиенты. */
    start() {
        this.chunk({ role: 'assistant' });
    }

    content(text) {
        if (!text) return;
        this.chunk({ content: text });
    }

    /** Вызовы инструментов отдельными дельтами, как это делает OpenAI. */
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
        this.chunk({ content: `Ошибка: ${message}` });
    }

    end(finishReason = 'stop') {
        if (this.closed) return;
        this.chunk({}, finishReason);
        this.res.write('data: [DONE]\n\n');
        this.res.end();
        this.closed = true;
    }
}

/** Тело ошибки в формате OpenAI. */
export function buildErrorResponse(message, type = 'server_error', details = null) {
    return { error: { message, type, ...(details ? { details } : {}) } };
}
