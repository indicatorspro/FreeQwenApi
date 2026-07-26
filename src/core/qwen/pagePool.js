// Пул вкладок браузера для запросов к Qwen.
//
// Модуль намеренно ничего не знает о browser.js: базовый контекст передаётся
// аргументом. Иначе получается цикл импортов browser -> chat -> browser,
// который раньше и держал весь код в одном файле.

import { config } from '../../config/index.js';
import { logError, logInfo, logWarn } from '../../shared/logger.js';
import { setAuthToken, getAuthToken } from './authState.js';
import { saveAuthToken } from '../../browser/session.js';

/**
 * Создаёт новую вкладку из переданного контекста.
 * Контекстом может быть Page (Puppeteer) или BrowserContext (Playwright).
 */
async function createPage(context) {
    if (context && typeof context.newPage === 'function') {
        return context.newPage();
    }

    if (context && typeof context.goto === 'function') {
        // Пришла Page: не переиспользуем её как рабочую — открываем отдельную
        // вкладку того же браузера, чтобы не ловить гонки и не закрыть базовую.
        if (typeof context.browser === 'function') {
            try {
                const browser = context.browser();
                if (browser && typeof browser.newPage === 'function') {
                    return await browser.newPage();
                }
            } catch (error) {
                logWarn(`Не удалось создать новую вкладку: ${error.message}`);
            }
        }

        if (typeof context.isClosed === 'function' && context.isClosed()) {
            throw new Error('Базовая страница браузера закрыта');
        }
        return context;
    }

    throw new Error('Неверный контекст браузера: ожидается Page или BrowserContext');
}

class PagePool {
    constructor(maxSize) {
        this.maxSize = maxSize;
        /** @type {Array<import('puppeteer').Page>} */
        this.pages = [];
        this.baseContext = null;
    }

    /** Берёт вкладку из пула либо открывает новую и логинит её на странице чата. */
    async acquire(context) {
        this.baseContext = context;

        while (this.pages.length > 0) {
            const page = this.pages.pop();
            try {
                if (page === context) continue;
                if (page.isClosed()) continue;
                await page.evaluate(() => document.readyState);
                return page;
            } catch (error) {
                logWarn(`Вкладка из пула протухла (${String(error.message).slice(0, 60)}), открываем новую`);
                if (page !== context) {
                    try { await page.close(); } catch { /* вкладка уже мертва */ }
                }
            }
        }

        const page = await createPage(context);
        await page.goto(config.qwen.chatPageUrl, { waitUntil: 'domcontentloaded', timeout: config.timeouts.page });

        if (!getAuthToken()) {
            try {
                const token = await page.evaluate(() => localStorage.getItem('token'));
                if (token) {
                    setAuthToken(token);
                    saveAuthToken(token);
                    logInfo('Токен авторизации получен из браузера');
                }
            } catch (error) {
                logError('Ошибка при получении токена авторизации', error);
            }
        }

        return page;
    }

    /** Возвращает вкладку в пул либо закрывает, если пул полон. */
    release(page) {
        if (!page) return;
        try {
            if (page.isClosed()) return;
        } catch { return; }

        // Базовую вкладку держим отдельно от пула.
        if (page === this.baseContext) return;

        if (this.pages.length < this.maxSize) {
            this.pages.push(page);
        } else {
            page.close().catch(error => logError('Ошибка при закрытии вкладки', error));
        }
    }

    async clear() {
        const pages = this.pages;
        this.pages = [];
        for (const page of pages) {
            if (page === this.baseContext) continue;
            try { await page.close(); } catch (error) {
                logError('Ошибка при закрытии вкладки из пула', error);
            }
        }
    }
}

export const pagePool = new PagePool(config.limits.pagePoolSize);

/**
 * Выполняет работу на вкладке из пула и всегда возвращает её обратно.
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
