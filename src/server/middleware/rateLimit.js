// Proxy-side rate limiting middleware.
//
// Lightweight in-memory sliding-window limiter keyed by IP + API key (when
// present). Disabled by default — OpenWebUI fires parallel title-gen and
// message requests, so the default window must be generous. Prevents a single
// client from exhausting all Qwen accounts.

import { config } from '../../config/index.js';
import { logWarn } from '../../shared/logger.js';

/** Sliding-window counter. Keeps a timestamps array per key. */
export function createRateLimiter({ windowMs, max }) {
    const hits = new Map();

    return Object.freeze({
        /**
         * Checks and records a request.
         * @returns {{allowed: boolean, remaining: number, retryAfterMs: number}}
         */
        check(key) {
            const now = Date.now();
            const cutoff = now - windowMs;

            const timestamps = hits.get(key) || [];
            const alive = timestamps.filter(ts => ts > cutoff);

            if (alive.length >= max) {
                // The oldest surviving hit expires at oldest + windowMs.
                const oldest = Math.min(...alive);
                hits.set(key, alive);
                return { allowed: false, remaining: 0, retryAfterMs: oldest + windowMs - now };
            }

            alive.push(now);
            hits.set(key, alive);
            const remaining = max - alive.length;

            // Opportunistic cleanup to avoid unbounded growth.
            if (hits.size > 10_000) {
                for (const [mapKey, stamps] of hits) {
                    if (stamps.every(ts => ts <= cutoff)) hits.delete(mapKey);
                }
            }

            return { allowed: true, remaining, retryAfterMs: 0 };
        },

        get size() {
            return hits.size;
        },

        clear() {
            hits.clear();
        }
    });
}

/** Creates the rate-limit middleware wired to config. */
export function createRateLimitMiddleware() {
    const limiter = createRateLimiter({
        windowMs: config.server.rateLimitWindowMs,
        max: config.server.rateLimitMax
    });

    return function rateLimit(req, res, next) {
        if (!config.server.rateLimitEnabled) return next();

        const ip = req.socket?.remoteAddress || 'unknown';
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
        const key = token ? `${ip}|${token}` : ip;

        const result = limiter.check(key);
        if (!result.allowed) {
            res.setHeader('Retry-After', Math.ceil(result.retryAfterMs / 1000));
            logWarn(`Rate limit exceeded for ${ip}`);
            return res.status(429).json({
                error: {
                    message: 'Too many requests. Try again later.',
                    type: 'rate_limit_error'
                }
            });
        }

        res.setHeader('X-RateLimit-Limit', String(config.server.rateLimitMax));
        res.setHeader('X-RateLimit-Remaining', String(result.remaining));
        return next();
    };
}
