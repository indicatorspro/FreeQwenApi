// Запуск и остановка браузера, несущего сессию Qwen Chat.

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

import { config } from '../config/index.js';
import { delay } from '../shared/async.js';
import { logDebug, logError, logInfo, logWarn } from '../shared/logger.js';
import { ACCOUNTS_DIR, ensureDir } from '../shared/paths.js';
import { getAuthToken, setAuthToken } from '../core/qwen/authState.js';
import { pagePool } from '../core/qwen/pagePool.js';
import { saveAuthToken } from './session.js';
import { applyStealthPatches } from './stealth.js';

import fs from 'fs';
import path from 'path';

puppeteer.use(StealthPlugin());

let browserInstance = null;
let browserContext = null;
let authenticated = false;

/**
 * Запускает браузер либо подключается к уже работающему Chrome по CDP.
 * @param {boolean} [visibleMode] — headed-режим для ручного входа/капчи
 * @param {boolean} [skipManualRestart] — не перезапускать в фоне после входа
 */
export async function initBrowser(visibleMode = true, skipManualRestart = false) {
    if (browserInstance) return true;

    const cdpUrl = config.browser.cdpUrl;
    logInfo(cdpUrl
        ? `Подключение к Chrome по CDP (${cdpUrl})…`
        : 'Запуск браузера с Puppeteer Stealth…');

    try {
        browserInstance = cdpUrl
            ? await connectOverCdp(cdpUrl)
            : await launchBrowser(visibleMode);

        // В CDP-режиме открываем свою вкладку, чтобы не занимать текущую у пользователя.
        const page = cdpUrl
            ? await browserInstance.newPage()
            : ((await browserInstance.pages())[0] || await browserInstance.newPage());

        await preparePage(page);
        browserContext = page;
        logInfo('Браузер инициализирован');

        // Chrome, подключённый по CDP, уже несёт живую пользовательскую сессию —
        // интерактивный вход с капчей не нужен.
        if (visibleMode && !cdpUrl) {
            await runManualAuthentication(page, skipManualRestart);
        }

        return true;
    } catch (error) {
        logError('Ошибка при инициализации браузера', error);
        return false;
    }
}

function connectOverCdp(cdpUrl) {
    return puppeteer.connect({
        browserURL: cdpUrl,
        defaultViewport: { width: config.browser.viewportWidth, height: config.browser.viewportHeight }
    });
}

function launchBrowser(visibleMode) {
    return puppeteer.launch({
        headless: !visibleMode,
        slowMo: visibleMode ? 30 : 0,
        executablePath: config.browser.chromePath,
        args: [
            '--no-sandbox', '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage', '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            `--window-size=${config.browser.viewportWidth},${config.browser.viewportHeight}`,
            '--start-maximized', '--disable-infobars',
            '--disable-extensions', '--disable-gpu',
            '--no-first-run', '--no-default-browser-check',
            '--ignore-certificate-errors', '--ignore-certificate-errors-spki-list'
        ],
        defaultViewport: { width: config.browser.viewportWidth, height: config.browser.viewportHeight },
        ignoreHTTPSErrors: true
    });
}

async function preparePage(page) {
    await page.setUserAgent(config.browser.userAgent);
    await page.setViewport({
        width: config.browser.viewportWidth,
        height: config.browser.viewportHeight,
        deviceScaleFactor: 1
    });
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        Connection: 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
    });
    await applyStealthPatches(page);
}

/** Сохраняет cookies текущей страницы в новую директорию аккаунта. */
async function saveAccountCookies(page) {
    try {
        const cookies = await page.cookies();
        const accountId = `acc_${Date.now()}`;
        const accountDir = path.join(ACCOUNTS_DIR, accountId);
        ensureDir(accountDir);
        fs.writeFileSync(path.join(accountDir, 'cookies.json'), JSON.stringify(cookies, null, 2));
        logInfo(`Cookies сохранены для аккаунта ${accountId}`);
        return accountId;
    } catch (error) {
        logError('Ошибка при сохранении cookies', error);
        return null;
    }
}

