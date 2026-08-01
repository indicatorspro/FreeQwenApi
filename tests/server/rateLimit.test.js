import { describe, expect, it, vi, afterEach } from 'vitest';

import { createRateLimiter } from '../../src/server/middleware/rateLimit.js';

describe('createRateLimiter', () => {
    afterEach(() => vi.restoreAllMocks());

    it('allows requests under the limit', () => {
        const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });
        expect(limiter.check('k1').allowed).toBe(true);
        expect(limiter.check('k1').allowed).toBe(true);
        expect(limiter.check('k1').allowed).toBe(true);
    });

    it('rejects the burst beyond the limit', () => {
        const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
        limiter.check('k1');
        limiter.check('k1');
        const third = limiter.check('k1');
        expect(third.allowed).toBe(false);
        expect(third.remaining).toBe(0);
        expect(third.retryAfterMs).toBeGreaterThan(0);
    });

    it('tracks keys independently', () => {
        const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
        expect(limiter.check('a').allowed).toBe(true);
        expect(limiter.check('a').allowed).toBe(false);
        expect(limiter.check('b').allowed).toBe(true);
    });

    it('reports remaining quota', () => {
        const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });
        expect(limiter.check('k').remaining).toBe(4);
        expect(limiter.check('k').remaining).toBe(3);
    });

    it('expires entries after the window passes', () => {
        const limiter = createRateLimiter({ windowMs: 10, max: 1 });
        expect(limiter.check('k').allowed).toBe(true);
        expect(limiter.check('k').allowed).toBe(false);
        vi.useFakeTimers();
        vi.advanceTimersByTime(20);
        expect(limiter.check('k').allowed).toBe(true);
        vi.useRealTimers();
    });

    it('clear() empties state', () => {
        const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
        limiter.check('k');
        limiter.clear();
        expect(limiter.size).toBe(0);
        expect(limiter.check('k').allowed).toBe(true);
    });
});
