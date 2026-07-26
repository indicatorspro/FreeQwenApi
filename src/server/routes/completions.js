// OpenAI-совместимый эндпоинт chat completions.
// Один обработчик обслуживает и /api/chat/completions, и /api/v1/chat/completions
// (версия убирается middleware stripVersionPrefix).

import express from 'express';

import { logInfo } from '../../shared/logger.js';
import { normalizeId } from '../../shared/ids.js';
import { mapModel } from '../../core/models/mapping.js';
import { extractConversationHint, extractParentHint, shouldForceNewChat } from '../../core/conversations/resolver.js';
import { runCompletion } from '../../services/completions.js';
import { CompletionStream, buildCompletionResponse, buildErrorResponse } from '../openai.js';
import { clientKey } from '../middleware/index.js';

const router = express.Router();

/** Собирает запрос к сервису из HTTP-запроса. */
function buildCompletionRequest(req) {
    const body = req.body || {};
    const headers = req.headers || {};

    return {
        messages: body.messages,
        model: body.model,
        tools: body.tools,
        functions: body.functions,
        toolChoice: body.tool_choice ?? body.toolChoice,
        chatId: normalizeId(body.chatId) || normalizeId(body.chat_id),
        parentId: extractParentHint({ body, headers }),
        conversationHint: extractConversationHint({ body, headers }),
        forceNewChat: shouldForceNewChat({ body, headers }),
        clientKey: clientKey(req)
    };
}

router.get('/chat/completions', (req, res) => {
    res.status(405).json({
        error: 'Метод не поддерживается',
        message: 'Используйте POST /api/chat/completions'
    });
});

router.post('/chat/completions', async (req, res, next) => {
    try {
        const body = req.body || {};
        const stream = Boolean(body.stream);
        logInfo(`OpenAI-совместимый запрос${stream ? ' (stream)' : ''}`);

        const request = buildCompletionRequest(req);

        if (!stream) {
            const result = await runCompletion(request);
            if (result.error) {
                return res.status(result.status || 500).json(buildErrorResponse(result.error, 'server_error', result.details));
            }
            return res.json(buildCompletionResponse(result));
        }

        const sse = new CompletionStream(res, mapModel(body.model));
        sse.start();

        // Клиент ушёл — дальше писать некуда.
        res.on('close', () => { sse.closed = true; });

        const result = await runCompletion(request, { onContent: (text) => sse.content(text) });

        if (result.error) {
            sse.error(result.error);
            return sse.end('stop');
        }

        if (result.toolCalls) {
            sse.toolCalls(result.toolCalls);
            return sse.end('tool_calls');
        }

        return sse.end('stop');
    } catch (error) {
        if (res.headersSent) {
            try { res.end(); } catch { /* соединение уже закрыто */ }
            return undefined;
        }
        return next(error);
    }
});

export default router;
