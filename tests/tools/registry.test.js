import { describe, it, expect } from 'vitest';

import { buildToolRegistry, normalizeToolChoice, stripNamespace } from '../../src/core/tools/registry.js';

const tools = [
    { type: 'function', function: { name: 'mcp__github__create_pull_request', description: 'Create a PR', parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } } },
    { type: 'function', function: { name: 'read_file', description: 'Read a file' } }
];

describe('buildToolRegistry', () => {
    it('normalizes the OpenAI-format tools', () => {
        const registry = buildToolRegistry(tools, null);
        expect(registry.size).toBe(2);
        expect(registry.names).toContain('mcp__github__create_pull_request');
    });

    it('accepts the deprecated functions field', () => {
        const registry = buildToolRegistry(null, [{ name: 'legacy_fn', description: 'x' }]);
        expect(registry.names).toEqual(['legacy_fn']);
    });

    it('substitutes an empty schema if parameters are not set', () => {
        const registry = buildToolRegistry(tools, null);
        expect(registry.resolve('read_file').parameters).toEqual({ type: 'object', properties: {} });
    });

    it('removes duplicates by name', () => {
        const registry = buildToolRegistry([...tools, tools[0]], null);
        expect(registry.size).toBe(2);
    });

    it('skips non-function tools', () => {
        const registry = buildToolRegistry([{ type: 'web_search_preview' }, ...tools], null);
        expect(registry.size).toBe(2);
    });

    it('finds a tool by short name without the MCP prefix', () => {
        const registry = buildToolRegistry(tools, null);
        expect(registry.resolve('create_pull_request').name).toBe('mcp__github__create_pull_request');
    });

    it('finds a tool regardless of case and separators', () => {
        const registry = buildToolRegistry(tools, null);
        expect(registry.resolve('Read-File').name).toBe('read_file');
    });

    it('does not guess on an ambiguous short name', () => {
        const registry = buildToolRegistry([
            { function: { name: 'mcp__a__search' } },
            { function: { name: 'mcp__b__search' } }
        ], null);
        expect(registry.resolve('search')).toBeNull();
    });

    it('returns null for an unknown name', () => {
        expect(buildToolRegistry(tools, null).resolve('nope')).toBeNull();
    });
});

describe('stripNamespace', () => {
    it.each([
        ['mcp__github__create_pr', 'create_pr'],
        ['github.create_pr', 'create_pr'],
        ['github/create_pr', 'create_pr'],
        ['plain', 'plain']
    ])('%s -> %s', (input, expected) => {
        expect(stripNamespace(input)).toBe(expected);
    });
});

describe('normalizeToolChoice', () => {
    it.each([
        [undefined, { mode: 'auto', name: null }],
        ['auto', { mode: 'auto', name: null }],
        ['none', { mode: 'none', name: null }],
        ['required', { mode: 'required', name: null }],
        [{ type: 'function', function: { name: 'read_file' } }, { mode: 'required', name: 'read_file' }]
    ])('%o', (input, expected) => {
        expect(normalizeToolChoice(input)).toEqual(expected);
    });
});
