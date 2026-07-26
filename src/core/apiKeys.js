// Ключи доступа к самому прокси (не к Qwen).
// Источники: переменная API_KEYS и файл src/Authorization.txt.
// Пустой список означает, что авторизация клиентов отключена.

import fs from 'fs';

import { config } from '../config/index.js';
import { logError, logInfo } from '../shared/logger.js';
import { API_KEYS_FILE } from '../shared/paths.js';

const FILE_TEMPLATE = `# Ключи доступа к прокси FreeQwenApi
# ------------------------------------------------
# Один ключ — одна строка.
#
# Пустой файл = авторизация выключена: прокси перестанет
# проверять заголовок Authorization.
#
# Несколько пользователей — несколько строк:
#   d35ab3e1-a6f9-4d...
#   f2b1cd9c-1b2e-4a...
#
# Пустые строки и строки, начинающиеся с «#», игнорируются.
`;

let cache = null;

function readKeysFile() {
    try {
        if (!fs.existsSync(API_KEYS_FILE)) {
            try {
                fs.writeFileSync(API_KEYS_FILE, FILE_TEMPLATE, { encoding: 'utf8', flag: 'wx' });
                logInfo(`Создан шаблон файла ключей: ${API_KEYS_FILE}`);
            } catch (error) {
                logError('Не удалось создать Authorization.txt', error);
            }
            return [];
        }

        return fs.readFileSync(API_KEYS_FILE, 'utf8')
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#'));
    } catch (error) {
        logError('Ошибка чтения файла ключей', error);
        return [];
    }
}

/** @returns {string[]} */
export function getApiKeys() {
    if (!cache) {
        cache = [...new Set([...config.server.apiKeys, ...readKeysFile()])];
    }
    return cache;
}

export function reloadApiKeys() {
    cache = null;
    return getApiKeys();
}

export function isAuthDisabled() {
    return getApiKeys().length === 0;
}

export function isValidApiKey(key) {
    const keys = getApiKeys();
    return keys.length === 0 || keys.includes(key);
}
