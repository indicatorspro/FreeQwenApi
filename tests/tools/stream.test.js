import { describe, it, expect } from 'vitest';

import { ToolCallStreamFilter } from '../../src/core/tools/stream.js';

function feed(filter, chunks) {
    return chunks.map(chunk => filter.push(chunk)).join('');
}

describe('ToolCallStreamFilter', () => {
    it('пропускает обычный текст без задержки', () => {
        const filter = new ToolCallStreamFilter();
        const emitted = feed(filter, ['Привет', ', ', 'как дела?']);
        expect(emitted).toBe('Привет, как дела?');
        expect(filter.finish().toolCalls).toBeNull();
    });

    it('не отдаёт клиенту служебный JSON вызова', () => {
        const filter = new ToolCallStreamFilter();
        const emitted = feed(filter, ['<tool_call>', '{"name":"read_file",', '"arguments":{"path":"a"}}', '</tool_call>']);
        expect(emitted).toBe('');

        const result = filter.finish();
        expect(result.toolCalls).toEqual([{ id: null, name: 'read_file', arguments: { path: 'a' } }]);
        expect(result.pending).toBe('');
    });

    it('стримит прозу и придерживает начавшийся вызов', () => {
        const filter = new ToolCallStreamFilter();
        const emitted = feed(filter, ['Читаю файл. ', '<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>']);
        expect(emitted).toBe('Читаю файл. ');
        expect(filter.finish().toolCalls).toHaveLength(1);
    });

    it('придерживает хвост, похожий на начало маркера', () => {
        const filter = new ToolCallStreamFilter();
        const emitted = feed(filter, ['готово <tool_c']);
        expect(emitted).toBe('готово ');
    });

    it('возвращает придержанный текст, если вызова так и не случилось', () => {
        const filter = new ToolCallStreamFilter();
        const emitted = feed(filter, ['вот json: ', '{"name": "не вызов"']);
        const result = filter.finish();
        expect(emitted + result.pending).toBe('вот json: {"name": "не вызов"');
        expect(result.toolCalls).toBeNull();
    });

    it('в выключенном состоянии работает как сквозной канал', () => {
        const filter = new ToolCallStreamFilter({ enabled: false });
        const emitted = feed(filter, ['<tool_call>{"name":"a","arguments":{}}</tool_call>']);
        expect(emitted).toContain('<tool_call>');
        expect(filter.finish().toolCalls).toBeNull();
    });
});
