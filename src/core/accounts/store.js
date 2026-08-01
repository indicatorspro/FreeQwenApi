// Qwen accounts storage: session/tokens.json + session/accounts/<id>/token.txt.

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
        logError('Failed to read tokens.json', error);
        return [];
    }
}

export function saveAccounts(accounts) {
    ensureStorage();
    try {
        fs.writeFileSync(TOKENS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
        return true;
    } catch (error) {
        logError('Failed to save tokens.json', error);
        return false;
    }
}

/** Whether account is ready to accept requests right now. */
export function isAvailable(account, now = Date.now()) {
    if (!account || account.invalid) return false;
    if (!account.resetAt) return true;
    return new Date(account.resetAt).getTime() <= now;
}

/** Status for display: OK | WAIT | INVALID | EXPIRED. */
export function accountStatus(account, now = Date.now()) {
    if (account.invalid) return 'INVALID';
    if (account.resetAt && new Date(account.resetAt).getTime() > now) return 'WAIT';
    const { exp } = decodeTokenInfo(account.token);
    if (exp && exp < now) return 'EXPIRED';
    return 'OK';
}

let pointer = 0;

/** Next available account in round-robin. */
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

/**
 * Returns account by ID (for affinity).
 * @param {string} id
 * @returns {{id: string, token: string, resetAt: string|null, invalid?: boolean, label?: string}|null}
 */
export function getAccountById(id) {
    if (!id) return null;
    const accounts = loadAccounts();
    return accounts.find(account => account.id === id) || null;
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

/** Decodes the JWT payload without signature verification — display only. */
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

/** Account directory with path traversal protection (id ends up in the path). */
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
        logError(`Failed to write token.txt for ${id}`, error);
        return false;
    }
}

/**
 * Adds an account from a ready token (from the dashboard or browser extension).
 * @returns {{id: string}|{error: string}}
 */
export function addAccountFromToken(rawToken, label = '') {
    const token = String(rawToken || '').trim();
    if (!isJwt(token)) return { error: 'Invalid token: expected JWT (eyJ…)' };

    const accounts = loadAccounts();
    if (accounts.some(account => account.token === token)) {
        return { error: 'This token has already been added' };
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

/** Updates the token of an existing account (manual re-login). */
export function updateAccountToken(id, rawToken) {
    if (!ACCOUNT_ID_PATTERN.test(String(id))) return { error: 'Invalid account id' };

    const token = String(rawToken || '').trim();
    if (!isJwt(token)) return { error: 'Invalid token: expected JWT (eyJ…)' };

    const accounts = loadAccounts();
    if (!accounts.some(account => account.id === id)) return { error: 'Account not found' };
    if (accounts.some(account => account.id !== id && account.token === token)) {
        return { error: 'This token is already used by another account' };
    }
    if (!accountDir(id)) return { error: 'Invalid account path' };

    markValid(id, token);
    writeTokenFile(id, token);
    return { ok: true, id, exp: decodeTokenInfo(token).exp };
}

/** Human-readable account label; empty string clears it. */
export function setAccountLabel(id, rawLabel) {
    if (!ACCOUNT_ID_PATTERN.test(String(id))) return { error: 'Invalid account id' };
    const label = String(rawLabel ?? '').trim().slice(0, 60);
    const updated = updateAccount(id, account => { account.label = label; });
    return updated ? { ok: true, id, label } : { error: 'Account not found' };
}

/** Completely removes an account: record and token directory. */
export function deleteAccount(id) {
    if (!ACCOUNT_ID_PATTERN.test(String(id))) return { error: 'Invalid account id' };
    const dir = accountDir(id);
    if (!dir) return { error: 'Invalid account path' };

    removeAccount(id);
    try {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
        logError(`Failed to delete account directory ${id}`, error);
    }
    return { ok: true };
}

/** Account pool summary for health/status. */
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
