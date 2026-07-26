// Отправка сообщений в Qwen Chat: выбор аккаунта, создание чата, запрос,
// обработка лимитов и ротация при отказах.

import { config } from '../../config/index.js';
import { logDebug, logError, logInfo, logRaw, logWarn } from '../../shared/logger.js';
import { unixSeconds } from '../../shared/ids.js';
import { getBrowserContext, initBrowser, setAuthenticationStatus, shutdownBrowser } from '../../browser/browser.js';
import { checkVerification } from '../../browser/auth.js';
import { hasAvailableAccounts, markInvalid, markRateLimited } from '../accounts/store.js';
import { clearAuthToken, getAuthToken, setAuthToken, setBrowserTokenRateLimited } from './authState.js';
import { createChat } from './chats.js';
import { extractTaskId, extractMediaUrl } from './media.js';
import { CHAT_TYPES, buildChatPayload, validateMessageContent } from './payload.js';
import { pagePool, withPage } from './pagePool.js';
import { pollTaskStatus } from './tasks.js';
import { executeChatRequest } from './transport.js';
import { resolveAccount } from './tokens.js';
import { isValidModel } from '../models/registry.js';

/**
 * @typedef {object} SendMessageOptions
 * @property {string|Array} message
 * @property {string} [model]
 * @property {string|null} [chatId]
 * @property {string|null} [parentId]
 * @property {Array} [files]
 * @property {string|null} [systemMessage]
 * @property {'t2t'|'t2i'|'t2v'} [chatType]
 * @property {string|null} [size]
 * @property {boolean} [waitForCompletion] — дожидаться результата долгой задачи
 * @property {(chunk: string) => void} [onChunk]
 * @property {number} [retryCount]
 */

function resolveModel(model) {
    if (!model || !String(model).trim()) return config.server.defaultModel;
    if (!isValidModel(model)) {
        logWarn(`Модель "${model}" отсутствует в списке доступных, используется ${config.server.defaultModel}`);
        return config.server.defaultModel;
    }
    return model;
}

/** Обработка отказа Qwen: верификация, протухший токен, лимит. */
async function handleFailure(response, account, options) {
    logRaw(JSON.stringify(response));
    logError(`Ошибка ответа Qwen: ${response.error || response.statusText || response.status}`);
    if (response.errorBody) logDebug(`Тело ошибки: ${response.errorBody}`);

    const errorBody = String(response.errorBody || '');

    if (response.html?.includes('Verification')) {
        setAuthenticationStatus(false);
        logInfo('Требуется верификация, перезапускаем браузер в видимом режиме');
        await pagePool.clear();
        clearAuthToken();
        await shutdownBrowser();
        await initBrowser(true);
        return {
            error: 'Требуется верификация. Браузер запущен в видимом режиме.',
            verification: true,
            chatId: options.chatId
        };
    }

    const isUnauthorized = response.status === 401
        || errorBody.includes('Unauthorized')
        || errorBody.includes('Token has expired');

    if (isUnauthorized) {
        logWarn(`Токен аккаунта ${account?.id} недействителен (401), пробуем следующий`);
        clearAuthToken();
        setBrowserTokenRateLimited(false);
        if (account?.id && account.id !== 'browser') markInvalid(account.id);

        if (hasAvailableAccounts() && options.retryCount < config.limits.maxRetryCount) {
            // chatId/parentId сбрасываем: чат принадлежит прежнему аккаунту и под
            // новым токеном «не существует».
            return sendMessage({ ...options, chatId: null, parentId: null, retryCount: options.retryCount + 1 });
        }
        return { error: 'Все аккаунты недействительны (401). Требуется повторная авторизация.', chatId: options.chatId };
    }

    const isRateLimited = response.status === 429 || errorBody.includes('RateLimited');
    if (isRateLimited) {
        let hours = config.limits.rateLimitHours;
        try {
            hours = Number(JSON.parse(errorBody).num) || hours;
        } catch { /* тело не JSON — берём значение по умолчанию */ }

        if (account?.id === 'browser') {
            setBrowserTokenRateLimited(true);
            logWarn(`Токен браузера исчерпал лимит, блокировка на ${hours}ч`);
        } else if (account?.id) {
            markRateLimited(account.id, hours);
            logWarn(`Аккаунт ${account.id} исчерпал лимит, блокировка на ${hours}ч, пробуем следующий`);
        }

        clearAuthToken();
        if (hasAvailableAccounts() && options.retryCount < config.limits.maxRetryCount) {
            return sendMessage({ ...options, chatId: null, parentId: null, retryCount: options.retryCount + 1 });
        }
        return { error: `Все аккаунты заблокированы по лимиту (${hours}ч)`, chatId: options.chatId };
    }

    return {
        error: response.error || response.statusText || `HTTP ${response.status}`,
        details: response.errorBody || 'Нет дополнительных деталей',
        chatId: options.chatId
    };
}

