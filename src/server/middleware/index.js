// HTTP layer middleware.

import { logError, logWarn } from '../../shared/logger.js';
import { getApiKeys } from '../../core/apiKeys.js';
import { AppError } from '../../shared/errors.js';
import { isOriginAllowed, normalizeOrigin } from '../../shared/originPolicy.js';
import { matchesAnyCredential, fingerprintCredential } from '../../shared/security.js';
import { createClientScope } from '../../core/conversations/identity.js';

/** Proxy access key check. Empty key list disables check. */
export function apiKeyAuth(req, res, next) {
    const keys = getApiKeys();
    if (keys.length === 0) return next();

    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        logWarn('Request without authorization header');
        return res.status(401).json({ error: 'Authorization required' });
    }

    const token = header.slice(7).trim();

    // Timing-safe: response time doesn't depend on which byte mismatched.
    if (!matchesAnyCredential(token, keys)) {
        logWarn(`Invalid key provided (fingerprint: ${fingerprintCredential(token)})`);
        return res.status(401).json({ error: 'Invalid token' });
    }

    return next();
}

/**
 * Removes version from path: /api/v1/chat/completions → /api/chat/completions.
 * OpenAI SDK clients hardcode /v1, so we handle both variants.
 */
export function stripVersionPrefix(req, res, next) {
    req.url = req.url.replace(/\/v[12](?=\/|$)/g, '').replace(/\/+/g, '/');
    next();
}

/**
 * CORS: allows requests from loopback origins and explicitly listed in ALLOWED_ORIGINS.
 * Non-browser clients (curl, SDK) don't send Origin and always pass.
 */
export function cors(req, res, next) {
    const origin = req.get('origin');

    if (origin && !isOriginAllowed(origin)) {
        logWarn(`Request from disallowed origin: ${normalizeOrigin(origin)}`);
        return res.status(403).json({ error: 'Origin not allowed' });
    }

    // Allow specific origin (or * for non-browser).
    res.header('Access-Control-Allow-Origin', origin ? normalizeOrigin(origin) : '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Vary', 'Origin');

    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
}

/**
 * Account management contains Qwen tokens, so available only from
 * localhost: HOST=0.0.0.0 listens all interfaces, including local network.
 */
export function localOnly(req, res, next) {
    const ip = req.socket?.remoteAddress || '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
    logWarn(`Rejected non-local access to account management from ${ip}`);
    return res.status(403).json({ error: 'Account management available only from localhost' });
}

/**
 * CSRF protection: ACAO:* header allows cross-origin requests, so
 * mutating calls accepted only from own origin.
 */
export function sameOriginOnly(req, res, next) {
    const origin = req.get('origin');
    if (!origin) return next();

    // Allow loopback and explicitly allowed origins.
    if (isOriginAllowed(origin)) return next();

    logWarn(`CSRF protection: rejected mutating request from ${normalizeOrigin(origin)}`);
    return res.status(403).json({ error: 'Cross-origin mutating requests not allowed' });
}

/**
 * Error handler: converts AppError to appropriate HTTP response.
 */
export function errorHandler(err, req, res, _next) {
    if (err instanceof AppError) {
        logWarn(`Request error: ${err.message} (${err.code})`);
        return res.status(err.status).json(err.toJSON());
    }

    logError('Unhandled error', err);
    return res.status(500).json({
        error: {
            message: 'Internal server error',
            type: 'internal_error'
        }
    });
}

/**
 * Handles malformed JSON request bodies rejected by body-parser.
 */
export function jsonSyntaxErrorHandler(err, req, res, next) {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        logWarn('Invalid JSON payload');
        return res.status(400).json({
            error: {
                message: 'Invalid JSON payload',
                type: 'invalid_request_error'
            }
        });
    }
    return next(err);
}

/**
 * Terminal handler for unmatched routes.
 */
export function notFoundHandler(req, res) {
    return res.status(404).json({
        error: {
            message: 'Not found',
            type: 'invalid_request_error'
        }
    });
}

/**
 * Builds a stable client key from request metadata.
 * Used to bind conversations to a client when no explicit ID is supplied.
 *
 * The key is a scoped hash of IP + User-Agent + API-key fingerprint, so two
 * clients sharing an address (or a key) still get deterministic, isolated
 * aliases — preventing cross-client chat collisions.
 */
export function clientKey(req) {
    const ip = req.socket?.remoteAddress || '';
    const userAgent = req.get('user-agent') || '';

    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const credentialFingerprint = token ? fingerprintCredential(token) : null;

    return createClientScope({ ip, userAgent, credentialFingerprint });
}