// Получение и проверка токенов Qwen.

import { config } from '../../config/index.js';
import { delay } from '../../shared/async.js';
import { logError, logInfo, logWarn } from '../../shared/logger.js';
import { saveAuthToken } from '../../browser/session.js';
import { getAuthenticationStatus } from '../../browser/browser.js';
import { checkAuthentication } from '../../browser/auth.js';
import { hasAvailableAccounts, nextAvailableAccount } from '../accounts/store.js';
import { getAuthToken, isBrowserTokenRateLimited, setAuthToken } from './authState.js';
import { withPage } from './pagePool.js';
import { postViaBrowser } from './transport.js';

/**
 * Достаёт токен из localStorage страницы Qwen.
 * @param {unknown} context — контекст браузера
 * @param {boolean} [forceRefresh]
 * @returns {Promise<string|null>}
 */
export async function extractAuthToken(context, forceRefresh = false) {
    const cached = getAuthToken();
    if (cached && !forceRefresh) return cached;

    try {
        return await withPage(context, async (page) => {
            await page.goto(config.qwen.chatPageUrl, {
                waitUntil: 'domcontentloaded',
                timeout: config.timeouts.page
            });
            await delay(config.timeouts.retryDelay);

            const token = await page.evaluate(() => localStorage.getItem('token'));
            if (!token) {
                logError('Токен авторизации не найден в браузере');
                return null;
            }

            setAuthToken(token);
            saveAuthToken(token);
            logInfo('Токен авторизации извлечён из браузера');
            return token;
        });
    } catch (error) {
        logError('Ошибка при извлечении токена авторизации', error);
        return null;
    }
}

/**
 * Выбирает аккаунт для запроса: сначала пул, затем — токен самого браузера.
 * @param {unknown} context
 * @returns {Promise<{id: string, token: string}|null>}
 */
export async function resolveAccount(context) {
    const account = nextAvailableAccount();
    if (account?.token) {
        setAuthToken(account.token);
        logInfo(`Используется аккаунт: ${account.id}`);
        return { id: account.id, token: account.token };
    }

    if (isBrowserTokenRateLimited()) {
        logWarn('Токен браузера исчерпал лимит, фолбэк невозможен');
        return null;
    }

    if (!getAuthenticationStatus()) {
        logInfo('Проверка авторизации…');
        const authenticated = await checkAuthentication(context);
        if (!authenticated) return null;
    }

    const token = getAuthToken() || await extractAuthToken(context);
    return token ? { id: 'browser', token } : null;
}

export function hasAnyAccount() {
    return hasAvailableAccounts();
}

/**
 * Проверяет токен реальным запросом к Qwen.
 * @returns {Promise<'OK'|'UNAUTHORIZED'|'RATELIMIT'|'ERROR'>}
 */
export async function testToken(context, token) {
    if (!context) return 'ERROR';

    try {
        return await withPage(context, async (page) => {
            await page.goto(config.qwen.chatPageUrl, { waitUntil: 'domcontentloaded' });

            const result = await postViaBrowser({
                page,
                url: config.qwen.chatApiUrl,
                token,
                payload: {
                    chat_type: 't2t',
                    messages: [{ role: 'user', content: 'ping', chat_type: 't2t' }],
                    model: config.server.defaultModel,
                    stream: false
                }
            });

            // 400 означает, что запрос дошёл и был авторизован — токен рабочий.
            if (result.ok || result.status === 400) return 'OK';
            if (result.status === 401 || result.status === 403) return 'UNAUTHORIZED';
            if (result.status === 429) return 'RATELIMIT';
            return 'ERROR';
        });
    } catch (error) {
        logError('Ошибка проверки токена', error);
        return 'ERROR';
    }
}
