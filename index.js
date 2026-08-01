#!/usr/bin/env node
// Entry point: all startup logic lives in src/server/start.js.

import { logError } from './src/shared/logger.js';
import { shutdownBrowser } from './src/browser/browser.js';
import { startServer } from './src/server/start.js';

startServer().catch(async (error) => {
    logError('Error starting server', error);
    await shutdownBrowser();
    process.exit(1);
});
