import { describe, it, expect } from 'vitest';

import { ToolCallStreamFilter } from '../../src/core/tools/stream.js';

function feed(filter, chunks) {
    return chunks.map(chunk => filter.push(chunk)).join('');
}

describe('ToolCallStreamFilter', () => {
    it('passes regular text through without delay', () => {
        const filter = new ToolCallStreamFilter();
        const emitted = feed(filter, ['Hello', ', ', 'how are you?']);
        expect(emitted).toBe('Hello, how are you?');
        expect(filter.finish().toolCalls).toBeNull();
    });

    it('does not deliver the service JSON of the call to the client', () => {
        const filter = new ToolCallStreamFilter();
        const emitted = feed(filter, ['<tool_call>', '{"name":"read_file",', '"arguments":{"path":"a"}}', '</tool_call>']);
        expect(emitted).toBe('');

        const result = filter.finish();
        expect(result.toolCalls).toEqual([{ id: null, name: 'read_file', arguments: { path: 'a' } }]);
        expect(result.pending).toBe('');
    });

    it('streams prose and holds back a started call', () => {
        const filter = new ToolCallStreamFilter();
        const emitted = feed(filter, ['Reading the file. ', '<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>']);
        expect(emitted).toBe('Reading the file. ');
        expect(filter.finish().toolCalls).toHaveLength(1);
    });

    it('holds back a tail that looks like the start of a marker', () => {
        const filter = new ToolCallStreamFilter();
        const emitted = feed(filter, ['done <tool_c']);
        expect(emitted).toBe('done ');
    });

    it('returns the held-back text if no call ever happened', () => {
        const filter = new ToolCallStreamFilter();
        const emitted = feed(filter, ['here is json: ', '{"name": "not a call"']);
        const result = filter.finish();
        expect(emitted + result.pending).toBe('here is json: {"name": "not a call"');
        expect(result.toolCalls).toBeNull();
    });

    it('in the disabled state works as a pass-through channel', () => {
        const filter = new ToolCallStreamFilter({ enabled: false });
        const emitted = feed(filter, ['<tool_call>{"name":"a","arguments":{}}</tool_call>']);
        expect(emitted).toContain('<tool_call>');
        expect(filter.finish().toolCalls).toBeNull();
    });
});
