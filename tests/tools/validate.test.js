import { describe, it, expect } from 'vitest';

import { buildToolRegistry } from '../../src/core/tools/registry.js';
import { validateToolCalls } from '../../src/core/tools/validate.js';

const registry = buildToolRegistry([
    {
        function: {
            name: 'mcp__fs__read_file',
            parameters: {
                type: 'object',
                properties: { path: { type: 'string' }, limit: { type: 'integer' }, recursive: { type: 'boolean' } },
                required: ['path']
            }
        }
    },
    {
        function: {
            name: 'search',
            parameters: { type: 'object', properties: { queries: { type: 'array', items: { type: 'string' } } } }
        }
    }
], null);

describe('validateToolCalls', () => {
    it('converts a call to the OpenAI format', () => {
        const { calls, problems } = validateToolCalls([{ name: 'mcp__fs__read_file', arguments: { path: 'a.js' } }], registry);
        expect(problems).toHaveLength(0);
        expect(calls[0]).toMatchObject({
            type: 'function',
            index: 0,
            function: { name: 'mcp__fs__read_file', arguments: '{"path":"a.js"}' }
        });
        expect(calls[0].id).toMatch(/^call_/);
    });

    it('restores the full name if the model replied with a short one', () => {
        const { calls } = validateToolCalls([{ name: 'read_file', arguments: { path: 'a' } }], registry);
        expect(calls[0].function.name).toBe('mcp__fs__read_file');
    });

    it('parses arguments that arrived as a string', () => {
        const { calls } = validateToolCalls([{ name: 'read_file', arguments: '{"path":"a"}' }], registry);
        expect(JSON.parse(calls[0].function.arguments)).toEqual({ path: 'a' });
    });

    it('coerces types to match the schema', () => {
        const { calls } = validateToolCalls([
            { name: 'read_file', arguments: { path: 'a', limit: '10', recursive: 'true' } }
        ], registry);
        expect(JSON.parse(calls[0].function.arguments)).toEqual({ path: 'a', limit: 10, recursive: true });
    });

    it('wraps a single value in an array per the schema', () => {
        const { calls } = validateToolCalls([{ name: 'search', arguments: { queries: 'qwen' } }], registry);
        expect(JSON.parse(calls[0].function.arguments)).toEqual({ queries: ['qwen'] });
    });

    it('accepts a bare string as the only required argument', () => {
        const { calls } = validateToolCalls([{ name: 'read_file', arguments: 'src/index.js' }], registry);
        expect(JSON.parse(calls[0].function.arguments)).toEqual({ path: 'src/index.js' });
    });

    it('reports an unknown function', () => {
        const { calls, problems } = validateToolCalls([{ name: 'ghost', arguments: {} }], registry);
        expect(calls).toHaveLength(0);
        expect(problems[0].reason).toContain('not declared');
    });

    it('reports a missing required argument', () => {
        const { calls, problems } = validateToolCalls([{ name: 'read_file', arguments: { limit: 1 } }], registry);
        expect(calls).toHaveLength(0);
        expect(problems[0].reason).toContain('path');
    });

    it('numbers multiple consecutive calls', () => {
        const { calls } = validateToolCalls([
            { name: 'read_file', arguments: { path: 'a' } },
            { name: 'read_file', arguments: { path: 'b' } }
        ], registry);
        expect(calls.map(call => call.index)).toEqual([0, 1]);
    });
});
