import { describe, it, expect } from 'vitest';

import { extractToolCalls, parseJsonLoose } from '../../src/core/tools/parser.js';

describe('parseJsonLoose', () => {
    it('parses valid JSON', () => {
        expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    });

    it('repairs missing closing brackets', () => {
        expect(parseJsonLoose('{"tool_calls":[{"name":"x","arguments":{"a":1}')).toEqual({
            tool_calls: [{ name: 'x', arguments: { a: 1 } }]
        });
    });

    it('repairs the known Qwen bug with an extra array close', () => {
        const broken = '{"tool_calls":[{"name":"read_file","arguments":{"path":"a.js"}]}';
        expect(parseJsonLoose(broken)).toEqual({
            tool_calls: [{ name: 'read_file', arguments: { path: 'a.js' } }]
        });
    });

    it('removes trailing commas', () => {
        expect(parseJsonLoose('{"a":1,}')).toEqual({ a: 1 });
    });

    it('returns undefined for non-JSON', () => {
        expect(parseJsonLoose('just plain text')).toBeUndefined();
    });
});

describe('extractToolCalls', () => {
    it('reads the standard Qwen <tool_call> format', () => {
        const result = extractToolCalls('<tool_call>\n{"name": "read_file", "arguments": {"path": "src/a.js"}}\n</tool_call>');
        expect(result.calls).toEqual([{ id: null, name: 'read_file', arguments: { path: 'src/a.js' } }]);
    });

    it('reads multiple consecutive calls', () => {
        const content = [
            '<tool_call>{"name":"a","arguments":{}}</tool_call>',
            '<tool_call>{"name":"b","arguments":{"x":1}}</tool_call>'
        ].join('\n');
        const result = extractToolCalls(content);
        expect(result.calls.map(call => call.name)).toEqual(['a', 'b']);
    });

    it('preserves prose before the call as content', () => {
        const result = extractToolCalls('I will read the file now.\n<tool_call><tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>');
        expect(result.text).toBe('I will read the file now.');
        expect(result.calls).toHaveLength(1);
    });

    it('reads a call from a markdown fence', () => {
        const result = extractToolCalls('```json\n{"name":"terminal","arguments":{"command":"pwd"}}\n```');
        expect(result.calls[0]).toMatchObject({ name: 'terminal' });
    });

    it('reads the {"tool_calls": [...]} format', () => {
        const result = extractToolCalls('{"tool_calls":[{"name":"web_search","arguments":{"q":"qwen"}}]}');
        expect(result.calls[0]).toMatchObject({ name: 'web_search', arguments: { q: 'qwen' } });
    });

    it('reads a bare name/arguments object', () => {
        const result = extractToolCalls('{"name":"todo","arguments":{"items":[]}}');
        expect(result.calls[0]).toMatchObject({ name: 'todo' });
    });

    it('reads an unclosed tag in a truncated response', () => {
        const result = extractToolCalls('<tool_call>{"name":"a","arguments":{"x":1}}');
        expect(result.calls[0]).toMatchObject({ name: 'a', arguments: { x: 1 } });
    });

    it('returns null for plain text', () => {
        expect(extractToolCalls('Hello, how can I help?')).toBeNull();
    });

    it('does not treat arbitrary JSON without a name as a call', () => {
        expect(extractToolCalls('{"result": 42}')).toBeNull();
    });
});
