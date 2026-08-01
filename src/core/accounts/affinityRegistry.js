// Global account-affinity singleton shared across chat, file and task paths.
//
// A single LRU registry (resourceKey → accountId) is used everywhere so that
// bindings made while sending a chat (files attached) are visible to uploads
// and vice versa. Resource keys are namespaced by type and client scope via
// buildResourceKey in affinity.js.
//
// Bindings are persisted to session/affinity.json (debounced writes) and
// restored on boot, so a restart keeps an in-flight chat bound to the same
// account instead of Qwen answering "chat is not exist".

import { logWarn } from '../../shared/logger.js';
import { createAccountAffinityRegistry } from './affinity.js';
import { loadAffinityState, saveAffinityState } from './affinityPersistence.js';

const PERSIST_DEBOUNCE_MS = 1_000;

const base = createAccountAffinityRegistry({ maxEntries: 10_000 });

/** Restores bindings from disk on boot. */
base.restore(loadAffinityState());

let persistTimer = null;

/** Schedules a debounced persist of the current bindings. */
function schedulePersist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
        persistTimer = null;
        saveAffinityState(base.dump());
    }, PERSIST_DEBOUNCE_MS);
    persistTimer.unref?.();
}

/**
 * Global affinity registry: resource → accountId (LRU, 10k entries).
 * Mutating calls persist their effect after a short debounce.
 */
export const affinityRegistry = {
    bind(resourceId, accountId) {
        const changed = base.bind(resourceId, accountId);
        if (changed) schedulePersist();
        return changed;
    },

    get(resourceId) {
        return base.get(resourceId);
    },

    forget(resourceId) {
        const changed = base.forget(resourceId);
        if (changed) schedulePersist();
        return changed;
    },

    /** Number of active bindings. */
    get size() {
        return base.size;
    }
};

/** Flushes pending bindings to disk immediately (used on graceful shutdown). */
export function flushAffinityState() {
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
    saveAffinityState(base.dump());
}

/** Tests only: clears in-memory bindings without touching the file. */
export function resetAffinityState() {
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
    base.restore([]);
    logWarn('Affinity state reset (in-memory only)');
}
