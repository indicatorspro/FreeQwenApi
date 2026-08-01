// Browser launch and shutdown, carrying Qwen Chat session.

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
import { loadAccounts, saveAccounts } from '../core/accounts/store.js';

import fs from 'fs';
import path from 'path';

puppeteer.use(StealthPlugin());

let browserInstance = null;
let browserContext = null;
let authenticated = false;

/**
 * Launches browser or connects to already running Chrome via CDP.
 * @param {boolean} [visibleMode] — headed mode for manual login/captcha
 * @param {boolean} [skipManualRestart] — don't restart in background after login
 */
export async function initBrowser(visibleMode = true, skipManualRestart = false) {
    if (browserInstance) return true;

    const cdpUrl = config.browser.cdpUrl;
    logInfo(cdpUrl
        ? `Connecting to Chrome via CDP (${cdpUrl})…`
        : 'Launching browser with Puppeteer Stealth…');

    try {
        browserInstance = cdpUrl
            ? await connectOverCdp(cdpUrl)
            : await launchBrowser(visibleMode);

        // In CDP mode open our own tab to not occupy user's current tab.
        const page = cdpUrl
            ? await browserInstance.newPage()
            : ((await browserInstance.pages())[0] || await browserInstance.newPage());

        await preparePage(page);
        browserContext = page;
        logInfo('Browser initialized');

        // Chrome connected via CDP already carries live user session —
        // interactive login with captcha not needed.
        if (visibleMode && !cdpUrl) {
            await runManualAuthentication(page, skipManualRestart);
        }

        return true;
    } catch (error) {
        logError('Error during browser initialization', error);
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
    const args = [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage', '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        `--window-size=${config.browser.viewportWidth},${config.browser.viewportHeight}`,
        '--start-maximized', '--disable-infobars',
        '--disable-extensions', '--disable-gpu',
        '--no-first-run', '--no-default-browser-check',
        '--ignore-certificate-errors', '--ignore-certificate-errors-spki-list'
    ];

    // Proxy: explicit server or disable system proxy.
    if (config.browser.proxyServer) {
        args.push(`--proxy-server=${config.browser.proxyServer}`);
        if (config.browser.proxyBypassList) {
            args.push(`--proxy-bypass-list=${config.browser.proxyBypassList}`);
        }
    } else if (config.browser.disableSystemProxy) {
        args.push('--no-proxy-server');
    }

    const proxyMode = config.browser.proxyServer
        ? `explicit proxy (${config.browser.proxyServer})`
        : (config.browser.disableSystemProxy ? 'direct/no-system-proxy' : 'system network settings');
    logInfo(`Browser network: ${proxyMode}`);
    logInfo(`Timeouts: node=${config.timeouts.nodeFetch}ms, browser=${config.timeouts.browserFetch}ms, cdp=${config.timeouts.protocol}ms`);

    return puppeteer.launch({
        headless: !visibleMode,
        slowMo: visibleMode ? 30 : 0,
        executablePath: config.browser.chromePath,
        args,
        defaultViewport: { width: config.browser.viewportWidth, height: config.browser.viewportHeight },
        protocolTimeout: config.timeouts.protocol,
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

/** Saves cookies from the current page into a new account directory. */
async function saveAccountCookies(page) {
    try {
        const cookies = await page.cookies();
        const accountId = `acc_${Date.now()}`;
        const accountDir = path.join(ACCOUNTS_DIR, accountId);
        ensureDir(accountDir);
        fs.writeFileSync(path.join(accountDir, 'cookies.json'), JSON.stringify(cookies, null, 2));
        logInfo(`Cookies saved for account ${accountId}`);
        return accountId;
    } catch (error) {
        logError('Error saving cookies', error);
        return null;
    }
}

/** Waits for ENTER in the console — user logs in manually. */
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
        logInfo('Opening page for manual authentication…');
        await page.goto(config.qwen.chatPageUrl, {
            waitUntil: 'networkidle2',
            timeout: config.timeouts.navigation
        });
        await delay(5000);

        console.log('------------------------------------------------------');
        console.log('               AUTHENTICATION REQUIRED');
        console.log('------------------------------------------------------');
        console.log('1. Log in to Qwen Chat in the open browser');
        console.log('2. Move the mouse naturally, do not rush');
        console.log('3. Solve the captcha slider slowly');
        console.log('4. Wait for the main page to fully load');
        console.log('5. Press ENTER in this console');
        console.log('------------------------------------------------------');

        await waitForEnter();
        logInfo('Confirmation received, continuing');

        const cookies = await page.cookies();
        logInfo(`Cookies obtained: ${cookies.length}`);

        const token = await page.evaluate(() =>
            localStorage.getItem('token') || localStorage.getItem('auth_token') ||
            localStorage.getItem('access_token') || sessionStorage.getItem('token') ||
            sessionStorage.getItem('auth_token') || null
        );

        if (token) {
            setAuthToken(token);
            saveAuthToken(token);
            logInfo('Token saved');
        } else {
            logWarn('Token not found in localStorage/sessionStorage, searching cookies');
            const tokenCookie = cookies.find(cookie =>
                cookie.name.toLowerCase().includes('token') || cookie.name.toLowerCase().includes('auth'));
            if (tokenCookie) {
                setAuthToken(tokenCookie.value);
                saveAuthToken(tokenCookie.value);
                logInfo(`Token found in cookie: ${tokenCookie.name}`);
            }
        }

        const accountId = await saveAccountCookies(page);
        if (accountId) {
            logInfo(`Session saved with id: ${accountId}`);
            // Also add to tokens.json so account selection can use it
            const tokenValue = getAuthToken();
            if (tokenValue) {
                const accounts = loadAccounts();
                if (!accounts.some(a => a.token === tokenValue)) {
                    accounts.push({ id: accountId, token: tokenValue, resetAt: null });
                    saveAccounts(accounts);
                    logInfo(`Account ${accountId} added to tokens.json`);
                }
            }
        }

        setAuthenticationStatus(true);
        logInfo('Authentication complete');

        if (!skipRestart) await restartBrowserInHeadlessMode();
    } catch (error) {
        logError('Error during manual authentication', error);
        throw error;
    }
}

export async function restartBrowserInHeadlessMode() {
    logInfo('Restarting browser in background mode…');
    const token = getAuthToken();
    if (token) {
        logDebug('Saving token before restart');
        saveAuthToken(token);
        await delay(1000);
    }
    await shutdownBrowser();
    await delay(config.timeouts.retryDelay);
    const started = await initBrowser(false);
    logInfo(started ? 'Browser restarted in headless mode' : 'Failed to restart browser');
    return started;
}

export async function shutdownBrowser() {
    try {
        try { await pagePool.clear(); } catch (error) { logError('Error clearing tab pool', error); }

        if (browserInstance) {
            try {
                const pages = await browserInstance.pages();
                for (const page of pages) await page.close().catch(() => {});
                await browserInstance.close();
            } catch (error) {
                logError('Error closing browser', error);
            }
        }

        browserContext = null;
        browserInstance = null;
        logInfo('Browser closed');
    } catch (error) {
        logError('Error during browser shutdown', error);
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
