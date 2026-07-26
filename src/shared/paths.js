// Единая точка вычисления путей проекта. Раньше каждый модуль складывал
// собственную комбинацию '..'/'..' от import.meta.url — при переносе файла
// такие пути молча ломались.

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { config } from '../config/index.js';

/** Корень репозитория (на уровень выше src/). */
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

/** Создаёт директорию (и родителей), если её ещё нет. */
export function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    return dirPath;
}

/**
 * Безопасно строит путь внутри базовой директории.
 * Возвращает null, если результат выходит за её пределы (защита от path traversal).
 */
export function safeJoin(baseDir, ...segments) {
    const target = path.resolve(baseDir, ...segments);
    const base = path.resolve(baseDir);
    if (target !== base && !target.startsWith(base + path.sep)) return null;
    return target;
}
