import { describe, it, expect } from 'vitest';

import { buildToolRegistry } from '../../src/core/tools/registry.js';
import { buildTranscript, hasToolState, prepareMessageInput, shouldFoldTranscript } from '../../src/core/tools/transcript.js';

const toolDialog = [
    { role: 'system', content: 'You are an agent.' },
    { role: 'user', content: 'Read a.js' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'console.log(1)' }
];

describe('buildTranscript', () => {
    it('formats calls and results in Qwen notation', () => {
        const transcript = buildTranscript(toolDialog);
        expect(transcript).toContain('<tool_call>');
        expect(transcript).toContain('<tool_response>');
        expect(transcript).toContain('console.log(1)');
    });

    it('substitutes the function name into the result by tool_call_id', () => {
        expect(buildTranscript(toolDialog)).toContain('"name": "read_file"');
    });

    it('excludes the system message', () => {
        expect(buildTranscript(toolDialog)).not.toContain('You are an agent.');
    });

    it('truncates a huge tool result', () => {
        const huge = [{ role: 'tool', name: 'read_file', content: 'x'.repeat(50_000) }];
        expect(buildTranscript(huge)).toContain('result truncated');
    });
});

describe('hasToolState', () => {
    it('detects tool results', () => {
        expect(hasToolState(toolDialog)).toBe(true);
    });

    it('does not trigger on a regular conversation', () => {
        expect(hasToolState([{ role: 'user', content: 'hello' }])).toBe(false);
    });
});

describe('shouldFoldTranscript', () => {
    const registry = buildToolRegistry([{ function: { name: 'read_file' } }], null);

    it('folds a turn with a tool result even when chatId is present', () => {
        expect(shouldFoldTranscript(toolDialog, registry, 'chat_1')).toBe(true);
    });

    it('does not fold the first turn of a regular conversation', () => {
        expect(shouldFoldTranscript([{ role: 'user', content: 'hello' }], null, 'chat_1')).toBe(false);
    });

    it('folds history without a chatId', () => {
        const messages = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }];
        expect(shouldFoldTranscript(messages, null, null)).toBe(true);
    });
});

describe('prepareMessageInput', () => {
    it('returns the last user message without folding', () => {
        const result = prepareMessageInput([{ role: 'user', content: 'hello' }], null, 'chat_1');
        expect(result).toMatchObject({ messageContent: 'hello', folded: false, missingUser: false });
    });

    it('reports the absence of a user message', () => {
        expect(prepareMessageInput([{ role: 'system', content: 'x' }], null, null).missingUser).toBe(true);
    });

    it('folds a dialog with tools', () => {
        const result = prepareMessageInput(toolDialog, null, 'chat_1');
        expect(result.folded).toBe(true);
        expect(result.messageContent).toContain('<tool_response>');
    });
});
