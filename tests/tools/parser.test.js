import { describe, it, expect } from 'vitest';

import { extractToolCalls, parseJsonLoose } from '../../src/core/tools/parser.js';

describe('parseJsonLoose', () => {
    it('разбирает корректный JSON', () => {
        expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    });

    it('чинит потерянные закрывающие скобки', () => {
        expect(parseJsonLoose('{"tool_calls":[{"name":"x","arguments":{"a":1}')).toEqual({
            tool_calls: [{ name: 'x', arguments: { a: 1 } }]
        });
    });

    it('чинит известную поломку Qwen с лишним закрытием массива', () => {
        const broken = '{"tool_calls":[{"name":"read_file","arguments":{"path":"a.js"}]}';
        expect(parseJsonLoose(broken)).toEqual({
            tool_calls: [{ name: 'read_file', arguments: { path: 'a.js' } }]
        });
    });

    it('убирает висящие запятые', () => {
        expect(parseJsonLoose('{"a":1,}')).toEqual({ a: 1 });
    });

    it('возвращает undefined на не-JSON', () => {
        expect(parseJsonLoose('просто текст')).toBeUndefined();
    });
});

describe('extractToolCalls', () => {
    it('читает штатный формат Qwen <tool_call>', () => {
        const result = extractToolCalls('<tool_call>\n{"name": "read_file", "arguments": {"path": "src/a.js"}}\n</tool_call>');
        expect(result.calls).toEqual([{ id: null, name: 'read_file', arguments: { path: 'src/a.js' } }]);
    });

    it('читает несколько вызовов подряд', () => {
        const content = [
            '<tool_call>{"name":"a","arguments":{}}</tool_call>',
            '<tool_call>{"name":"b","arguments":{"x":1}}</tool_call>'
        ].join('\n');
        const result = extractToolCalls(content);
        expect(result.calls.map(call => call.name)).toEqual(['a', 'b']);
    });

    it('сохраняет прозу до вызова как content', () => {
        const result = extractToolCalls('Сейчас прочитаю файл.\n<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>');
        expect(result.text).toBe('Сейчас прочитаю файл.');
        expect(result.calls).toHaveLength(1);
    });

    it('читает вызов из markdown-фенса', () => {
        const result = extractToolCalls('```json\n{"name":"terminal","arguments":{"command":"pwd"}}\n```');
        expect(result.calls[0]).toMatchObject({ name: 'terminal' });
    });

    it('читает формат {"tool_calls": [...]}', () => {
        const result = extractToolCalls('{"tool_calls":[{"name":"web_search","arguments":{"q":"qwen"}}]}');
        expect(result.calls[0]).toMatchObject({ name: 'web_search', arguments: { q: 'qwen' } });
    });

    it('читает голый объект name/arguments', () => {
        const result = extractToolCalls('{"name":"todo","arguments":{"items":[]}}');
        expect(result.calls[0]).toMatchObject({ name: 'todo' });
    });

    it('читает незакрытый тег в оборванном ответе', () => {
        const result = extractToolCalls('<tool_call>{"name":"a","arguments":{"x":1}}');
        expect(result.calls[0]).toMatchObject({ name: 'a', arguments: { x: 1 } });
    });

    it('возвращает null для обычного текста', () => {
        expect(extractToolCalls('Привет, чем помочь?')).toBeNull();
    });

    it('не считает вызовом произвольный JSON без имени', () => {
        expect(extractToolCalls('{"result": 42}')).toBeNull();
    });
});
