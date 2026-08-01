// Persistence for account affinity (resource → accountId bindings).
//
// The affinity registry is in-memory LRU; a restart used to lose every binding,
// so a chat in flight would be re-bound to a different account on reboot and
// Qwen would answer "chat is not exist". This module saves the bindings to a
// versioned JSON file in session/ (same pattern as tokens.json) and restores
// them on boot.

import fs from 'fs';

import { logError, logWarn } from '../../shared/logger.js';
import { SESSION_DIR, TOKENS_FILE, ensureDir } from '../../shared/paths.js';

export const AFFINITY_FILE = TOKENS_FILE.replace('tokens.json', 'affinity.json');

const STORAGE_VERSION = 1;

/**
 * Loads persisted affinity bindings.
 * @returns {Array<[string, string]>} — empty when absent/corrupt.
 */
export function loadAffinityState() {
    if (!fs.existsSync(AFFINITY_FILE)) return [];
    try {
        const parsed = JSON.parse(fs.readFileSync(AFFINITY_FILE, 'utf8'));
        if (parsed?.version !== STORAGE_VERSION || !Array.isArray(parsed.bindings)) {
            logWarn('Affinity state has unknown version, ignoring it');
            return [];
        }
        return parsed.bindings.filter(entry => Array.isArray(entry) && entry.length >= 2);
    } catch (error) {
        logError('Failed to read affinity.json', error);
        return [];
    }
}

/** Persists affinity bindings to session/affinity.json. @returns {boolean} */
export function saveAffinityState(entries) {
    try {
        ensureDir(SESSION_DIR);
        fs.writeFileSync(
            AFFINITY_FILE,
            JSON.stringify({ version: STORAGE_VERSION, bindings: entries }, null, 2),
            'utf8'
        );
        return true;
    } catch (error) {
        logError('Failed to save affinity.json', error);
        return false;
    }
}
