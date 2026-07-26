// Хранение сессии браузера: cookies/storage-state и последний токен.

import fs from 'fs';
import path from 'path';

import { logError, logInfo } from '../shared/logger.js';
import { ACCOUNTS_DIR, AUTH_TOKEN_FILE, SESSION_DIR, ensureDir, safeJoin } from '../shared/paths.js';

function sessionFilePath(accountId, fileName) {
    if (!accountId) return path.join(SESSION_DIR, fileName);
    const dir = safeJoin(ACCOUNTS_DIR, accountId);
    if (!dir) throw new Error(`Недопустимый id аккаунта: ${accountId}`);
    return path.join(dir, fileName);
}

export function initSessionDirectory() {
    ensureDir(SESSION_DIR);
}

const isPuppeteerPage = (context) => context && typeof context.goto === 'function';
const isPlaywrightContext = (context) => context && typeof context.storageState === 'function';

export async function saveSession(context, accountId = null) {
    try {
        initSessionDirectory();

        if (isPuppeteerPage(context)) {
            const cookies = await context.cookies();
            const target = sessionFilePath(accountId, 'cookies.json');
            ensureDir(path.dirname(target));
            fs.writeFileSync(target, JSON.stringify(cookies, null, 2));
            logInfo('Сессия сохранена (cookies)');
            return true;
        }

        if (isPlaywrightContext(context)) {
            const target = sessionFilePath(accountId, 'state.json');
            ensureDir(path.dirname(target));
            await context.storageState({ path: target });
            logInfo('Сессия сохранена (storage state)');
            return true;
        }

        logError('Неизвестный тип контекста браузера');
        return false;
    } catch (error) {
        logError('Ошибка при сохранении сессии', error);
        return false;
    }
}

export async function loadSession(context, accountId = null) {
    try {
        if (isPuppeteerPage(context)) {
            const source = sessionFilePath(accountId, 'cookies.json');
            if (!fs.existsSync(source)) return false;
            const cookies = JSON.parse(fs.readFileSync(source, 'utf8'));
            await context.setCookie(...cookies);
            logInfo('Сессия загружена (cookies)');
            return true;
        }

        if (isPlaywrightContext(context)) {
            const source = sessionFilePath(accountId, 'state.json');
            if (!fs.existsSync(source)) return false;
            await context.storageState({ path: source });
            logInfo('Сессия загружена (storage state)');
            return true;
        }
    } catch (error) {
        logError('Ошибка при загрузке сессии', error);
    }
    return false;
}

export function clearSession(accountId = null) {
    try {
        const targets = [
            sessionFilePath(accountId, 'state.json'),
            sessionFilePath(accountId, 'cookies.json')
        ];
        let cleared = false;
        for (const target of targets) {
            if (fs.existsSync(target)) {
                fs.unlinkSync(target);
                cleared = true;
            }
        }
        if (cleared) logInfo('Сессия очищена');
        return cleared;
    } catch (error) {
        logError('Ошибка при очистке сессии', error);
        return false;
    }
}

export function hasSession(accountId = null) {
    return [
        sessionFilePath(accountId, 'state.json'),
        sessionFilePath(accountId, 'cookies.json')
    ].some(target => fs.existsSync(target));
}

export function saveAuthToken(token) {
    if (!token) return false;
    try {
        initSessionDirectory();
        fs.writeFileSync(AUTH_TOKEN_FILE, token, 'utf8');
        return true;
    } catch (error) {
        logError('Ошибка при сохранении токена авторизации', error);
        return false;
    }
}

export function loadAuthToken() {
    try {
        if (fs.existsSync(AUTH_TOKEN_FILE)) return fs.readFileSync(AUTH_TOKEN_FILE, 'utf8');
    } catch (error) {
        logError('Ошибка при чтении токена авторизации', error);
    }
    return null;
}