/** Ответ на долгую задачу (генерация видео). */
async function handleTaskResponse({ page, response, model, chatId, token, waitForCompletion }) {
    logInfo('Получен ответ с задачей генерации');
    logRaw(JSON.stringify(response.data));

    const taskId = extractTaskId(response.data);
    if (!taskId) {
        logError('Task ID не найден в ответе');
        return { error: 'Task ID не найден в ответе', chatId, rawResponse: response.data };
    }

    logInfo(`Task ID: ${taskId}`);

    if (!waitForCompletion) {
        return {
            id: taskId,
            object: 'chat.completion.task',
            created: unixSeconds(),
            model,
            task_id: taskId,
            chatId,
            parentId: response.data.data?.parent_id || taskId,
            status: 'processing',
            message: 'Задача создана. Прогресс: GET /api/tasks/status/:taskId'
        };
    }

    const result = await pollTaskStatus({ page, taskId, token });

    if (result.success && result.status === 'completed') {
        const videoUrl = extractMediaUrl(result.data, 'video');
        logInfo('Задача завершена успешно');
        return {
            id: taskId,
            object: 'chat.completion',
            created: unixSeconds(),
            model,
            choices: [{
                index: 0,
                message: { role: 'assistant', content: videoUrl || JSON.stringify(result.data) },
                finish_reason: 'stop'
            }],
            usage: result.data.usage || { prompt_tokens: 0, output_tokens: 0, total_tokens: 0 },
            response_id: taskId,
            chatId,
            parentId: taskId,
            task_id: taskId,
            video_url: videoUrl
        };
    }

    logError(`Задача не выполнена: ${result.error}`);
    return { error: result.error || 'Генерация не удалась', status: result.status, chatId, task_id: taskId };
}

/**
 * Отправляет сообщение в Qwen Chat.
 * @param {SendMessageOptions} options
 * @returns {Promise<object>} — ответ в формате chat.completion либо { error }
 */
export async function sendMessage(options) {
    const {
        message,
        model: requestedModel = config.server.defaultModel,
        chatId: requestedChatId = null,
        parentId = null,
        files = null,
        systemMessage = null,
        chatType = CHAT_TYPES.TEXT,
        size = null,
        waitForCompletion = true,
        onChunk = null,
        retryCount = 0
    } = options;

    const context = getBrowserContext();
    if (!context) return { error: 'Браузер не инициализирован', chatId: requestedChatId };

    // Аккаунт выбирается один раз: создание чата и отправка должны идти под
    // одним токеном, иначе Qwen ответит «chat is not exist».
    const account = await resolveAccount(context);
    if (!account) return { error: 'Ошибка авторизации: не удалось получить токен', chatId: requestedChatId };

    const validated = validateMessageContent(message);
    if (validated.error) {
        logError(validated.error);
        return { error: validated.error, chatId: requestedChatId };
    }

    const model = resolveModel(requestedModel);

    let chatId = requestedChatId;
    if (!chatId) {
        const created = await createChat({ context, token: account.token, model, chatType });
        if (created.error) return { error: `Не удалось создать чат: ${created.error}` };
        chatId = created.chatId;
        logInfo(`Создан новый чат: ${chatId}`);
    }

    if (chatType !== CHAT_TYPES.TEXT) {
        const labels = { [CHAT_TYPES.IMAGE]: 'изображение', [CHAT_TYPES.VIDEO]: 'видео' };
        logInfo(`Тип генерации: ${chatType} (${labels[chatType] || chatType})${size ? `, размер: ${size}` : ''}`);
    }

    const normalizedOptions = {
        ...options,
        model,
        chatId,
        chatType,
        retryCount
    };

    let page = null;
    try {
        page = await pagePool.acquire(context);

        if (await checkVerification(page)) {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: config.timeouts.page });
        }

        let token = getAuthToken();
        if (!token) {
            logWarn('Токен отсутствует перед отправкой запроса, читаем из браузера');
            token = await page.evaluate(() => localStorage.getItem('token'));
            if (!token) {
                return { error: 'Токен авторизации не найден. Требуется повторная авторизация.', chatId };
            }
            setAuthToken(token);
        }

        const payload = buildChatPayload({
            content: validated.content,
            model,
            chatId,
            parentId,
            files,
            systemMessage,
            chatType,
            size
        });

        logInfo('Отправка запроса к Qwen API v2…');
        logDebug(`Payload: ${JSON.stringify(payload)}`);

        const response = await executeChatRequest({
            page,
            url: `${config.qwen.chatApiUrl}?chat_id=${chatId}`,
            payload,
            token,
            onChunk
        });

        if (response.ok && response.kind === 'task') {
            return await handleTaskResponse({
                page,
                response,
                model,
                chatId,
                token,
                waitForCompletion
            });
        }

        if (response.ok) {
            logRaw(JSON.stringify(response.data));
            logInfo('Ответ получен');

            const data = response.data;
            data.chatId = chatId;
            data.parentId = data.response_id;
            data.id = data.id || `chatcmpl-${Date.now()}`;
            data.streamed = response.streamed === true;
            return data;
        }

        return await handleFailure(response, account, normalizedOptions);
    } catch (error) {
        logError('Ошибка при отправке сообщения', error);
        return { error: String(error), chatId };
    } finally {
        pagePool.release(page);
    }
}

/**
 * Статус долгой задачи по её идентификатору.
 * @param {string} taskId
 * @param {boolean} [waitForCompletion]
 */
export async function getTaskStatus(taskId, waitForCompletion = false) {
    const context = getBrowserContext();
    if (!context) return { error: 'Браузер не инициализирован', task_id: taskId };

    const account = await resolveAccount(context);
    if (!account?.token) return { error: 'Ошибка авторизации: не удалось получить токен', task_id: taskId };

    return withPage(context, async (page) => {
        const result = waitForCompletion
            ? await pollTaskStatus({ page, taskId, token: account.token })
            : await pollTaskStatus({ page, taskId, token: account.token, maxAttempts: 1, interval: 0 });

        const payload = result.data || result;
        const videoUrl = extractMediaUrl(payload, 'video');
        const imageUrl = extractMediaUrl(payload, 'image');

        return {
            task_id: taskId,
            success: result.success,
            status: result.status,
            error: result.error,
            video_url: videoUrl,
            image_url: imageUrl,
            media_url: videoUrl || imageUrl,
            data: result.data
        };
    });
}

export async function clearPagePool() {
    await pagePool.clear();
}
