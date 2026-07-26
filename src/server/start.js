// Запуск прокси: стартовое меню, браузер, HTTP-сервер, корректное завершение.

import { config } from '../config/index.js';
import { FORGETMEAI_WATERMARK } from '../shared/branding.js';
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
   OpenAI-совместимый прокси к Qwen Chat
   ${FORGETMEAI_WATERMARK}
`;

/** Проверяет, что есть с чем стартовать, когда меню пропущено. */
function ensureAccountsForHeadlessStart() {
    const summary = accountsSummary();

    if (summary.total === 0) {
        logError('Не найдено ни одного аккаунта. Запустите `npm run auth` перед стартом сервера.');
        process.exit(1);
    }
    if (summary.available === 0) {
        logError('Все аккаунты недоступны. Обновите авторизацию перед стартом сервера.');
        process.exit(1);
    }

    logInfo(`Аккаунтов: ${summary.total}, доступно: ${summary.available}`);
}

/** Стартовое меню: аккаунты или сразу запуск. */
async function runStartupMenu() {
    for (;;) {
        printAccounts();

        console.log('\n=== Меню ===');
        console.log(`ForgetMeAI: ${FORGETMEAI_WATERMARK}`);
        console.log('1 - Добавить новый аккаунт');
        console.log('2 - Перелогинить аккаунт с истёкшим токеном');
        console.log('3 - Запустить прокси (по умолчанию)');
        console.log('4 - Удалить аккаунт');

        const choice = (await prompt('Ваш выбор (Enter = 3): ')) || '3';

        if (choice === '1') {
            await addAccountInteractive();
        } else if (choice === '2') {
            await reloginAccountInteractive();
        } else if (choice === '4') {
            await removeAccountInteractive();
        } else if (choice === '3') {
            if (accountsSummary().available === 0) {
                console.log('Для запуска нужен хотя бы один рабочий аккаунт.');
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

    logInfo(`Сервер запущен: ${config.server.host}:${config.server.port}`);
    logInfo(`API: ${base}/api  •  дашборд: ${base}/dashboard`);
    logInfo(`OpenAI-совместимый эндпоинт: POST ${base}/api/v1/chat/completions`);
    logInfo(`Моделей доступно: ${getAvailableModels().length}, аккаунтов: ${listAccounts().length}`);
    logInfo(keys.length > 0
        ? `Авторизация клиентов включена (ключей: ${keys.length})`
        : 'Авторизация клиентов отключена (Authorization.txt пуст)');
    logInfo('Вызов инструментов (tools/function calling) включён для агентов: Codex, Claude Code, OpenCode и др.');
}

let server = null;
let shuttingDown = false;

async function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;

    logInfo('Завершение работы…');
    stopSessionCleanup();

    if (server) {
        await new Promise(resolve => server.close(resolve));
    }
    await shutdownBrowser();

    logInfo('Готово.');
    process.exit(code);
}

function registerShutdownHandlers() {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(signal, () => { shutdown(0); });
    }
    process.on('uncaughtException', (error) => {
        logError('Необработанное исключение', error);
        shutdown(1);
    });
    process.on('unhandledRejection', (reason) => {
        logError('Необработанное отклонение промиса', reason instanceof Error ? reason : new Error(String(reason)));
    });
}

/** Точка входа сервера. */
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
        logError('Не удалось инициализировать браузер. Завершение работы.');
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
                logError(`Порт ${config.server.port} уже занят. Возможно, сервер уже запущен.`);
                await shutdownBrowser();
                process.exit(1);
            }
            reject(error);
        });
    });
}

export default startServer;
