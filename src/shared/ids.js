// Identifier utilities: UUID, hashes, timestamps.

import crypto from 'crypto';

/** Standard UUID v4. */
export function uuid() {
    return crypto.randomUUID();
}

/** Random hex string of specified length. */
export function randomHex(length = 16) {
    return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

/** Short hash for logging (first 8 chars of SHA-256). */
export function shortHash(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
}

/** Normalizes ID: trims, returns null if empty. */
export function normalizeId(value) {
    if (value === null || value === undefined) return null;
    const normalized = String(value).trim();
    return normalized || null;
}

/** Unix time in seconds — OpenAI `created` field format. */
export function unixSeconds() {
    return Math.floor(Date.now() / 1000);
}

/**
 * Builds X-Request-Id for Qwen requests.
 * Format: r-<timestamp>-<random> (as in original FreeQwenApi).
 */
export function buildRequestId() {
    return `r-${Date.now()}-${randomHex(6)}`;
}

/**
 * Returns the first non-empty, non-"null" string from a list of candidates.
 * Used to extract conversation/parent IDs from various client fields.
 */
export function pickFirstId(candidates) {
    for (const value of candidates) {
        const normalized = normalizeId(value);
        if (normalized && normalized.toLowerCase() !== 'null') return normalized;
    }
    return null;
}

/** Generates a unique tool call ID in OpenAI format: call_<hex>. */
export function toolCallId() {
    return `call_${randomHex(24)}`;
}

/** Generates a completion ID in OpenAI format: chatcmpl-<hex>. */
export function completionId() {
    return `chatcmpl-${randomHex(24)}`;
}
