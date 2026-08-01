// Qwen Chat chat creation.

import { config } from '../../config/index.js';
import { delay } from '../../shared/async.js';
import { logDebug, logError, logInfo, logWarn } from '../../shared/logger.js';
import { CHAT_TYPES } from './payload.js';
import { CHAT_MODE } from './protocol.js';
import { postViaBrowser } from './transport.js';
import { withPage } from './pagePool.js';

/**
 * Creates new chat.
 *
 * All 3 original projects (Heymoma, ForgetMeAI, Ivanqo) use ONLY browser fetch
 * for chat creation and do NOT call preparePageForApi here — the page navigation
 * to chat.qwen.ai/ IS the session preparation.
 *
 * @param {object} options
 * @param {unknown} options.context — browser context
 * @param {string} options.token
 * @param {string} options.model
 * @param {string} [options.title]
 * @param {string} [options.chatType]
 * @param {number} [options.retryCount]
 * @returns {Promise<{chatId: string, requestId?: string}|{error: string}>}
 */
export async function createChat({
    context,
    token,
    model,
    title = 'New chat',
    chatType = CHAT_TYPES.TEXT,
    retryCount = 0
}) {
    if (!context) return { error: 'Browser not initialized' };
    if (!token) return { error: 'Failed to get authorization token' };

    try {
        logDebug(`createChat: requesting page from pool`);
        const result = await withPage(context, async (page) => {
            logDebug(`createChat: page acquired, calling postViaBrowser to ${config.qwen.createChatUrl}`);

            const res = await postViaBrowser({
                page,
                url: config.qwen.createChatUrl,
                token,
                payload: { title, models: [model], chat_mode: CHAT_MODE, chat_type: chatType, timestamp: Date.now() }
            });
            logDebug(`createChat: postViaBrowser returned ok=${res.ok}, status=${res.status || 'n/a'}`);
            return res;
        });

        if (result.ok && result.data?.success) {
            const chatId = result.data.data.id;
            logInfo(`Chat created: ${chatId}`);
            return { chatId, requestId: result.data.request_id };
        }

        const isTransient = result.status >= 500 && result.status < 600;
        if (isTransient && retryCount < config.limits.maxRetryCount) {
            logWarn(`Chat creation: ${result.status}, retry ${retryCount + 1}/${config.limits.maxRetryCount}`);
            await delay(config.timeouts.retryDelay);
            return createChat({ context, token, model, title, chatType, retryCount: retryCount + 1 });
        }

        logError(`Chat creation error: ${result.status || 'unknown'} (attempt ${retryCount + 1})`);
        return {
            error: isTransient
                ? `Qwen API is unavailable (${result.status}). Try again later.`
                : (result.errorBody || result.error || 'Unknown error')
        };
    } catch (error) {
        logError('Error creating chat', error);
        return { error: String(error) };
    }
}
