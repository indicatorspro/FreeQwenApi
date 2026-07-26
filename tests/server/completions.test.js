import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/qwen/client.js', () => ({
    sendMessage: vi.fn(),
    getTaskStatus: vi.fn(),
    clearPagePool: vi.fn()
}));

const { sendMessage } = await import('../../src/core/qwen/client.js');
const { resetConversationState } = await import('../../src/core/conversations/store.js');
const {
    startTestServer,
    readSse,
    sseContent,
    sseFinishReason,
    sseToolCalls,
    mockQwenReply
} = await import('../helpers/server.js');

const TOOLS = [{
    type: 'function',
    function: {
        name: 'mcp__fs__read_file',
        description: 'Читает файл',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
    }
}];

let server;

beforeAll(async () => {
    server = await startTestServer();
});

afterAll(async () => {
    await server.close();
});

afterEach(() => {
    vi.mocked(sendMessage).mockReset();
    resetConversationState();
});

describe('POST /api/chat/completions', () => {
    it('возвращает обычный ответ в формате OpenAI', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply('Привет!', { stream: false }));

        const response = await server.post('/api/chat/completions', {
            messages: [{ role: 'user', content: 'привет' }]
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.object).toBe('chat.completion');
        expect(body.choices[0].message.content).toBe('Привет!');
        expect(body.choices[0].finish_reason).toBe('stop');
    });

    it('отвечает 400 без сообщений', async () => {
        const response = await server.post('/api/chat/completions', { messages: [] });
        expect(response.status).toBe(400);
    });

    it('работает на пути /api/v1/chat/completions', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply('ок', { stream: false }));

        const response = await server.post('/api/v1/chat/completions', {
            messages: [{ role: 'user', content: 'привет' }]
        });

        expect(response.status).toBe(200);
        expect((await response.json()).choices[0].message.content).toBe('ок');
    });

    it('отдаёт 405 на GET', async () => {
        expect((await server.get('/api/chat/completions')).status).toBe(405);
    });
});

describe('tool calling', () => {
    it('превращает <tool_call> в tool_calls формата OpenAI', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply(
            '<tool_call>\n{"name": "mcp__fs__read_file", "arguments": {"path": "src/index.js"}}\n</tool_call>',
            { stream: false }
        ));

        const response = await server.post('/api/chat/completions', {
            messages: [{ role: 'user', content: 'прочитай src/index.js' }],
            tools: TOOLS
        });
        const body = await response.json();

        expect(body.choices[0].finish_reason).toBe('tool_calls');
        expect(body.choices[0].message.tool_calls).toHaveLength(1);
        expect(body.choices[0].message.tool_calls[0].function).toEqual({
            name: 'mcp__fs__read_file',
            arguments: '{"path":"src/index.js"}'
        });
        expect(body.choices[0].message.tool_calls[0].id).toMatch(/^call_/);
    });

    it('передаёт модели описание инструментов в системном сообщении', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply('ок', { stream: false }));

        await server.post('/api/chat/completions', {
            messages: [{ role: 'system', content: 'Ты агент.' }, { role: 'user', content: 'привет' }],
            tools: TOOLS
        });

        const { systemMessage } = vi.mocked(sendMessage).mock.calls[0][0];
        expect(systemMessage).toContain('Ты агент.');
        expect(systemMessage).toContain('mcp__fs__read_file');
        expect(systemMessage).toContain('<tool_call>');
    });

    it('не добавляет инструменты при tool_choice=none', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply('ок', { stream: false }));

        await server.post('/api/chat/completions', {
            messages: [{ role: 'user', content: 'привет' }],
            tools: TOOLS,
            tool_choice: 'none'
        });

        const { systemMessage } = vi.mocked(sendMessage).mock.calls[0][0];
        expect(systemMessage ?? '').not.toContain('<tool_call>');
    });

    it('переспрашивает модель при неизвестном имени функции', async () => {
        vi.mocked(sendMessage)
            .mockImplementationOnce(mockQwenReply('<tool_call>{"name":"ghost_tool","arguments":{}}</tool_call>', { stream: false }))
            .mockImplementationOnce(mockQwenReply('<tool_call>{"name":"mcp__fs__read_file","arguments":{"path":"a.js"}}</tool_call>', { stream: false }));

        const response = await server.post('/api/chat/completions', {
            messages: [{ role: 'user', content: 'прочитай a.js' }],
            tools: TOOLS
        });
        const body = await response.json();

        expect(vi.mocked(sendMessage)).toHaveBeenCalledTimes(2);
        expect(body.choices[0].message.tool_calls[0].function.name).toBe('mcp__fs__read_file');
    });

    it('сворачивает результат инструмента в запрос к Qwen', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply('Файл прочитан.', { stream: false }));

        await server.post('/api/chat/completions', {
            messages: [
                { role: 'user', content: 'прочитай a.js' },
                { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'mcp__fs__read_file', arguments: '{"path":"a.js"}' } }] },
                { role: 'tool', tool_call_id: 'call_1', content: 'console.log(1)' }
            ],
            tools: TOOLS,
            chatId: 'existing-chat'
        });

        const { message } = vi.mocked(sendMessage).mock.calls[0][0];
        expect(message).toContain('<tool_response>');
        expect(message).toContain('console.log(1)');
    });
});

