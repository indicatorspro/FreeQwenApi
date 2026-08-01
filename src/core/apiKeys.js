// Access keys for the proxy itself (not for Qwen).
// Sources: the API_KEYS variable and the src/Authorization.txt file.
// An empty list means client authentication is disabled.

import fs from 'fs';

import { config } from '../config/index.js';
import { logError, logInfo } from '../shared/logger.js';
import { API_KEYS_FILE } from '../shared/paths.js';

const FILE_TEMPLATE = `# Access keys for the FreeQwenApi proxy
# ------------------------------------------------
# One key — one line.
#
# Empty file = authentication disabled: the proxy will stop
# checking the Authorization header.
#
# Multiple users — multiple lines:
#   d35ab3e1-a6f9-4d...
#   f2b1cd9c-1b2e-4a...
#
# Empty lines and lines starting with “#” are ignored.
`;

let cache = null;

function readKeysFile() {
    try {
        if (!fs.existsSync(API_KEYS_FILE)) {
            try {
                fs.writeFileSync(API_KEYS_FILE, FILE_TEMPLATE, { encoding: 'utf8', flag: 'wx' });
                logInfo(`Created keys file template: ${API_KEYS_FILE}`);
            } catch (error) {
                logError('Failed to create Authorization.txt', error);
            }
            return [];
        }

        return fs.readFileSync(API_KEYS_FILE, 'utf8')
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#'));
    } catch (error) {
        logError('Error reading keys file', error);
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
