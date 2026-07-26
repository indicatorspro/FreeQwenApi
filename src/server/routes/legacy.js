// Собственные (не OpenAI) эндпоинты прокси: POST /api/chat и работа с чатами.
// Отличаются от /chat/completions поддержкой chatType (t2i/t2v) и упрощённым телом.

import express from 'express';

import { logError, logInfo } from '../../shared/logger.js';
import { normalizeId } from '../../shared/ids.js';
import { mapModel } from '../../core/models/mapping.js';
import { sendMessage } from '../../core/qwen/client.js';
import { createChat } from '../../core/qwen/chats.js';
import { getBrowserContext } from '../../browser/browser.js';
import { nextAvailableAccount } from '../../core/accounts/store.js';
import { isMetaRequest } from '../../core/conversations/resolver.js';
import { appendMessages, listChats, loadHistory } from '../../core/history/store.js';
import { CompletionStream } from '../openai.js';

const router = express.Router();

/** Достаёт текст запроса из тела: поддерживаются и message, и messages. */
function extractMessage(body) {
    if (body.message) {
        const system = Array.isArray(body.messages)
            ? body.messages.find(message => message?.role === 'system')?.content ?? null
            : null;
        return { content: body.message, systemMessage: system };
    }

    if (!Array.isArray(body.messages)) return { content: null, systemMessage: null };

    const system = body.messages.find(message => message?.role === 'system')?.content ?? null;
    const lastUser = body.messages.filter(message => message?.role === 'user').pop();
    return { content: lastUser?.content ?? null, systemMessage: system };
}

router.post('/chat', async (req, res, next) => {
    try {
        const body = req.body || {};
        const { content, systemMessage } = extractMessage(body);

        if (!content) {
            return res.status(400).json({ error: 'Сообщение не указано' });
        }

        const isMeta = isMetaRequest(body.messages);
        const model = mapModel(body.model);
        const chatId = isMeta ? null : normalizeId(body.chatId);
        const parentId = isMeta ? null : normalizeId(body.parentId);

        logInfo(`Запрос /api/chat, модель: ${model}${body.stream ? ' (stream)' : ''}`);

        if (!body.stream) {
            const result = await sendMessage({
                message: content,
                model,
                chatId,
                parentId,
                systemMessage,
                chatType: body.chatType || 't2t',
                size: body.size || null,
                waitForCompletion: body.waitForCompletion ?? true
            });

            if (result.chatId && result.choices?.[0]?.message && !isMeta) {
                appendMessages(result.chatId, [
                    { role: 'user', content },
                    { role: 'assistant', content: result.choices[0].message.content }
                ]);
            }

            return res.json(result);
        }

        const sse = new CompletionStream(res, model);
        sse.start();
        res.on('close', () => { sse.closed = true; });

        let streamedAny = false;
        const result = await sendMessage({
            message: content,
            model,
            chatId,
            parentId,
            systemMessage,
            onChunk: (chunk) => {
                streamedAny = true;
                sse.content(chunk);
            }
        });

        if (result.error) {
            sse.error(result.error);
            return sse.end('stop');
        }

        // Qwen мог ответить обычным JSON вместо потока — тогда шлём одним куском.
        if (!streamedAny && result.choices?.[0]?.message?.content) {
            sse.content(result.choices[0].message.content);
        }

        return sse.end('stop');
    } catch (error) {
        if (res.headersSent) {
            try { res.end(); } catch { /* соединение закрыто */ }
            return undefined;
        }
        return next(error);
    }
});

router.post('/chats', async (req, res, next) => {
    try {
        const { name, model } = req.body || {};
        const chatModel = mapModel(model);
        const context = getBrowserContext();

        if (!context) return res.status(503).json({ error: 'Браузер не инициализирован' });

        const account = nextAvailableAccount();
        if (!account?.token) return res.status(503).json({ error: 'Нет доступных аккаунтов Qwen' });

        const result = await createChat({
            context,
            token: account.token,
            model: chatModel,
            title: name || 'Новый чат'
        });

        if (result.error) {
            logError(`Не удалось создать чат: ${result.error}`);
            return res.status(500).json({ error: result.error });
        }

        logInfo(`Создан чат: ${result.chatId}`);
        return res.json({ chatId: result.chatId, success: true });
    } catch (error) {
        next(error);
    }
});

router.get('/chats', (req, res, next) => {
    try {
        res.json({ chats: listChats() });
    } catch (error) {
        next(error);
    }
});

router.get('/chats/:chatId/history', (req, res, next) => {
    try {
        const chat = loadHistory(req.params.chatId);
        res.json({ success: true, chatId: req.params.chatId, messages: chat.messages });
    } catch (error) {
        next(error);
    }
});

router.post('/chats/:chatId/history', (req, res, next) => {
    try {
        const { messages } = req.body || {};
        if (!Array.isArray(messages)) {
            return res.status(400).json({ error: 'История сообщений должна быть массивом' });
        }

        appendMessages(req.params.chatId, messages);
        return res.json({ success: true, chatId: req.params.chatId, messagesCount: messages.length });
    } catch (error) {
        next(error);
    }
});

export default router;
