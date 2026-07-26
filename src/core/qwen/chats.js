// Создание чатов Qwen Chat.

import { config } from '../../config/index.js';
import { delay } from '../../shared/async.js';
import { logError, logInfo, logWarn } from '../../shared/logger.js';
import { CHAT_TYPES } from './payload.js';
import { postViaBrowser } from './transport.js';
import { withPage } from './pagePool.js';

/**
 * Создаёт новый чат.
 *
 * Токен передаётся аргументом, а не берётся из ротации: создание чата и
 * отправка сообщения обязаны идти под одним аккаунтом, иначе Qwen ответит
 * «chat is not exist» — round-robin разнесёт их по разным аккаунтам.
 *
 * @param {object} options
 * @param {unknown} options.context — контекст браузера
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
    title = 'Новый чат',
    chatType = CHAT_TYPES.TEXT,
    retryCount = 0
}) {
    if (!context) return { error: 'Браузер не инициализирован' };
    if (!token) return { error: 'Не удалось получить токен авторизации' };

    try {
        const result = await withPage(context, (page) => postViaBrowser({
            page,
            url: config.qwen.createChatUrl,
            token,
            payload: { title, models: [model], chat_mode: 'normal', chat_type: chatType, timestamp: Date.now() }
        }));

        if (result.ok && result.data?.success) {
            const chatId = result.data.data.id;
            logInfo(`Чат создан: ${chatId}`);
            return { chatId, requestId: result.data.request_id };
        }

        const isTransient = result.status >= 500 && result.status < 600;
        if (isTransient && retryCount < config.limits.maxRetryCount) {
            logWarn(`Создание чата: ${result.status}, повтор ${retryCount + 1}/${config.limits.maxRetryCount}`);
            await delay(config.timeouts.retryDelay);
            return createChat({ context, token, model, title, chatType, retryCount: retryCount + 1 });
        }

        logError(`Ошибка создания чата: ${result.status || 'unknown'} (попытка ${retryCount + 1})`);
        return {
            error: isTransient
                ? `Qwen API недоступен (${result.status}). Повторите позже.`
                : (result.errorBody || result.error || 'Неизвестная ошибка')
        };
    } catch (error) {
        logError('Ошибка при создании чата', error);
        return { error: String(error) };
    }
}
