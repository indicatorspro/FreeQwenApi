// OpenAI-compatible chat completions endpoint.
// A single handler serves both /api/chat/completions and /api/v1/chat/completions
// (the version prefix is stripped by the stripVersionPrefix middleware).

import express from 'express';

import { logInfo } from '../../shared/logger.js';
import { normalizeId } from '../../shared/ids.js';
import { mapModel } from '../../core/models/mapping.js';
import { extractConversationHint, extractParentHint, shouldForceNewChat } from '../../core/conversations/resolver.js';
import { runCompletion } from '../../services/completions.js';
import { CompletionStream, buildCompletionResponse, buildErrorResponse } from '../openai.js';
import { clientKey } from '../middleware/index.js';

const router = express.Router();

/** Builds a service request from the HTTP request. */
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
        error: 'Method not supported',
        message: 'Use POST /api/chat/completions'
    });
});

router.post('/chat/completions', async (req, res, next) => {
    try {
        const body = req.body || {};
        const stream = Boolean(body.stream);
        logInfo(`OpenAI-compatible request${stream ? ' (stream)' : ''}`);

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

        // The client left — there is nowhere to write further.
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
            try { res.end(); } catch { /* connection already closed */ }
            return undefined;
        }
        return next(error);
    }
});

export default router;
