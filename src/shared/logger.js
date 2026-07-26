import winston from 'winston';
import morgan from 'morgan';

import { config } from '../config/index.js';
import { LOGS_DIR, ensureDir } from './paths.js';

ensureDir(LOGS_DIR);

const { combine, timestamp, printf, colorize } = winston.format;

const LEVELS = { error: 0, warn: 1, info: 2, http: 3, debug: 4, raw: 5 };
const COLORS = { error: 'red', warn: 'yellow', info: 'green', http: 'cyan', debug: 'blue', raw: 'magenta' };

winston.addColors(COLORS);

const lineFormat = printf(({ level, message, timestamp: ts }) => `${ts} [${level}]: ${message}`);
const fileFormat = combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), lineFormat);
const consoleFormat = combine(colorize({ all: true }), timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), lineFormat);

function fileTransport(filename, level) {
    return new winston.transports.File({
        filename: `${LOGS_DIR}/${filename}`,
        ...(level ? { level } : {}),
        maxsize: config.logging.maxSize,
        maxFiles: config.logging.maxFiles
    });
}

const transports = [
    fileTransport('combined.log'),
    fileTransport('http.log', 'http'),
    fileTransport('error.log', 'error'),
    fileTransport('raw-responses.log', 'raw')
];

// В stdio-режиме MCP stdout занят протоколом JSON-RPC: любая посторонняя строка
// ломает клиента, поэтому консольный транспорт отключается через LOG_CONSOLE=0.
if (config.logging.console) {
    transports.push(new winston.transports.Console({ format: consoleFormat, stderrLevels: [] }));
}

const logger = winston.createLogger({
    levels: LEVELS,
    level: config.logging.level,
    format: fileFormat,
    transports
});

export const logInfo = (message) => logger.info(message);
export const logWarn = (message) => logger.warn(message);
export const logDebug = (message) => logger.debug(message);
export const logRaw = (message) => logger.raw(message);
export const logHttp = (message) => logger.http(message);

export const logError = (message, error) => {
    if (!error) {
        logger.error(message);
        return;
    }
    logger.error(`${message}: ${error.message ?? error}`);
    if (error.stack) logger.error(error.stack);
};

export const logHttpRequest = morgan(
    ':remote-addr :method :url :status :res[content-length] - :response-time ms',
    { stream: { write: (message) => logger.http(message.trim()) } }
);

export default { logInfo, logWarn, logDebug, logRaw, logHttp, logError, logHttpRequest };
