// Aliyun Baxia/AWSC runtime preparation before Qwen requests.
//
// Baxia is Aliyun's anti-bot system. The Qwen webapp already loads AWSC/baxia
// scripts natively on the page (and patches window.fetch). Injecting them a
// second time breaks the fetch patch — completions hang or return Bad_Request.
// In headless mode the uidToken is never generated anyway, so this module only
// checks for an already-available token and otherwise does nothing.
//
// Source: FreeQwenApi_Ivanqo (ensureQwenBaxiaReady + prepareQwenPageForApi).

import { logDebug } from '../../shared/logger.js';

/**
 * Checks whether a uidToken is already available on the page.
 * Does NOT inject scripts — the webapp loads them natively.
 * Returns quickly — does not block the request.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<boolean>} true if uidToken was available
 */
export async function ensureBaxiaReady(page) {
    if (!page) return false;

    try {
        const ready = await page.evaluate(() => {
            try {
                const fy = window.__baxia__?.getFYModule?.();
                return Boolean(fy?.getUidToken?.());
            } catch {
                return false;
            }
        });

        if (ready) logDebug('Baxia runtime ready (uidToken available)');
        return ready;
    } catch (error) {
        logDebug(`Baxia preparation failed: ${error.message} — proceeding anyway`);
        return false;
    }
}

/**
 * Full page preparation before API request:
 * 1. Token synchronization in localStorage
 * 2. Baxia runtime loading (best-effort, non-blocking)
 *
 * @param {import('puppeteer').Page} page
 * @param {{ token?: string|null }} [auth]
 * @returns {Promise<{ baxiaReady: boolean }>}
 */
export async function preparePageForApi(page, { token = null } = {}) {
    if (!page) return { baxiaReady: false };

    try {
        // Token synchronization in page localStorage.
        if (token) {
            try {
                await page.evaluate((authToken) => {
                    try { localStorage.setItem('token', authToken); } catch { /* ignore */ }
                }, token);
            } catch (error) {
                logDebug(`preparePageForApi: token sync failed: ${error.message}`);
            }
        }

        // Best-effort Baxia — don't block on it.
        const baxiaReady = await ensureBaxiaReady(page);
        return { baxiaReady };
    } catch (error) {
        logDebug(`preparePageForApi: error: ${error.message}`);
        return { baxiaReady: false };
    }
}
