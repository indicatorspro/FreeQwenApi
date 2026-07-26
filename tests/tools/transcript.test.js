import { describe, it, expect } from 'vitest';

import { buildToolRegistry } from '../../src/core/tools/registry.js';
import { buildTranscript, hasToolState, prepareMessageInput, shouldFoldTranscript } from '../../src/core/tools/transcript.js';

const toolDialog = [
    { role: 'system', content: 'Ты агент.' },
    { role: 'user', content: 'Прочитай a.js' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'console.log(1)' }
];

describe('buildTranscript', () => {
    it('оформляет вызовы и результаты в нотации Qwen', () => {
        const transcript = buildTranscript(toolDialog);
        expect(transcript).toContain('<tool_call>');
        expect(transcript).toContain('<tool_response>');
        expect(transcript).toContain('console.log(1)');
    });

    it('подставляет имя функции результату по tool_call_id', () => {
        expect(buildTranscript(toolDialog)).toContain('"name": "read_file"');
    });

    it('исключает системное сообщение', () => {
        expect(buildTranscript(toolDialog)).not.toContain('Ты агент.');
    });

    it('обрезает огромный результат инструмента', () => {
        const huge = [{ role: 'tool', name: 'read_file', content: 'x'.repeat(50_000) }];
        expect(buildTranscript(huge)).toContain('результат обрезан');
    });
});

describe('hasToolState', () => {
    it('видит результаты инструментов', () => {
        expect(hasToolState(toolDialog)).toBe(true);
    });

    it('не срабатывает на обычном диалоге', () => {
        expect(hasToolState([{ role: 'user', content: 'привет' }])).toBe(false);
    });
});

describe('shouldFoldTranscript', () => {
    const registry = buildToolRegistry([{ function: { name: 'read_file' } }], null);

    it('сворачивает ход с результатом инструмента даже при наличии chatId', () => {
        expect(shouldFoldTranscript(toolDialog, registry, 'chat_1')).toBe(true);
    });

    it('не сворачивает первый ход обычного диалога', () => {
        expect(shouldFoldTranscript([{ role: 'user', content: 'привет' }], null, 'chat_1')).toBe(false);
    });

    it('сворачивает историю без chatId', () => {
        const messages = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }];
        expect(shouldFoldTranscript(messages, null, null)).toBe(true);
    });
});

describe('prepareMessageInput', () => {
    it('отдаёт последнее сообщение пользователя без сворачивания', () => {
        const result = prepareMessageInput([{ role: 'user', content: 'привет' }], null, 'chat_1');
        expect(result).toMatchObject({ messageContent: 'привет', folded: false, missingUser: false });
    });

    it('сообщает об отсутствии пользовательского сообщения', () => {
        expect(prepareMessageInput([{ role: 'system', content: 'x' }], null, null).missingUser).toBe(true);
    });

    it('сворачивает диалог с инструментами', () => {
        const result = prepareMessageInput(toolDialog, null, 'chat_1');
        expect(result.folded).toBe(true);
        expect(result.messageContent).toContain('<tool_response>');
    });
});
