// Client scoping and conversation identity registry.
//
// Each client (IP + User-Agent + API-key fingerprint) gets deterministic
// chat_<sha256> aliases, so two clients that send the same first message or
// conversation_id cannot collide on one upstream chat. The registry maps
// aliases to upstream Qwen chats with CAS (anti-stale): a known upstream id
// already owned by a conversation group wins, so stale ids cannot move a
// conversation backwards or create one-hop alias chains.
//
// Source: FreeQwenApi_ForgetMeAI (keyedQueue.js), reusing our scopedHash /
// timing-safe comparison in shared/security.js.

import { normalizeId } from '../../shared/ids.js';
import { fingerprintCredential, matchesAnyCredential, scopedHash } from '../../shared/security.js';

/**
 * Deterministic client scope: ip || user-agent || credential fingerprint.
 * @param {{ip?: string, userAgent?: string, credentialFingerprint?: string|null}} input
 * @returns {string}
 */
export function createClientScope({ ip = '', userAgent = '', credentialFingerprint = null } = {}) {
    const normalizedIp = normalizeId(ip) || 'unknown';
    const normalizedUserAgent = normalizeId(userAgent) || 'unknown';
    const normalizedFingerprint = normalizeId(credentialFingerprint) || 'public';
    return scopedHash(
        `${normalizedIp}||${normalizedUserAgent}||${normalizedFingerprint}`,
        'client-scope'
    );
}

/**
 * Stable chat_<hash> alias scoped to one client.
 * @param {string} value — client-supplied conversation identifier
 * @param {string} clientScope — output of createClientScope
 * @param {string} [namespace]
 * @returns {string|null}
 */
export function createScopedConversationAlias(value, clientScope, namespace = 'client-conversation') {
    const normalizedValue = normalizeId(value);
    const normalizedScope = normalizeId(clientScope);
    if (!normalizedValue || !normalizedScope) return null;
    const hash = scopedHash(`${normalizedScope}:${normalizedValue}`, namespace);
    return `chat_${hash}`;
}

/** SHA-256 fingerprint of a credential (API key, token). */
export function fingerprintClientCredential(value) {
    return fingerprintCredential(value);
}

/** Timing-safe check against a list of allowed credentials. */
export function matchesClientCredential(candidate, allowedCredentials = []) {
    return matchesAnyCredential(candidate, allowedCredentials);
}

/**
 * Identity registry mapping conversation resources (aliases, upstream chat ids,
 * tombstones) to stable groups with a single current upstream id.
 *
 * `map` returns false when CAS fails: the caller's expected current id does not
 * match what is already registered for the group.
 *
 * @param {{maxResources?: number}} [options]
 */
export function createConversationIdentityRegistry({ maxResources = 10_000 } = {}) {
    if (!Number.isSafeInteger(maxResources) || maxResources < 2) {
        throw new RangeError('maxResources must be an integer greater than one');
    }

    const lockKeyByResource = new Map();
    const resourcesByLockKey = new Map();
    const currentUpstreamByLockKey = new Map();

    function removeResourceFromGroup(resourceId, lockKey) {
        const resources = resourcesByLockKey.get(lockKey);
        if (!resources) return;
        resources.delete(resourceId);
        if (resources.size === 0) resourcesByLockKey.delete(lockKey);
    }

    function registerResource(resourceId, lockKey) {
        if (!resourceId || !lockKey) return;
        const previousLockKey = lockKeyByResource.get(resourceId);
        if (previousLockKey && previousLockKey !== lockKey) {
            removeResourceFromGroup(resourceId, previousLockKey);
        }
        lockKeyByResource.set(resourceId, lockKey);
        let resources = resourcesByLockKey.get(lockKey);
        if (!resources) resources = new Set();
        resources.add(resourceId);
        resourcesByLockKey.delete(lockKey);
        resourcesByLockKey.set(lockKey, resources);
    }

    function mergeLockGroup(sourceLockKey, targetLockKey) {
        if (!sourceLockKey || sourceLockKey === targetLockKey) return;
        const sourceResources = resourcesByLockKey.get(sourceLockKey);
        if (!sourceResources) return;
        for (const resourceId of [...sourceResources]) {
            registerResource(resourceId, targetLockKey);
        }
        resourcesByLockKey.delete(sourceLockKey);
        currentUpstreamByLockKey.delete(sourceLockKey);
    }

    function trim() {
        while (lockKeyByResource.size > maxResources && resourcesByLockKey.size > 0) {
            const [oldestLockKey, resources] = resourcesByLockKey.entries().next().value;
            resourcesByLockKey.delete(oldestLockKey);
            currentUpstreamByLockKey.delete(oldestLockKey);
            for (const resourceId of resources) {
                if (lockKeyByResource.get(resourceId) === oldestLockKey) {
                    lockKeyByResource.delete(resourceId);
                }
            }
        }
    }

    return Object.freeze({
        /**
         * Registers alias→upstream binding within a conversation group.
         * @returns {boolean} false when CAS comparison fails
         */
        map(aliasValue, upstreamValue, { compareCurrent = false, expectedCurrent = null } = {}) {
            const alias = normalizeId(aliasValue);
            const upstreamId = normalizeId(upstreamValue);
            if (!alias || !upstreamId) return false;

            const aliasLockKey = lockKeyByResource.get(alias);
            const currentUpstreamId = aliasLockKey
                ? currentUpstreamByLockKey.get(aliasLockKey) || null
                : null;
            const normalizedExpected = normalizeId(expectedCurrent);
            if (compareCurrent && currentUpstreamId !== normalizedExpected) return false;

            // A known upstream/tombstone already belongs to a conversation
            // group. Its current target wins, so stale ids cannot move the
            // conversation backwards or create a one-hop alias chain.
            const upstreamLockKey = lockKeyByResource.get(upstreamId);
            const canonicalUpstreamId = upstreamLockKey
                ? currentUpstreamByLockKey.get(upstreamLockKey) || upstreamId
                : upstreamId;
            const stableLockKey = upstreamLockKey || aliasLockKey || alias;

            mergeLockGroup(aliasLockKey, stableLockKey);
            registerResource(alias, stableLockKey);
            registerResource(upstreamId, stableLockKey);
            registerResource(canonicalUpstreamId, stableLockKey);
            currentUpstreamByLockKey.set(stableLockKey, canonicalUpstreamId);
            trim();
            return true;
        },

        /** Resolves a resource to its current upstream id (or null). */
        resolve(resourceValue) {
            const resourceId = normalizeId(resourceValue);
            if (!resourceId) return null;
            const lockKey = lockKeyByResource.get(resourceId);
            return lockKey ? currentUpstreamByLockKey.get(lockKey) || null : null;
        },

        has(resourceValue) {
            const resourceId = normalizeId(resourceValue);
            return resourceId ? lockKeyByResource.has(resourceId) : false;
        },

        /** Returns the stable group key (most recently used first). */
        lockKey(resourceValue) {
            const resourceId = normalizeId(resourceValue);
            if (!resourceId) return null;
            const stableLockKey = lockKeyByResource.get(resourceId);
            if (!stableLockKey) return resourceId;
            const resources = resourcesByLockKey.get(stableLockKey);
            if (resources) {
                resourcesByLockKey.delete(stableLockKey);
                resourcesByLockKey.set(stableLockKey, resources);
            }
            return stableLockKey;
        },

        /** Tests only: clears all state. */
        clear() {
            lockKeyByResource.clear();
            resourcesByLockKey.clear();
            currentUpstreamByLockKey.clear();
        },

        get resourceCount() {
            return lockKeyByResource.size;
        }
    });
}
