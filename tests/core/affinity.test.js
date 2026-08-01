import { describe, expect, it } from 'vitest';

import {
    buildResourceKey,
    bindResourceToAccount,
    getResourceAccountId,
    collectFileResourceIds,
    resolveFileAccountId,
    createAccountAffinityRegistry
} from '../../src/core/accounts/affinity.js';

describe('buildResourceKey', () => {
    it('namespaces chats by type only', () => {
        expect(buildResourceKey('chat', 'chat-1')).toBe('chat:chat-1');
        expect(buildResourceKey('chat', 'chat-1', 'scope-a')).toBe('chat:chat-1');
    });

    it('scopes files and tasks by client', () => {
        expect(buildResourceKey('file', 'f1', 'scope-a')).toBe('file:scope-a:f1');
        expect(buildResourceKey('file', 'f1', 'scope-b')).toBe('file:scope-b:f1');
        expect(buildResourceKey('task', 't1', 'scope-a')).toBe('task:scope-a:t1');
        expect(buildResourceKey('file', 'f1')).toBe('file:unscoped:f1');
    });

    it('returns null on empty input', () => {
        expect(buildResourceKey('', 'f1')).toBeNull();
        expect(buildResourceKey('file', '')).toBeNull();
    });
});

describe('bindResourceToAccount / getResourceAccountId', () => {
    it('binds and retrieves a resource', () => {
        const registry = createAccountAffinityRegistry();
        expect(bindResourceToAccount(registry, 'file', 'f1', 'acc-1', 'scope-a')).toBe(true);
        expect(getResourceAccountId(registry, 'file', 'f1', 'scope-a')).toBe('acc-1');
    });

    it('isolates the same resource id across scopes', () => {
        const registry = createAccountAffinityRegistry();
        bindResourceToAccount(registry, 'file', 'f1', 'acc-1', 'scope-a');
        bindResourceToAccount(registry, 'file', 'f1', 'acc-2', 'scope-b');
        expect(getResourceAccountId(registry, 'file', 'f1', 'scope-a')).toBe('acc-1');
        expect(getResourceAccountId(registry, 'file', 'f1', 'scope-b')).toBe('acc-2');
    });

    it('rejects a binding to a different account for the same key', () => {
        const registry = createAccountAffinityRegistry();
        bindResourceToAccount(registry, 'chat', 'chat-1', 'acc-1');
        expect(bindResourceToAccount(registry, 'chat', 'chat-1', 'acc-2')).toBe(false);
        expect(getResourceAccountId(registry, 'chat', 'chat-1')).toBe('acc-1');
    });
});

describe('collectFileResourceIds', () => {
    it('extracts ids from mixed shapes', () => {
        const files = [
            { id: 'f1' },
            { file_id: 'f2' },
            'f3',
            { url: 'f4' },
            [{ file_path: 'f5' }]
        ];
        const ids = collectFileResourceIds(files);
        expect(ids).toContain('f1');
        expect(ids).toContain('f2');
        expect(ids).toContain('f3');
        expect(ids).toContain('f4');
        expect(ids).toContain('f5');
    });

    it('ignores garbage and empty arrays', () => {
        expect(collectFileResourceIds([])).toEqual([]);
        expect(collectFileResourceIds([{}, null, { name: 'x' }])).toEqual([]);
        expect(collectFileResourceIds(null)).toEqual([]);
    });
});

describe('resolveFileAccountId', () => {
    it('returns the single owner account of the files', () => {
        const registry = createAccountAffinityRegistry();
        bindResourceToAccount(registry, 'file', 'f1', 'acc-1', 'scope-a');
        bindResourceToAccount(registry, 'file', 'f2', 'acc-1', 'scope-a');

        const result = resolveFileAccountId(registry, [{ id: 'f1' }, { id: 'f2' }], 'scope-a');
        expect(result.accountId).toBe('acc-1');
        expect(result.hasFiles).toBe(true);
        expect(result.hasKnownOwner).toBe(true);
        expect(result.error).toBeUndefined();
    });

    it('reports files belonging to different accounts', () => {
        const registry = createAccountAffinityRegistry();
        bindResourceToAccount(registry, 'file', 'f1', 'acc-1', 'scope-a');
        bindResourceToAccount(registry, 'file', 'f2', 'acc-2', 'scope-a');

        const result = resolveFileAccountId(registry, [{ id: 'f1' }, { id: 'f2' }], 'scope-a');
        expect(result.error).toBeTruthy();
        expect(result.hasKnownOwner).toBe(false);
    });

    it('reports unknown owner for files without a binding', () => {
        const registry = createAccountAffinityRegistry();
        const result = resolveFileAccountId(registry, [{ id: 'new-file' }], 'scope-a');
        expect(result.accountId).toBeNull();
        expect(result.hasFiles).toBe(true);
        expect(result.hasKnownOwner).toBe(false);
    });
});

describe('createAccountAffinityRegistry dump/restore', () => {
    it('dump returns all bindings as [resourceId, accountId] pairs', () => {
        const registry = createAccountAffinityRegistry();
        registry.bind('chat:chat-1', 'acc-1');
        registry.bind('file:scope-a:f1', 'acc-2');
        expect(registry.dump()).toEqual([
            ['chat:chat-1', 'acc-1'],
            ['file:scope-a:f1', 'acc-2']
        ]);
    });

    it('restore replaces bindings and skips invalid entries', () => {
        const registry = createAccountAffinityRegistry();
        registry.bind('chat:chat-1', 'acc-1');
        registry.restore([
            ['chat:chat-2', 'acc-2'],
            ['file:scope-a:f1', 'acc-3'],
            ['', 'acc-4'],
            ['chat:empty', '']
        ]);
        expect(registry.get('chat:chat-1')).toBeNull();
        expect(registry.get('chat:chat-2')).toBe('acc-2');
        expect(registry.get('file:scope-a:f1')).toBe('acc-3');
        expect(registry.size).toBe(2);
    });

    it('restore ignores non-array input', () => {
        const registry = createAccountAffinityRegistry();
        registry.bind('chat:chat-1', 'acc-1');
        registry.restore(null);
        registry.restore('nope');
        expect(registry.get('chat:chat-1')).toBe('acc-1');
    });

    it('round-trips through dump then restore', () => {
        const registry = createAccountAffinityRegistry();
        registry.bind('chat:chat-1', 'acc-1');
        registry.bind('task:scope-a:t1', 'acc-2');

        const fresh = createAccountAffinityRegistry();
        fresh.restore(registry.dump());
        expect(fresh.get('chat:chat-1')).toBe('acc-1');
        expect(fresh.get('task:scope-a:t1')).toBe('acc-2');
    });
});
