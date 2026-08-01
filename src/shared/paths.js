// Single point for computing project paths. Previously each module built its
// own combination of '..'/'..' from import.meta.url — when moving files,
// such paths silently broke.

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { config } from '../config/index.js';

/** Repository root (one level above src/). */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const SRC_DIR = path.join(PROJECT_ROOT, 'src');
export const SESSION_DIR = path.resolve(PROJECT_ROOT, config.paths.session);
export const ACCOUNTS_DIR = path.join(SESSION_DIR, config.paths.accounts);
export const HISTORY_DIR = path.join(SESSION_DIR, 'history');
export const UPLOADS_DIR = path.resolve(PROJECT_ROOT, config.paths.uploads);
export const LOGS_DIR = path.resolve(PROJECT_ROOT, config.paths.logs);
export const TOKENS_FILE = path.join(SESSION_DIR, 'tokens.json');
export const AUTH_TOKEN_FILE = path.join(SESSION_DIR, 'auth_token.txt');
export const MODELS_FILE = path.join(SRC_DIR, 'AvailableModels.txt');
export const API_KEYS_FILE = path.join(SRC_DIR, 'Authorization.txt');

/** Creates directory (and parents) if it doesn't exist yet. */
export function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    return dirPath;
}

/**
 * Safely builds path inside base directory.
 * Returns null if result goes outside (path traversal protection).
 */
export function safeJoin(baseDir, ...segments) {
    const target = path.resolve(baseDir, ...segments);
    const base = path.resolve(baseDir);
    if (target !== base && !target.startsWith(base + path.sep)) return null;
    return target;
}
