// Middleware HTTP-слоя.

import { shortHash } from '../../shared/ids.js';
import { logError, logWarn } from '../../shared/logger.js';
import { getApiKeys } from '../../core/apiKeys.js';
import { AppError } from '../../shared/errors.js';

/** Проверка ключа доступа к прокси. Пустой список ключей отключает проверку. */
export function apiKeyAuth(req, res, next) {
    const keys = getApiKeys();
    if (keys.length === 0) return next();

    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        logWarn('Запрос без заголовка авторизации');
        return res.status(401).json({ error: 'Требуется авторизация' });
    }

    if (!keys.includes(header.slice(7).trim())) {
        logWarn('Предоставлен недействительный ключ');
        return res.status(401).json({ error: 'Недействительный токен' });
    }

    return next();
}

/**
 * Убирает версию из пути: /api/v1/chat/completions → /api/chat/completions.
 * Клиенты OpenAI SDK жёстко добавляют /v1, поэтому обрабатываем оба варианта.
 */
export function stripVersionPrefix(req, res, next) {
    req.url = req.url.replace(/\/v[12](?=\/|$)/g, '').replace(/\/+/g, '/');
    next();
}

export function cors(req, res, next) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
}

/**
 * Управление аккаунтами содержит токены Qwen, поэтому доступно только с
 * localhost: HOST=0.0.0.0 слушает все интерфейсы, включая локальную сеть.
 */
export function localOnly(req, res, next) {
    const ip = req.socket?.remoteAddress || '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
    logWarn(`Отклонён не-локальный доступ к управлению аккаунтами с ${ip}`);
    return res.status(403).json({ error: 'Управление аккаунтами доступно только с localhost' });
}

/**
 * Защита от CSRF: заголовок ACAO:* разрешает cross-origin запросы, поэтому
 * мутирующие вызовы принимаем только со своего origin.
 */
export function sameOriginOnly(req, res, next) {
    const origin = req.get('origin');
    if (!origin) return next();

    // Расширения браузера ставит сам пользователь, и подделать *-extension://
    // веб-страница не может — это не вектор CSRF.
    if (/^(chrome-extension|moz-extension|safari-web-extension):\/\//i.test(origin)) return next();

    try {
        if (new URL(origin).host !== req.get('host')) {
            return res.status(403).json({ error: 'Cross-origin запрос запрещён' });
        }
    } catch {
        return res.status(403).json({ error: 'Некорректный Origin' });
    }

    return next();
}

/** Стабильный ключ клиента для восстановления контекста диалога. */
export function clientKey(req) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';
    return shortHash(`${ip}||${userAgent}`, 64);
}

/** Понятный ответ на битый JSON вместо стандартного HTML Express. */
export function jsonSyntaxErrorHandler(err, req, res, next) {
    const isJsonError = err instanceof SyntaxError
        && err.status === 400
        && Object.prototype.hasOwnProperty.call(err, 'body');

    if (!isJsonError) return next(err);

    logWarn(`Некорректный JSON в запросе: ${err.message}`);
    return res.status(400).json({
        error: 'Некорректный JSON',
        message: 'Проверьте тело запроса: ожидается валидный JSON с двойными кавычками.'
    });
}

export function notFoundHandler(req, res) {
    logWarn(`404 Not Found: ${req.method} ${req.originalUrl}`);
    res.status(404).json({ error: 'Эндпоинт не найден' });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
    if (err instanceof AppError) {
        logError(`Ошибка обработки запроса (${err.code})`, err);
        if (res.headersSent) return res.end();
        return res.status(err.status).json(err.toJSON());
    }

    logError('Внутренняя ошибка сервера', err);
    if (res.headersSent) return res.end();
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
}
