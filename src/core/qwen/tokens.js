// Getting and validating Qwen tokens.

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
 * Extracts token from Qwen page localStorage.
 * @param {unknown} context — browser context
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
                logError('Authorization token not found in browser');
                return null;
            }

            setAuthToken(token);
            saveAuthToken(token);
            logInfo('Authorization token extracted from browser');
            return token;
        });
    } catch (error) {
        logError('Error extracting authorization token', error);
        return null;
    }
}

/**
 * Selects account for request: first pool, then — browser's own token.
 * @param {unknown} context
 * @returns {Promise<{id: string, token: string}|null>}
 */
export async function resolveAccount(context) {
    const account = nextAvailableAccount();
    if (account?.token) {
        setAuthToken(account.token);
        logInfo(`Using account: ${account.id}`);
        return { id: account.id, token: account.token };
    }

    if (isBrowserTokenRateLimited()) {
        logWarn('Browser token has exhausted its limit, fallback is impossible');
        return null;
    }

    if (!getAuthenticationStatus()) {
        logInfo('Checking authentication…');
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
 * Verifies a token with a real request to Qwen.
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

            // 400 means the request reached the server and was authorized — the token works.
            if (result.ok || result.status === 400) return 'OK';
            if (result.status === 401 || result.status === 403) return 'UNAUTHORIZED';
            if (result.status === 429) return 'RATELIMIT';
            return 'ERROR';
        });
    } catch (error) {
        logError('Token verification error', error);
        return 'ERROR';
    }
}
