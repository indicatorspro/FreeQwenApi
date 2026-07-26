// Хранилище аккаунтов Qwen: session/tokens.json + session/accounts/<id>/token.txt.

import fs from 'fs';
import path from 'path';

import { config } from '../../config/index.js';
import { logError } from '../../shared/logger.js';
import { ACCOUNTS_DIR, SESSION_DIR, TOKENS_FILE, ensureDir, safeJoin } from '../../shared/paths.js';

const ACCOUNT_ID_PATTERN = /^acc_[a-zA-Z0-9]+$/;

function ensureStorage() {
    ensureDir(SESSION_DIR);
    ensureDir(ACCOUNTS_DIR);
}

/** @returns {Array<{id: string, token: string, resetAt: string|null, invalid?: boolean, label?: string}>} */
export function loadAccounts() {
    ensureStorage();
    if (!fs.existsSync(TOKENS_FILE)) return [];
    try {
        const parsed = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        logError('Не удалось прочитать tokens.json', error);
        return [];
    }
}

export function saveAccounts(accounts) {
    ensureStorage();
    try {
        fs.writeFileSync(TOKENS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
        return true;
    } catch (error) {
        logError('Не удалось сохранить tokens.json', error);
        return false;
    }
}

/** Готов ли аккаунт принимать запросы прямо сейчас. */
export function isAvailable(account, now = Date.now()) {
    if (!account || account.invalid) return false;
    if (!account.resetAt) return true;
    return new Date(account.resetAt).getTime() <= now;
}

/** Статус для отображения: OK | WAIT | INVALID | EXPIRED. */
export function accountStatus(account, now = Date.now()) {
    if (account.invalid) return 'INVALID';
    if (account.resetAt && new Date(account.resetAt).getTime() > now) return 'WAIT';
    const { exp } = decodeTokenInfo(account.token);
    if (exp && exp < now) return 'EXPIRED';
    return 'OK';
}

let pointer = 0;

/** Следующий доступный аккаунт по кругу. */
export function nextAvailableAccount() {
    const available = loadAccounts().filter(account => isAvailable(account));
    if (available.length === 0) return null;
    const account = available[pointer % available.length];
    pointer = (pointer + 1) % available.length;
    return account;
}

export function hasAvailableAccounts() {
    return loadAccounts().some(account => isAvailable(account));
}

export function listAccounts() {
    return loadAccounts();
}

function updateAccount(id, mutate) {
    const accounts = loadAccounts();
    const index = accounts.findIndex(account => account.id === id);
    if (index === -1) return false;
    mutate(accounts[index]);
    saveAccounts(accounts);
    return true;
}

export function markRateLimited(id, hours = config.limits.rateLimitHours) {
    return updateAccount(id, account => {
        account.resetAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
    });
}

export function markInvalid(id) {
    return updateAccount(id, account => { account.invalid = true; });
}

export function markValid(id, newToken = null) {
    return updateAccount(id, account => {
        account.invalid = false;
        account.resetAt = null;
        if (newToken) account.token = newToken;
    });
}

export function removeAccount(id) {
    saveAccounts(loadAccounts().filter(account => account.id !== id));
}

/** Декодирует payload JWT без проверки подписи — только для отображения. */
export function decodeTokenInfo(token) {
    try {
        const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString());
        return { exp: payload.exp ? payload.exp * 1000 : null, accountId: payload.id || null };
    } catch {
        return { exp: null, accountId: null };
    }
}

function isJwt(token) {
    return typeof token === 'string' && token.startsWith('eyJ') && token.split('.').length === 3;
}

/** Директория аккаунта с защитой от path traversal (id попадает в путь). */
function accountDir(id) {
    if (!ACCOUNT_ID_PATTERN.test(id)) return null;
    return safeJoin(ACCOUNTS_DIR, id);
}

function writeTokenFile(id, token) {
    const dir = accountDir(id);
    if (!dir) return false;
    try {
        ensureDir(dir);
        fs.writeFileSync(path.join(dir, 'token.txt'), token, 'utf8');
        return true;
    } catch (error) {
        logError(`Не удалось записать token.txt для ${id}`, error);
        return false;
    }
}

/**
 * Добавляет аккаунт по готовому токену (из дашборда или расширения браузера).
 * @returns {{id: string}|{error: string}}
 */
export function addAccountFromToken(rawToken, label = '') {
    const token = String(rawToken || '').trim();
    if (!isJwt(token)) return { error: 'Невалидный токен: ожидается JWT (eyJ…)' };

    const accounts = loadAccounts();
    if (accounts.some(account => account.token === token)) {
        return { error: 'Этот токен уже добавлен' };
    }

    const ids = new Set(accounts.map(account => account.id));
    let suffix = 2;
    while (ids.has(`acc_${suffix}`)) suffix++;
    const id = `acc_${suffix}`;

    writeTokenFile(id, token);
    accounts.push({ id, token, resetAt: null, label: String(label || '').trim().slice(0, 60) });
    saveAccounts(accounts);
    return { id };
}

/** Обновляет токен существующего аккаунта (ручной релогин). */
export function updateAccountToken(id, rawToken) {
    if (!ACCOUNT_ID_PATTERN.test(String(id))) return { error: 'Некорректный id аккаунта' };

    const token = String(rawToken || '').trim();
    if (!isJwt(token)) return { error: 'Невалидный токен: ожидается JWT (eyJ…)' };

    const accounts = loadAccounts();
    if (!accounts.some(account => account.id === id)) return { error: 'Аккаунт не найден' };
    if (accounts.some(account => account.id !== id && account.token === token)) {
        return { error: 'Этот токен уже используется другим аккаунтом' };
    }
    if (!accountDir(id)) return { error: 'Недопустимый путь аккаунта' };

    markValid(id, token);
    writeTokenFile(id, token);
    return { ok: true, id, exp: decodeTokenInfo(token).exp };
}

/** Человекочитаемый ярлык аккаунта; пустая строка очищает. */
export function setAccountLabel(id, rawLabel) {
    if (!ACCOUNT_ID_PATTERN.test(String(id))) return { error: 'Некорректный id аккаунта' };
    const label = String(rawLabel ?? '').trim().slice(0, 60);
    const updated = updateAccount(id, account => { account.label = label; });
    return updated ? { ok: true, id, label } : { error: 'Аккаунт не найден' };
}

/** Полностью удаляет аккаунт: запись и директорию с токеном. */
export function deleteAccount(id) {
    if (!ACCOUNT_ID_PATTERN.test(String(id))) return { error: 'Некорректный id аккаунта' };
    const dir = accountDir(id);
    if (!dir) return { error: 'Недопустимый путь аккаунта' };

    removeAccount(id);
    try {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
        logError(`Не удалось удалить директорию аккаунта ${id}`, error);
    }
    return { ok: true };
}

/** Сводка по пулу аккаунтов для health/status. */
export function accountsSummary() {
    const now = Date.now();
    const accounts = loadAccounts();
    return {
        total: accounts.length,
        available: accounts.filter(account => isAvailable(account, now)).length,
        invalid: accounts.filter(account => account.invalid).length,
        waiting: accounts.filter(account => account.resetAt && new Date(account.resetAt).getTime() > now).length
    };
}
