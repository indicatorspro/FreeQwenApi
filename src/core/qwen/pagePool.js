// Browser tab pool for Qwen requests.
//
// Module intentionally knows nothing about browser.js: base context passed
// as argument. Otherwise we get import cycle browser -> chat -> browser,
// which previously kept all code in one file.

import { config } from '../../config/index.js';
import { logDebug, logError, logInfo, logWarn } from '../../shared/logger.js';
import { setAuthToken, getAuthToken } from './authState.js';
import { saveAuthToken } from '../../browser/session.js';

/**
 * Creates new tab from passed context.
 * Context can be Page (Puppeteer) or BrowserContext (Playwright).
 */
async function createPage(context) {
    if (context && typeof context.newPage === 'function') {
        return context.newPage();
    }

    if (context && typeof context.goto === 'function') {
        // Got Page: don't reuse it as worker — open separate tab
        // of same browser to avoid races and not close base one.
        if (typeof context.browser === 'function') {
            try {
                const browser = context.browser();
                if (browser && typeof browser.newPage === 'function') {
                    return await browser.newPage();
                }
            } catch (error) {
                logWarn(`Failed to create new tab: ${error.message}`);
            }
        }

        if (typeof context.isClosed === 'function' && context.isClosed()) {
            throw new Error('Base browser page is closed');
        }
        return context;
    }

    throw new Error('Invalid browser context: expected Page or BrowserContext');
}

class PagePool {
    constructor(maxSize) {
        this.maxSize = maxSize;
        /** @type {Array<import('puppeteer').Page>} */
        this.pages = [];
        this.baseContext = null;
    }

    /** Takes tab from pool or opens new one and logs it in on chat page. */
    async acquire(context) {
        this.baseContext = context;
        logDebug(`pagePool.acquire: pool size=${this.pages.length}, maxSize=${this.maxSize}`);

        while (this.pages.length > 0) {
            const page = this.pages.pop();
            try {
                if (page === context) continue;
                if (page.isClosed()) continue;
                logDebug('pagePool.acquire: reusing pooled tab');
                await page.evaluate(() => document.readyState);
                return page;
            } catch (error) {
                logWarn(`Pooled tab expired (${String(error.message).slice(0, 60)}), opening a new one`);
                if (page !== context) {
                    try { await page.close(); } catch { /* tab already dead */ }
                }
            }
        }

        logDebug('pagePool.acquire: pool empty, creating new tab');
        const page = await createPage(context);
        logDebug(`pagePool.acquire: navigating to ${config.qwen.chatPageUrl}`);
        // Full 'load' (not domcontentloaded): the webapp's fetch patch must be
        // initialized before we call window.fetch, otherwise completions hang
        // or return Bad_Request. networkidle2 can hang — the app keeps polling.
        await page.goto(config.qwen.chatPageUrl, { waitUntil: 'load', timeout: config.timeouts.page });
        logDebug('pagePool.acquire: navigation complete');

        // Wait until the webapp's anti-bot fetch patch is initialized (polled,
        // not a fixed sleep) — otherwise in-page fetch hangs or Bad_Request.
        const deadline = Date.now() + config.timeouts.baxiaReady;
        let patchReady = false;
        while (Date.now() < deadline) {
            patchReady = await page.evaluate(() => {
                try {
                    return Boolean(window.AWSC) || String(window.fetch).length > 100;
                } catch {
                    return false;
                }
            }).catch(() => false);
            if (patchReady) break;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        logDebug(`pagePool.acquire: fetch patch ready=${patchReady}`);

        const existingToken = getAuthToken();
        if (existingToken) {
            // Inject token into new tab's localStorage
            logDebug('pagePool.acquire: injecting existing token into new tab');
            try {
                await page.evaluate((token) => {
                    localStorage.setItem('token', token);
                }, existingToken);
                logDebug('pagePool.acquire: token injected successfully');
            } catch (error) {
                logDebug(`pagePool.acquire: failed to inject token: ${error.message}`);
            }
        } else {
            // Try to read token from page
            try {
                const token = await page.evaluate(() => localStorage.getItem('token'));
                if (token) {
                    setAuthToken(token);
                    saveAuthToken(token);
                    logInfo('Authorization token obtained from browser');
                }
            } catch (error) {
                logError('Error obtaining authorization token', error);
            }
        }

        return page;
    }

    /** Returns a tab to the pool or closes it if the pool is full. */
    release(page) {
        if (!page) return;
        try {
            if (page.isClosed()) return;
        } catch { return; }

        // Keep the base tab separate from the pool.
        if (page === this.baseContext) return;

        if (this.pages.length < this.maxSize) {
            this.pages.push(page);
        } else {
            page.close().catch(error => logError('Error closing tab', error));
        }
    }

    async clear() {
        const pages = this.pages;
        this.pages = [];
        for (const page of pages) {
            if (page === this.baseContext) continue;
            try { await page.close(); } catch (error) {
                logError('Error closing pooled tab', error);
            }
        }
    }
}

export const pagePool = new PagePool(config.limits.pagePoolSize);

/**
 * Performs work on a pooled tab and always returns it.
 * @template T
 * @param {unknown} context
 * @param {(page: unknown) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withPage(context, fn) {
    const page = await pagePool.acquire(context);
    try {
        return await fn(page);
    } finally {
        pagePool.release(page);
    }
}
