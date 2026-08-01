// Origin policy for CORS and CSRF protection.
//
// By default all loopback origins are allowed (localhost, 127.0.0.1, ::1),
// covering local clients (Open WebUI, LM Studio, agents).
// Additional origins can be set via ALLOWED_ORIGINS (comma-separated).
//
// Source: FreeQwenApi_ForgetMeAI (originPolicy.js) + improvements.

import { config } from '../config/index.js';

/** Normalizes origin to `scheme://host[:port]` format. */
export function normalizeOrigin(origin) {
    const value = String(origin || '').trim().replace(/\/+$/, '');
    if (!value) return '';
    try {
        const parsed = new URL(value);
        return parsed.origin === 'null' ? value : parsed.origin;
    } catch {
        return value;
    }
}

/** Checks if hostname is a loopback address. */
export function isLoopbackHostname(hostname) {
    const normalized = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    return normalized === 'localhost'
        || normalized === '127.0.0.1'
        || normalized === '::1'
        || normalized === '::ffff:127.0.0.1';
}

/** Parses allowed origins list from string (comma-separated). */
export function parseAllowedOrigins(value) {
    return new Set(String(value || '')
        .split(',')
        .map(normalizeOrigin)
        .filter(Boolean));
}

// Cache of allowed origins from configuration.
let configuredOrigins = null;

function getConfiguredOrigins() {
    if (!configuredOrigins) {
        configuredOrigins = parseAllowedOrigins(config.server.allowedOrigins || '');
    }
    return configuredOrigins;
}

/**
 * Determines if origin is allowed for browser requests.
 * Allowed: loopback, explicitly listed in ALLOWED_ORIGINS, browser extensions.
 * @param {string|undefined} origin
 * @returns {boolean}
 */
export function isOriginAllowed(origin) {
    if (!origin) return true; // Non-browser requests (curl, SDK) don't send Origin.

    const normalized = normalizeOrigin(origin);

    // Browser extensions are trusted.
    if (/^(chrome-extension|moz-extension|safari-web-extension):\/\//i.test(normalized)) {
        return true;
    }

    // Explicitly allowed origins.
    if (getConfiguredOrigins().has(normalized)) return true;

    // Loopback by default.
    try {
        const parsed = new URL(normalized);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
            && isLoopbackHostname(parsed.hostname);
    } catch {
        return false;
    }
}
