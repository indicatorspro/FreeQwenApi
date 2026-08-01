// Assembles the Express application. Does not start anything — this allows the
// app to be brought up in tests without a browser and without listening on a port.

import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';

import { config } from '../config/index.js';
import { logHttpRequest } from '../shared/logger.js';
import { SRC_DIR } from '../shared/paths.js';
import apiRoutes from './routes/index.js';
import {
    cors,
    errorHandler,
    jsonSyntaxErrorHandler,
    notFoundHandler
} from './middleware/index.js';
import { createRateLimitMiddleware } from './middleware/rateLimit.js';

export function createApp() {
    const app = express();

    app.disable('x-powered-by');
    app.use(logHttpRequest);
    app.use(bodyParser.json({ limit: config.server.bodyLimit }));
    app.use(bodyParser.urlencoded({ limit: config.server.bodyLimit, extended: true }));
    app.use(jsonSyntaxErrorHandler);
    app.use(cors);
    app.use('/api', createRateLimitMiddleware());

    app.get(['/', '/dashboard'], (req, res) => {
        res.sendFile(path.join(SRC_DIR, 'dashboard', 'index.html'));
    });

    app.use('/api', apiRoutes);

    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}

export default createApp;
