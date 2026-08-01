// Security utilities: hashing, timing-safe comparison.
//
// timingSafeEqual prevents timing attacks when checking API keys:
// regular === returns result faster for mismatch in first bytes,
// allowing attacker to guess key byte by byte.
//
// Source: FreeQwenApi_ForgetMeAI (keyedQueue.js).

import crypto from 'crypto';

/**
 * Compares two strings without timing information leakage.
 * @param {string} candidate — value being checked
 * @param {string} expected — reference value
 * @returns {boolean}
 */
export function timingSafeCompare(candidate, expected) {
    const candidateBuffer = Buffer.from(String(candidate || ''));
    const expectedBuffer = Buffer.from(String(expected || ''));

    if (candidateBuffer.length !== expectedBuffer.length) {
        // Compare with itself to keep timing uniform.
        crypto.timingSafeEqual(candidateBuffer, candidateBuffer);
        return false;
    }

    return crypto.timingSafeEqual(candidateBuffer, expectedBuffer);
}

/**
 * Checks if candidate matches any of allowed values.
 * Always iterates full list (no early exit) for uniform timing.
 * @param {string} candidate
 * @param {string[]} allowedValues
 * @returns {boolean}
 */
export function matchesAnyCredential(candidate, allowedValues = []) {
    if (!candidate || !Array.isArray(allowedValues)) return false;

    let matched = false;
    for (const allowed of allowedValues) {
        if (!allowed) continue;
        // Don't use early return — timing must not depend on position.
        matched = timingSafeCompare(candidate, allowed) || matched;
    }
    return matched;
}

/**
 * Creates SHA-256 fingerprint of value (for logging without exposing secret).
 * @param {string} value
 * @returns {string|null} hex hash or null
 */
export function fingerprintCredential(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return null;
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Creates deterministic hash for session/scope key.
 * @param {string} value
 * @param {string} namespace
 * @returns {string|null}
 */
export function scopedHash(value, namespace = 'default') {
    const normalized = String(value || '').trim();
    if (!normalized) return null;
    return crypto
        .createHash('sha256')
        .update(`${namespace}:${normalized}`)
        .digest('hex')
        .slice(0, 16);
}
