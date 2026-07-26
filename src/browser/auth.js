// Проверка состояния авторизации в открытом браузере.

import { config } from '../config/index.js';
import { delay } from '../shared/async.js';
import { logError, logInfo, logWarn } from '../shared/logger.js';
import { getAuthenticationStatus, restartBrowserInHeadlessMode, setAuthenticationStatus } from './browser.js';
import { saveSession } from './session.js';

const isPlaywright = (context) => context && typeof context.newPage === 'function';

async function getPage(context) {
    if (context && typeof context.goto === 'function') return context;
    if (context && typeof context.newPage === 'function') return context.newPage();
    throw new Error('Неверный контекст браузера: ожидается Page или BrowserContext');
}

function promptUser(question) {
    return new Promise(resolve => {
        process.stdout.write(question);
        const onData = (data) => {
            process.stdin.removeListener('data', onData);
            process.stdin.pause();
            resolve(String(data).trim());
        };
        process.stdin.resume();
        process.stdin.once('data', onData);
    });
}

/** Наличие формы входа означает, что сессия не авторизована. */
async function countLoginContainers(page, playwright) {
    if (playwright) return page.locator('.login-container').count();
    return (await page.$$('.login-container')).length;
}

function printLoginInstructions() {
    console.log('------------------------------------------------------');
    console.log('               НЕОБХОДИМА АВТОРИЗАЦИЯ');
    console.log('------------------------------------------------------');
    console.log('1. Войдите в Qwen Chat в открытом браузере');
    console.log('2. Дождитесь завершения входа');
    console.log('3. Нажмите ENTER в этой консоли');
    console.log('------------------------------------------------------');
}

/**
 * Проверяет (и при необходимости дожидается) авторизацию.
 * @returns {Promise<boolean>}
 */
export async function checkAuthentication(context) {
    try {
        if (getAuthenticationStatus()) return true;

        const page = await getPage(context);
        const playwright = isPlaywright(context);

        logInfo('Проверка авторизации…');

        try {
            await page.goto(config.qwen.chatPageUrl, {
                waitUntil: 'domcontentloaded',
                timeout: config.timeouts.page
            });
            if (playwright) await page.waitForLoadState('domcontentloaded');
            await delay(config.timeouts.retryDelay);

            if ((await page.title()).includes('Verification')) {
                logWarn('Открыта страница верификации — пройдите её вручную');
                await promptUser('После прохождения верификации нажмите ENTER…');
            }

            if (await countLoginContainers(page, playwright) === 0) {
                logInfo('Авторизация активна');
                setAuthenticationStatus(true);
                try {
                    await saveSession(context);
                } catch (error) {
                    logError('Не удалось обновить сессию', error);
                }
                if (playwright) await page.close();
                return true;
            }

            printLoginInstructions();
            await promptUser('После успешной авторизации нажмите ENTER…');

            await page.reload({ waitUntil: 'domcontentloaded', timeout: config.timeouts.page });
            await delay(3000);

            if (await countLoginContainers(page, playwright) === 0) {
                logInfo('Авторизация подтверждена');
                setAuthenticationStatus(true);
                await saveSession(context);
                if (playwright) await page.close();
                return true;
            }

            logWarn('Авторизация не обнаружена');
            setAuthenticationStatus(false);
            return false;
        } catch (error) {
            if (playwright) await page.close().catch(() => {});
            throw error;
        }
    } catch (error) {
        logError('Ошибка при проверке авторизации', error);
        setAuthenticationStatus(false);
        return false;
    }
}

/** Ручной вход через страницу входа Qwen. */
export async function startManualAuthentication(context, skipRestart = false) {
    try {
        const page = await getPage(context);
        const playwright = isPlaywright(context);

        logInfo('Открытие страницы входа…');
        await page.goto(config.qwen.authSigninUrl, { waitUntil: 'load', timeout: config.timeouts.page });

        printLoginInstructions();
        await promptUser('После успешной авторизации нажмите ENTER…');

        await page.goto(config.qwen.chatPageUrl, { waitUntil: 'domcontentloaded', timeout: config.timeouts.page });
        await delay(config.timeouts.retryDelay);

        if (await countLoginContainers(page, playwright) === 0) {
            logInfo('Авторизация подтверждена');
            setAuthenticationStatus(true);
            await saveSession(context);
            if (playwright) await page.close();
            if (!skipRestart) await restartBrowserInHeadlessMode();
            return true;
        }

        logWarn('Авторизация не удалась');
        setAuthenticationStatus(false);
        return false;
    } catch (error) {
        logError('Ошибка при ручной авторизации', error);
        setAuthenticationStatus(false);
        return false;
    }
}

/** Показывает ли страница запрос верификации. */
export async function checkVerification(page) {
    try {
        if ((await page.title()).includes('Verification')) {
            logWarn('Обнаружена страница верификации');
            await promptUser('Пройдите верификацию и нажмите ENTER…');
            return true;
        }
        return false;
    } catch {
        return false;
    }
}
