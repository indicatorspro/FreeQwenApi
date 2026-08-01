// Account Affinity: binds chatId → accountId to prevent "chat is not exist".
//
// Problem: with round-robin account rotation, a chat created by account A may
// be accessed by account B on next request → Qwen returns error.
//
// Solution: LRU registry that binds resourceId (chatId) → accountId.
// If bound account is still available, use it; otherwise select new one
// and reset chatId (old chat doesn't exist under new token).
//
// Source: FreeQwenApi_ForgetMeAI (accountAffinity.js).

import { logDebug } from '../../shared/logger.js';

function normalizeIdentifier(value) {
    if (value === null || value === undefined) return null;
    const normalized = String(value).trim();
    return normalized || null;
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
