// Proxy startup: startup menu, browser, HTTP server, graceful shutdown.

import { config } from '../config/index.js';
import { logError, logInfo } from '../shared/logger.js';
import { accountsSummary, listAccounts } from '../core/accounts/store.js';
import { getAvailableModels } from '../core/models/registry.js';
import { getApiKeys } from '../core/apiKeys.js';
import { startSessionCleanup, stopSessionCleanup } from '../core/conversations/store.js';
import { initBrowser, shutdownBrowser } from '../browser/browser.js';
import { addAccountInteractive, printAccounts, reloginAccountInteractive, removeAccountInteractive } from '../cli/accounts.js';
import { prompt } from '../cli/prompt.js';
import { createApp } from './app.js';

const BANNER = `
███████ ██████  ███████ ███████  ██████  ██     ██ ███████ ███    ██  █████  ██████  ██
██      ██   ██ ██      ██      ██    ██ ██     ██ ██      ████   ██ ██   ██ ██   ██ ██
█████   ██████  █████   █████   ██    ██ ██  █  ██ █████   ██ ██  ██ ███████ ██████  ██
██      ██   ██ ██      ██      ██ ▄▄ ██ ██ ███ ██ ██      ██  ██ ██ ██   ██ ██      ██
██      ██   ██ ███████ ███████  ██████   ███ ███  ███████ ██   ████ ██   ██ ██      ██
                                    ▀▀
   OpenAI-compatible proxy for Qwen Chat
`;

/** Checks that there is something to start with when the menu is skipped. */
function ensureAccountsForHeadlessStart() {
    const summary = accountsSummary();

    if (summary.total === 0) {
        logError('No accounts found. Run `npm run auth` before starting the server.');
        process.exit(1);
    }
    if (summary.available === 0) {
        logError('All accounts are unavailable. Refresh authentication before starting the server.');
        process.exit(1);
    }

    logInfo(`Accounts: ${summary.total}, available: ${summary.available}`);
}

/** Startup menu: accounts or immediate launch. */
async function runStartupMenu() {
    for (;;) {
        printAccounts();

        console.log('\n=== Menu ===');
        console.log('1 - Add a new account');
        console.log('2 - Re-login an account with an expired token');
        console.log('3 - Start the proxy (default)');
        console.log('4 - Remove an account');

        const choice = (await prompt('Your choice (Enter = 3): ')) || '3';

        if (choice === '1') {
            await addAccountInteractive();
        } else if (choice === '2') {
            await reloginAccountInteractive();
        } else if (choice === '4') {
            await removeAccountInteractive();
        } else if (choice === '3') {
            if (accountsSummary().available === 0) {
                console.log('At least one working account is required to start.');
                continue;
            }
            return;
        }
    }
}

function logStartupSummary() {
    const host = config.server.host === '0.0.0.0' ? 'localhost' : config.server.host;
    const base = `http://${host}:${config.server.port}`;
    const keys = getApiKeys();

    logInfo(`Server started: ${config.server.host}:${config.server.port}`);
    logInfo(`API: ${base}/api  •  dashboard: ${base}/dashboard`);
    logInfo(`OpenAI-compatible endpoint: POST ${base}/api/v1/chat/completions`);
    logInfo(`Models available: ${getAvailableModels().length}, accounts: ${listAccounts().length}`);
    logInfo(keys.length > 0
        ? `Client authentication enabled (keys: ${keys.length})`
        : 'Client authentication disabled (Authorization.txt is empty)');
    logInfo('Tool calling (tools/function calling) enabled for agents: Codex, Claude Code, OpenCode, etc.');
}

let server = null;
let shuttingDown = false;

async function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;

    logInfo('Shutting down…');
    stopSessionCleanup();

    if (server) {
        await new Promise(resolve => server.close(resolve));
    }
    await shutdownBrowser();

    logInfo('Done.');
    process.exit(code);
}

function registerShutdownHandlers() {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(signal, () => { shutdown(0); });
    }
    process.on('uncaughtException', (error) => {
        logError('Uncaught exception', error);
        shutdown(1);
    });
    process.on('unhandledRejection', (reason) => {
        logError('Unhandled promise rejection', reason instanceof Error ? reason : new Error(String(reason)));
    });
}

/** Server entry point. */
export async function startServer() {
    console.log(BANNER);
    registerShutdownHandlers();

    if (config.server.skipAccountMenu) {
        ensureAccountsForHeadlessStart();
    } else {
        await runStartupMenu();
    }

    const browserReady = await initBrowser(config.browser.visible);
    if (!browserReady) {
        logError('Failed to initialize browser. Shutting down.');
        process.exit(1);
    }

    startSessionCleanup();

    const app = createApp();

    return new Promise((resolve, reject) => {
        server = app.listen(config.server.port, config.server.host, () => {
            logStartupSummary();
            resolve(server);
        });

        server.on('error', async (error) => {
            if (error.code === 'EADDRINUSE') {
                logError(`Port ${config.server.port} is already in use. The server may already be running.`);
                await shutdownBrowser();
                process.exit(1);
            }
            reject(error);
        });
    });
}

export default startServer;
