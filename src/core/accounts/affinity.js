// Account Affinity: binds resource (chat/file/task) → accountId to prevent
// "chat is not exist" and to keep file uploads and generation tasks on the
// same account as their chat.
//
// Problem: with round-robin account rotation, a chat created by account A may
// be accessed by account B on next request → Qwen returns error. Same applies
// to files uploaded under one account and tasks started under another.
//
// Solution: LRU registry that binds resourceId → accountId. If bound account is
// still available, use it; otherwise select new one and reset the resource
// (old chat/file doesn't exist under new token).
//
// Source: FreeQwenApi_ForgetMeAI (accountAffinity.js, chat.js:517-645).

import { logDebug } from '../../shared/logger.js';

function normalizeIdentifier(value) {
    if (value === null || value === undefined) return null;
    const normalized = String(value).trim();
    return normalized || null;
}

/**
 * Builds a namespaced registry key for a resource.
 * Files and tasks are additionally scoped by client so two clients uploading
 * the same file id cannot collide; chats are not scoped (they are already
 * client-scoped upstream via identity.js).
 */
export function buildResourceKey(resourceType, resourceId, clientScope = null) {
    const normalizedType = normalizeIdentifier(resourceType);
    const normalizedId = normalizeIdentifier(resourceId);
    if (!normalizedType || !normalizedId) return null;

    if (normalizedType === 'file' || normalizedType === 'task') {
        const normalizedScope = normalizeIdentifier(clientScope) || 'unscoped';
        return `${normalizedType}:${normalizedScope}:${normalizedId}`;
    }
    return `${normalizedType}:${normalizedId}`;
}

/**
 * Binds resource → account in a registry, namespaced by type/scope.
 * @returns {boolean}
 */
export function bindResourceToAccount(registry, resourceType, resourceId, accountId, clientScope = null) {
    if (!registry || typeof registry.bind !== 'function') return false;
    const key = buildResourceKey(resourceType, resourceId, clientScope);
    if (!key || !normalizeIdentifier(accountId)) return false;
    return registry.bind(key, accountId);
}

/** Returns accountId bound to a resource (type+scope namespaced). */
export function getResourceAccountId(registry, resourceType, resourceId, clientScope = null) {
    if (!registry || typeof registry.get !== 'function') return null;
    const key = buildResourceKey(resourceType, resourceId, clientScope);
    return key ? registry.get(key) : null;
}

/** Collects file resource ids from an array of file entries (any shape). */
export function collectFileResourceIds(files) {
    if (!Array.isArray(files)) return [];
    const ids = new Set();
    const keys = new Set(['id', 'file', 'input_file', 'file_id', 'fileId', 'file_path', 'filePath', 'file_url', 'url']);
    const seen = new WeakSet();

    function collect(value) {
        if (typeof value === 'string' && value.trim()) {
            ids.add(value.trim());
            return;
        }
        if (!value || typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) {
            for (const item of value) collect(item);
            return;
        }
        for (const [key, child] of Object.entries(value)) {
            if (keys.has(key)) collect(child);
        }
    }

    for (const file of files) collect(file);
    return [...ids];
}

/**
 * Resolves the account that owns a set of files.
 * @returns {{accountId: string|null, hasFiles: boolean, hasKnownOwner: boolean, resourceIds: string[]}}
 *   — error set when files belong to different accounts.
 */
export function resolveFileAccountId(registry, files, clientScope = null) {
    const resourceIds = collectFileResourceIds(files);
    const accountIds = new Set();
    const hasFiles = Array.isArray(files) && files.length > 0;
    let allFilesHaveKnownOwner = hasFiles && resourceIds.length > 0;

    for (const resourceId of resourceIds) {
        const accountId = getResourceAccountId(registry, 'file', resourceId, clientScope);
        if (!accountId) {
            allFilesHaveKnownOwner = false;
            continue;
        }
        accountIds.add(accountId);
    }

    if (accountIds.size > 1) {
        return {
            error: 'Files belong to different Qwen accounts; re-upload them with a single account',
            accountId: null,
            hasFiles,
            hasKnownOwner: false,
            resourceIds
        };
    }

    return {
        accountId: accountIds.values().next().value || null,
        hasFiles,
        hasKnownOwner: accountIds.size === 1 && allFilesHaveKnownOwner,
        resourceIds
    };
}

/**
 * Creates an immutable snapshot of { id, token }.
 * @param {{ id?: string, token?: string }} tokenObj
 * @returns {{ id: string, token: string } | null}
 */
export function snapshotAccountToken(tokenObj) {
    const id = normalizeIdentifier(tokenObj?.id);
    const token = typeof tokenObj?.token === 'string' ? tokenObj.token : null;
    if (!id || !token) return null;
    return Object.freeze({ id, token });
}

/**
 * Creates an LRU affinity registry chatId → accountId.
 * @param {{ maxEntries?: number }} options
 * @returns {{ bind: Function, get: Function, forget: Function }}
 */
