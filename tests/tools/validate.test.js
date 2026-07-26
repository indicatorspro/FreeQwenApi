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
    it('приводит вызов к формату OpenAI', () => {
        const { calls, problems } = validateToolCalls([{ name: 'mcp__fs__read_file', arguments: { path: 'a.js' } }], registry);
        expect(problems).toHaveLength(0);
        expect(calls[0]).toMatchObject({
            type: 'function',
            index: 0,
            function: { name: 'mcp__fs__read_file', arguments: '{"path":"a.js"}' }
        });
        expect(calls[0].id).toMatch(/^call_/);
    });

    it('восстанавливает полное имя, если модель ответила коротким', () => {
        const { calls } = validateToolCalls([{ name: 'read_file', arguments: { path: 'a' } }], registry);
        expect(calls[0].function.name).toBe('mcp__fs__read_file');
    });

    it('разбирает аргументы, пришедшие строкой', () => {
        const { calls } = validateToolCalls([{ name: 'read_file', arguments: '{"path":"a"}' }], registry);
        expect(JSON.parse(calls[0].function.arguments)).toEqual({ path: 'a' });
    });

    it('приводит типы к схеме', () => {
        const { calls } = validateToolCalls([
            { name: 'read_file', arguments: { path: 'a', limit: '10', recursive: 'true' } }
        ], registry);
        expect(JSON.parse(calls[0].function.arguments)).toEqual({ path: 'a', limit: 10, recursive: true });
    });

    it('оборачивает одиночное значение в массив по схеме', () => {
        const { calls } = validateToolCalls([{ name: 'search', arguments: { queries: 'qwen' } }], registry);
        expect(JSON.parse(calls[0].function.arguments)).toEqual({ queries: ['qwen'] });
    });

    it('принимает голую строку как единственный обязательный аргумент', () => {
        const { calls } = validateToolCalls([{ name: 'read_file', arguments: 'src/index.js' }], registry);
        expect(JSON.parse(calls[0].function.arguments)).toEqual({ path: 'src/index.js' });
    });

    it('сообщает о неизвестной функции', () => {
        const { calls, problems } = validateToolCalls([{ name: 'ghost', arguments: {} }], registry);
        expect(calls).toHaveLength(0);
        expect(problems[0].reason).toContain('не объявлена');
    });

    it('сообщает об отсутствии обязательного аргумента', () => {
        const { calls, problems } = validateToolCalls([{ name: 'read_file', arguments: { limit: 1 } }], registry);
        expect(calls).toHaveLength(0);
        expect(problems[0].reason).toContain('path');
    });

    it('нумерует несколько вызовов подряд', () => {
        const { calls } = validateToolCalls([
            { name: 'read_file', arguments: { path: 'a' } },
            { name: 'read_file', arguments: { path: 'b' } }
        ], registry);
        expect(calls.map(call => call.index)).toEqual([0, 1]);
    });
});