/** Ждёт ENTER в консоли — пользователь входит в аккаунт руками. */
function waitForEnter() {
    return new Promise((resolve) => {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.resume();
        process.stdin.setEncoding('utf8');
        const onData = (key) => {
            if (key === '\n' || key === '\r' || key.charCodeAt(0) === 13) {
                process.stdin.pause();
                process.stdin.removeListener('data', onData);
                resolve();
            }
        };
        process.stdin.on('data', onData);
    });
}

async function runManualAuthentication(page, skipRestart) {
    try {
        logInfo('Открытие страницы для ручной авторизации…');
        await page.goto(config.qwen.chatPageUrl, {
            waitUntil: 'networkidle2',
            timeout: config.timeouts.navigation
        });
        await delay(5000);

        console.log('------------------------------------------------------');
        console.log('               НЕОБХОДИМА АВТОРИЗАЦИЯ');
        console.log('------------------------------------------------------');
        console.log('1. Войдите в Qwen Chat в открытом браузере');
        console.log('2. Двигайте мышью естественно, не спешите');
        console.log('3. Слайдер капчи решайте медленно');
        console.log('4. Дождитесь полной загрузки главной страницы');
        console.log('5. Нажмите ENTER в этой консоли');
        console.log('------------------------------------------------------');

        await waitForEnter();
        logInfo('Подтверждение получено, продолжаем');

        const cookies = await page.cookies();
        logInfo(`Получено cookies: ${cookies.length}`);

        const token = await page.evaluate(() =>
            localStorage.getItem('token') || localStorage.getItem('auth_token') ||
            localStorage.getItem('access_token') || sessionStorage.getItem('token') ||
            sessionStorage.getItem('auth_token') || null
        );

        if (token) {
            setAuthToken(token);
            saveAuthToken(token);
            logInfo('Токен сохранён');
        } else {
            logWarn('Токен не найден в localStorage/sessionStorage, ищем в cookies');
            const tokenCookie = cookies.find(cookie =>
                cookie.name.toLowerCase().includes('token') || cookie.name.toLowerCase().includes('auth'));
            if (tokenCookie) {
                setAuthToken(tokenCookie.value);
                saveAuthToken(tokenCookie.value);
                logInfo(`Токен найден в cookie: ${tokenCookie.name}`);
            }
        }

        const accountId = await saveAccountCookies(page);
        if (accountId) logInfo(`Сессия сохранена с id: ${accountId}`);

        setAuthenticationStatus(true);
        logInfo('Авторизация завершена');

        if (!skipRestart) await restartBrowserInHeadlessMode();
    } catch (error) {
        logError('Ошибка при ручной авторизации', error);
        throw error;
    }
}

export async function restartBrowserInHeadlessMode() {
    logInfo('Перезапуск браузера в фоновом режиме…');
    const token = getAuthToken();
    if (token) {
        logDebug('Сохраняем токен перед перезапуском');
        saveAuthToken(token);
        await delay(1000);
    }
    await shutdownBrowser();
    await delay(config.timeouts.retryDelay);
    const started = await initBrowser(false);
    logInfo(started ? 'Браузер перезапущен в фоновом режиме' : 'Не удалось перезапустить браузер');
    return started;
}

export async function shutdownBrowser() {
    try {
        try { await pagePool.clear(); } catch (error) { logError('Ошибка при очистке пула вкладок', error); }

        if (browserInstance) {
            try {
                const pages = await browserInstance.pages();
                for (const page of pages) await page.close().catch(() => {});
                await browserInstance.close();
            } catch (error) {
                logError('Ошибка при закрытии браузера', error);
            }
        }

        browserContext = null;
        browserInstance = null;
        logInfo('Браузер закрыт');
    } catch (error) {
        logError('Ошибка при завершении работы браузера', error);
    }
}

export function getBrowserContext() {
    return browserContext;
}

export function isBrowserReady() {
    return Boolean(browserContext);
}

export function setAuthenticationStatus(status) {
    authenticated = Boolean(status);
}

export function getAuthenticationStatus() {
    return authenticated;
}