export function createAccountAffinityRegistry({ maxEntries = 10_000 } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
        throw new RangeError('maxEntries must be a positive integer');
    }

    // Map maintains insertion order → use for LRU eviction.
    const accountByResource = new Map();

    return Object.freeze({
        /**
         * Binds resourceId → accountId.
         * Returns false if already bound to different account.
         */
        bind(resourceId, accountId) {
            const normalizedResourceId = normalizeIdentifier(resourceId);
            const normalizedAccountId = normalizeIdentifier(accountId);
            if (!normalizedResourceId || !normalizedAccountId) return false;

            const existingAccountId = accountByResource.get(normalizedResourceId);
            if (existingAccountId && existingAccountId !== normalizedAccountId) {
                logDebug(`Affinity conflict: ${normalizedResourceId} already bound to ${existingAccountId}`);
                return false;
            }

            // LRU eviction: remove oldest if limit reached.
            if (!existingAccountId && accountByResource.size >= maxEntries) {
                const oldestResourceId = accountByResource.keys().next().value;
                accountByResource.delete(oldestResourceId);
                logDebug(`Affinity LRU eviction: ${oldestResourceId}`);
            }

            accountByResource.set(normalizedResourceId, normalizedAccountId);
            return true;
        },

        /**
         * Retrieves accountId bound to resourceId.
         * @returns {string | null}
         */
        get(resourceId) {
            const normalizedResourceId = normalizeIdentifier(resourceId);
            return normalizedResourceId ? accountByResource.get(normalizedResourceId) || null : null;
        },

        /**
         * Removes binding (e.g., account became invalid).
         * @returns {boolean} true if existed
         */
        forget(resourceId) {
            const normalizedResourceId = normalizeIdentifier(resourceId);
            return normalizedResourceId ? accountByResource.delete(normalizedResourceId) : false;
        },

        /** Number of active bindings. */
        get size() {
            return accountByResource.size;
        },

        /** Snapshot of all bindings for persistence: Array<[resourceId, accountId]>. */
        dump() {
            return [...accountByResource.entries()];
        },

        /**
         * Replaces all bindings with persisted entries.
         * Invalid entries (empty id/account) are skipped.
         * @param {Array<[string, string]>} entries
         */
        restore(entries) {
            if (!Array.isArray(entries)) return;
            accountByResource.clear();
            for (const [resourceId, accountId] of entries) {
                const normalizedResourceId = normalizeIdentifier(resourceId);
                const normalizedAccountId = normalizeIdentifier(accountId);
                if (!normalizedResourceId || !normalizedAccountId) continue;
                accountByResource.set(normalizedResourceId, normalizedAccountId);
            }
        }
    });
}

/**
 * Resolves chat request context using affinity.
 *
 * Flow:
 * 1. If chatId has bound account AND account is available → use it (reusedChat: true)
 * 2. Otherwise → select new account, reset chatId (reusedChat: false)
 *
 * @param {object} params
 * @param {string|null} params.chatId
 * @param {string|null} params.parentId
 * @param {ReturnType<typeof createAccountAffinityRegistry>} params.affinityRegistry
 * @param {(accountId: string) => Promise<{id: string, token: string}|null>} params.getAccountToken
 * @param {() => Promise<{id: string, token: string}|null>} params.selectToken
 * @returns {Promise<{accountId: string, token: string, chatId: string|null, parentId: string|null, reusedChat: boolean, resetReason: string|null}|null>}
 */
export async function resolveChatRequestContext({
    chatId = null,
    parentId = null,
    affinityRegistry,
    getAccountToken,
    selectToken
}) {
    if (!affinityRegistry || typeof affinityRegistry.get !== 'function') {
        throw new TypeError('affinityRegistry is required');
    }
    if (typeof getAccountToken !== 'function' || typeof selectToken !== 'function') {
        throw new TypeError('getAccountToken and selectToken must be functions');
    }

    const normalizedChatId = normalizeIdentifier(chatId);
    const normalizedParentId = normalizeIdentifier(parentId);
    const boundAccountId = affinityRegistry.get(normalizedChatId);

    // Try to reuse bound account.
    if (boundAccountId) {
        const boundToken = snapshotAccountToken(await getAccountToken(boundAccountId));
        if (boundToken) {
            logDebug(`Affinity hit: chat ${normalizedChatId} → account ${boundToken.id}`);
            return Object.freeze({
                accountId: boundToken.id,
                token: boundToken.token,
                chatId: normalizedChatId,
                parentId: normalizedParentId,
                reusedChat: true,
                resetReason: null
            });
        }
        // Bound account no longer available.
        affinityRegistry.forget(normalizedChatId);
        logDebug(`Affinity miss: account ${boundAccountId} unavailable, forgetting chat ${normalizedChatId}`);
    }

    // Select new account.
    const selectedToken = snapshotAccountToken(await selectToken());
    if (!selectedToken) return null;

    return Object.freeze({
        accountId: selectedToken.id,
        token: selectedToken.token,
        chatId: null,  // Reset: old chat doesn't exist under new token
        parentId: null,
        reusedChat: false,
        resetReason: normalizedChatId
            ? (boundAccountId ? 'bound_account_unavailable' : 'unknown_chat_affinity')
            : null
    });
}
