// Checks authentication state in the open browser.

import { config } from '../config/index.js';
import { delay } from '../shared/async.js';
import { logError, logInfo, logWarn } from '../shared/logger.js';
import { getAuthenticationStatus, restartBrowserInHeadlessMode, setAuthenticationStatus } from './browser.js';
import { saveSession } from './session.js';

const isPlaywright = (context) => context && typeof context.newPage === 'function';

async function getPage(context) {
    if (context && typeof context.goto === 'function') return context;
    if (context && typeof context.newPage === 'function') return context.newPage();
    throw new Error('Invalid browser context: expected Page or BrowserContext');
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

/** Presence of a login form means the session is not authenticated. */
async function countLoginContainers(page, playwright) {
    if (playwright) return page.locator('.login-container').count();
    return (await page.$$('.login-container')).length;
}

function printLoginInstructions() {
    console.log('------------------------------------------------------');
    console.log('               AUTHENTICATION REQUIRED');
    console.log('------------------------------------------------------');
    console.log('1. Log in to Qwen Chat in the open browser');
    console.log('2. Wait for the login to complete');
    console.log('3. Press ENTER in this console');
    console.log('------------------------------------------------------');
}

/**
 * Checks (and waits for if necessary) authentication.
 * @returns {Promise<boolean>}
 */
export async function checkAuthentication(context) {
    try {
        if (getAuthenticationStatus()) return true;

        const page = await getPage(context);
        const playwright = isPlaywright(context);

        logInfo('Checking authentication…');

        try {
            await page.goto(config.qwen.chatPageUrl, {
                waitUntil: 'domcontentloaded',
                timeout: config.timeouts.page
            });
            if (playwright) await page.waitForLoadState('domcontentloaded');
            await delay(config.timeouts.retryDelay);

            if ((await page.title()).includes('Verification')) {
                logWarn('Verification page is open — please complete it manually');
                await promptUser('After completing verification, press ENTER…');
            }

            if (await countLoginContainers(page, playwright) === 0) {
                logInfo('Authentication is active');
                setAuthenticationStatus(true);
                try {
                    await saveSession(context);
                } catch (error) {
                    logError('Failed to update session', error);
                }
                if (playwright) await page.close();
                return true;
            }

            printLoginInstructions();
            await promptUser('After successful authentication, press ENTER…');

            await page.reload({ waitUntil: 'domcontentloaded', timeout: config.timeouts.page });
            await delay(3000);

            if (await countLoginContainers(page, playwright) === 0) {
                logInfo('Authentication confirmed');
                setAuthenticationStatus(true);
                await saveSession(context);
                if (playwright) await page.close();
                return true;
            }

            logWarn('Authentication not detected');
            setAuthenticationStatus(false);
            return false;
        } catch (error) {
            if (playwright) await page.close().catch(() => {});
            throw error;
        }
    } catch (error) {
        logError('Error checking authentication', error);
        setAuthenticationStatus(false);
        return false;
    }
}

/** Manual login via the Qwen login page. */
export async function startManualAuthentication(context, skipRestart = false) {
    try {
        const page = await getPage(context);
        const playwright = isPlaywright(context);

        logInfo('Opening login page…');
        await page.goto(config.qwen.authSigninUrl, { waitUntil: 'load', timeout: config.timeouts.page });

        printLoginInstructions();
        await promptUser('After successful authentication, press ENTER…');

        await page.goto(config.qwen.chatPageUrl, { waitUntil: 'domcontentloaded', timeout: config.timeouts.page });
        await delay(config.timeouts.retryDelay);

        if (await countLoginContainers(page, playwright) === 0) {
            logInfo('Authentication confirmed');
            setAuthenticationStatus(true);
            await saveSession(context);
            if (playwright) await page.close();
            if (!skipRestart) await restartBrowserInHeadlessMode();
            return true;
        }

        logWarn('Authentication failed');
        setAuthenticationStatus(false);
        return false;
    } catch (error) {
        logError('Error during manual authentication', error);
        setAuthenticationStatus(false);
        return false;
    }
}

/** Whether the page shows a verification prompt. */
export async function checkVerification(page) {
    try {
        if ((await page.title()).includes('Verification')) {
            logWarn('Verification page detected');
            await promptUser('Complete verification and press ENTER…');
            return true;
        }
        return false;
    } catch {
        return false;
    }
}