describe('streaming', () => {
    it('отдаёт контент дельтами', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply('Привет, как дела?'));

        const response = await server.post('/api/chat/completions', {
            messages: [{ role: 'user', content: 'привет' }],
            stream: true
        });
        const events = await readSse(response);

        expect(response.headers.get('content-type')).toContain('text/event-stream');
        expect(sseContent(events)).toBe('Привет, как дела?');
        expect(sseFinishReason(events)).toBe('stop');
    });

    it('не показывает клиенту служебный JSON вызова', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply(
            '<tool_call>{"name":"mcp__fs__read_file","arguments":{"path":"a.js"}}</tool_call>'
        ));

        const response = await server.post('/api/chat/completions', {
            messages: [{ role: 'user', content: 'прочитай a.js' }],
            tools: TOOLS,
            stream: true
        });
        const events = await readSse(response);

        expect(sseContent(events)).toBe('');
        expect(sseFinishReason(events)).toBe('tool_calls');

        const calls = sseToolCalls(events);
        expect(calls).toHaveLength(1);
        expect(calls[0].function.name).toBe('mcp__fs__read_file');
        expect(calls[0].index).toBe(0);
    });

    it('стримит прозу и отдельно отдаёт вызов, если модель сделала оба', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply(
            'Сейчас прочитаю.\n<tool_call>{"name":"mcp__fs__read_file","arguments":{"path":"a.js"}}</tool_call>'
        ));

        const events = await readSse(await server.post('/api/chat/completions', {
            messages: [{ role: 'user', content: 'прочитай a.js' }],
            tools: TOOLS,
            stream: true
        }));

        expect(sseContent(events)).toContain('Сейчас прочитаю.');
        expect(sseToolCalls(events)).toHaveLength(1);
    });

    it('не теряет текст, который оказался похож на вызов', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply('{"name": "это просто JSON в ответе"}'));

        const events = await readSse(await server.post('/api/chat/completions', {
            messages: [{ role: 'user', content: 'покажи json' }],
            tools: TOOLS,
            stream: true
        }));

        expect(sseContent(events)).toBe('{"name": "это просто JSON в ответе"}');
        expect(sseFinishReason(events)).toBe('stop');
    });

    it('отдаёт ответ одним куском, если Qwen ответил не потоком', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply('Ответ без потока', { stream: false }));

        const events = await readSse(await server.post('/api/chat/completions', {
            messages: [{ role: 'user', content: 'привет' }],
            stream: true
        }));

        expect(sseContent(events)).toBe('Ответ без потока');
    });

    it('сообщает об ошибке через поток', async () => {
        vi.mocked(sendMessage).mockResolvedValue({ error: 'Все аккаунты заблокированы' });

        const events = await readSse(await server.post('/api/chat/completions', {
            messages: [{ role: 'user', content: 'привет' }],
            stream: true
        }));

        expect(sseContent(events)).toContain('Все аккаунты заблокированы');
    });
});

describe('контекст диалога', () => {
    it('продолжает чат по conversation_id между запросами', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply('ок', { stream: false, chatId: 'qwen-chat-42' }));

        const payload = {
            messages: [{ role: 'user', content: 'привет' }],
            conversation_id: 'conv-1'
        };

        await server.post('/api/chat/completions', payload);
        await server.post('/api/chat/completions', payload);

        expect(vi.mocked(sendMessage).mock.calls[1][0].chatId).toBe('qwen-chat-42');
    });

    it('не привязывает служебные запросы OpenWebUI к чату', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply('Заголовок', { stream: false }));

        await server.post('/api/chat/completions', {
            messages: [{ role: 'user', content: '### Task:\nGenerate a title' }],
            conversation_id: 'conv-2'
        });

        expect(vi.mocked(sendMessage).mock.calls[0][0].chatId).toBeNull();
    });
});
