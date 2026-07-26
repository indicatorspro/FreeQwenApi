#!/usr/bin/env node
// Точка входа: вся логика запуска — в src/server/start.js.

import { logError } from './src/shared/logger.js';
import { shutdownBrowser } from './src/browser/browser.js';
import { startServer } from './src/server/start.js';

startServer().catch(async (error) => {
    logError('Ошибка при запуске сервера', error);
    await shutdownBrowser();
    process.exit(1);
});
