import { afterEach, describe, it, expect } from 'vitest';

import {
    createClientScope,
    createConversationIdentityRegistry,
    createScopedConversationAlias,
    fingerprintClientCredential,
    matchesClientCredential
} from '../../src/core/conversations/identity.js';

describe('createClientScope', () => {
    it('is deterministic for the same inputs', () => {
        expect(createClientScope({ ip: '1.1.1.1', userAgent: 'UA', credentialFingerprint: 'fp' }))
            .toBe(createClientScope({ ip: '1.1.1.1', userAgent: 'UA', credentialFingerprint: 'fp' }));
    });

    it('differs across IP, user-agent or credential', () => {
        const base = { ip: '1.1.1.1', userAgent: 'UA', credentialFingerprint: 'fp' };
        expect(createClientScope(base)).not.toBe(createClientScope({ ...base, ip: '2.2.2.2' }));
        expect(createClientScope(base)).not.toBe(createClientScope({ ...base, userAgent: 'UA2' }));
        expect(createClientScope(base)).not.toBe(createClientScope({ ...base, credentialFingerprint: 'fp2' }));
    });

    it('handles missing inputs', () => {
        expect(createClientScope({})).toBe(createClientScope({ ip: '', userAgent: '' }));
    });
});

describe('createScopedConversationAlias', () => {
    it('produces a chat_ alias deterministically', () => {
        expect(createScopedConversationAlias('conv-1', 'scope-a'))
            .toBe(createScopedConversationAlias('conv-1', 'scope-a'));
        expect(createScopedConversationAlias('conv-1', 'scope-a')).toMatch(/^chat_[0-9a-f]{16}$/);
    });

    it('isolates clients with the same conversation id', () => {
        expect(createScopedConversationAlias('conv-1', 'scope-a'))
            .not.toBe(createScopedConversationAlias('conv-1', 'scope-b'));
    });

    it('returns null on empty input', () => {
        expect(createScopedConversationAlias('', 'scope-a')).toBeNull();
        expect(createScopedConversationAlias('conv-1', '')).toBeNull();
    });
});

describe('credential helpers', () => {
    it('fingerprints a credential deterministically', () => {
        expect(fingerprintClientCredential('key-1')).toBe(fingerprintClientCredential('key-1'));
        expect(fingerprintClientCredential('key-1')).not.toBe(fingerprintClientCredential('key-2'));
    });

    it('matches against a list of allowed credentials', () => {
        expect(matchesClientCredential('key-1', ['key-1', 'key-2'])).toBe(true);
        expect(matchesClientCredential('key-x', ['key-1', 'key-2'])).toBe(false);
        expect(matchesClientCredential('key-1', [])).toBe(false);
    });
});

describe('createConversationIdentityRegistry', () => {
    afterEach(() => {
        // registry instances are isolated per test; nothing to clear
    });

    it('rejects invalid maxResources', () => {
        expect(() => createConversationIdentityRegistry({ maxResources: 1 })).toThrow(RangeError);
        expect(() => createConversationIdentityRegistry({ maxResources: 1.5 })).toThrow(RangeError);
    });

    it('maps alias to upstream and resolves it', () => {
        const registry = createConversationIdentityRegistry();
        expect(registry.map('chat_abc', 'qwen-1')).toBe(true);
        expect(registry.resolve('chat_abc')).toBe('qwen-1');
        expect(registry.has('chat_abc')).toBe(true);
        expect(registry.has('qwen-1')).toBe(true);
    });

    it('keeps the canonical upstream when an alias chain is mapped', () => {
        const registry = createConversationIdentityRegistry();
        registry.map('chat_a', 'qwen-1');
        registry.map('chat_b', 'chat_a');
        expect(registry.resolve('chat_a')).toBe('qwen-1');
        expect(registry.resolve('chat_b')).toBe('qwen-1');
    });

    it('a stale id cannot move the conversation backwards', () => {
        const registry = createConversationIdentityRegistry();
        registry.map('chat_a', 'qwen-1');
        registry.map('chat_a', 'qwen-2');
        expect(registry.resolve('chat_a')).toBe('qwen-2');

        // Re-mapping with an old expectedCurrent fails CAS.
        expect(registry.map('chat_a', 'qwen-2', { compareCurrent: true, expectedCurrent: 'qwen-9' })).toBe(false);
        expect(registry.resolve('chat_a')).toBe('qwen-2');
    });

    it('clear() empties state', () => {
        const registry = createConversationIdentityRegistry();
        registry.map('chat_a', 'qwen-1');
        registry.clear();
        expect(registry.resolve('chat_a')).toBeNull();
        expect(registry.has('chat_a')).toBe(false);
        expect(registry.resourceCount).toBe(0);
    });

    it('tracks resource count', () => {
        const registry = createConversationIdentityRegistry();
        registry.map('chat_a', 'qwen-1');
        registry.map('chat_b', 'qwen-1');
        expect(registry.resourceCount).toBe(3); // aliases + upstream id
    });
});
