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
        description: 'Reads a file',
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
    it('returns a regular response in OpenAI format', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply('Hello!', { stream: false }));

        const response = await server.post('/api/chat/completions', {
            messages: [{ role: 'user', content: 'hello' }]
        });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.object).toBe('chat.completion');
        expect(body.choices[0].message.content).toBe('Hello!');
        expect(body.choices[0].finish_reason).toBe('stop');
    });

    it('responds 400 without messages', async () => {
        const response = await server.post('/api/chat/completions', { messages: [] });
        expect(response.status).toBe(400);
    });

    it('works on the /api/v1/chat/completions path', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply('ok', { stream: false }));

        const response = await server.post('/api/v1/chat/completions', {
            messages: [{ role: 'user', content: 'hello' }]
        });

        expect(response.status).toBe(200);
        expect((await response.json()).choices[0].message.content).toBe('ok');
    });

    it('returns 405 on GET', async () => {
        expect((await server.get('/api/chat/completions')).status).toBe(405);
    });
});

describe('tool calling', () => {
    it('converts <tool_call> into OpenAI-format tool_calls', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply(
            '<tool_call>\n{"name": "mcp__fs__read_file", "arguments": {"path": "src/index.js"}}\n</tool_call>',
            { stream: false }
        ));

        const response = await server.post('/api/chat/completions', {
            messages: [{ role: 'user', content: 'read src/index.js' }],
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

    it('passes the tool description to the model in the system message', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply('ok', { stream: false }));

        await server.post('/api/chat/completions', {
            messages: [{ role: 'system', content: 'You are an agent.' }, { role: 'user', content: 'hello' }],
            tools: TOOLS
        });

        const { systemMessage } = vi.mocked(sendMessage).mock.calls[0][0];
        expect(systemMessage).toContain('You are an agent.');
        expect(systemMessage).toContain('mcp__fs__read_file');
        expect(systemMessage).toContain('<tool_call>');
    });

    it('does not add tools when tool_choice=none', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply('ok', { stream: false }));

        await server.post('/api/chat/completions', {
            messages: [{ role: 'user', content: 'hello' }],
            tools: TOOLS,
            tool_choice: 'none'
        });

        const { systemMessage } = vi.mocked(sendMessage).mock.calls[0][0];
        expect(systemMessage ?? '').not.toContain('<tool_call>');
    });

    it('re-asks the model when the function name is unknown', async () => {
        vi.mocked(sendMessage)
            .mockImplementationOnce(mockQwenReply('<tool_call>{"name":"ghost_tool","arguments":{}}</tool_call>', { stream: false }))
            .mockImplementationOnce(mockQwenReply('<tool_call>{"name":"mcp__fs__read_file","arguments":{"path":"a.js"}}</tool_call>', { stream: false }));

        const response = await server.post('/api/chat/completions', {
            messages: [{ role: 'user', content: 'read a.js' }],
            tools: TOOLS
        });
        const body = await response.json();

        expect(vi.mocked(sendMessage)).toHaveBeenCalledTimes(2);
        expect(body.choices[0].message.tool_calls[0].function.name).toBe('mcp__fs__read_file');
    });

    it('folds the tool result into the request to Qwen', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply('File read.', { stream: false }));

        await server.post('/api/chat/completions', {
            messages: [
                { role: 'user', content: 'read a.js' },
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
    it('delivers content in deltas', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply('Hello, how are you?'));

        const response = await server.post('/api/chat/completions', {
            messages: [{ role: 'user', content: 'hello' }],
            stream: true
        });
        const events = await readSse(response);

        expect(response.headers.get('content-type')).toContain('text/event-stream');
        expect(sseContent(events)).toBe('Hello, how are you?');
        expect(sseFinishReason(events)).toBe('stop');
    });

    it('does not show the client the service JSON of the call', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply(
            '<tool_call>{"name":"mcp__fs__read_file","arguments":{"path":"a.js"}}</tool_call>'
        ));

        const response = await server.post('/api/chat/completions', {
            messages: [{ role: 'user', content: 'read a.js' }],
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

    it('streams prose and separately delivers the call if the model produced both', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply(
            'I will read it now.\n<tool_call>{"name":"mcp__fs__read_file","arguments":{"path":"a.js"}}</tool_call>'
        ));

        const events = await readSse(await server.post('/api/chat/completions', {
            messages: [{ role: 'user', content: 'read a.js' }],
            tools: TOOLS,
            stream: true
        }));

        expect(sseContent(events)).toContain('I will read it now.');
        expect(sseToolCalls(events)).toHaveLength(1);
    });

    it('does not lose text that happened to look like a call', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply('{"name": "this is just JSON in the response"}'));

        const events = await readSse(await server.post('/api/chat/completions', {
            messages: [{ role: 'user', content: 'show json' }],
            tools: TOOLS,
            stream: true
        }));

        expect(sseContent(events)).toBe('{"name": "this is just JSON in the response"}');
        expect(sseFinishReason(events)).toBe('stop');
    });

    it('delivers the response in one chunk if Qwen replied without streaming', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply('Response without streaming', { stream: false }));

        const events = await readSse(await server.post('/api/chat/completions', {
            messages: [{ role: 'user', content: 'hello' }],
            stream: true
        }));

        expect(sseContent(events)).toBe('Response without streaming');
    });

    it('reports an error through the stream', async () => {
        vi.mocked(sendMessage).mockResolvedValue({ error: 'All accounts are blocked' });

        const events = await readSse(await server.post('/api/chat/completions', {
            messages: [{ role: 'user', content: 'hello' }],
            stream: true
        }));

        expect(sseContent(events)).toContain('All accounts are blocked');
    });
});

describe('conversation context', () => {
    it('continues the chat by conversation_id across requests', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply('ok', { stream: false, chatId: 'qwen-chat-42' }));

        const payload = {
            messages: [{ role: 'user', content: 'hello' }],
            conversation_id: 'conv-1'
        };

        await server.post('/api/chat/completions', payload);
        await server.post('/api/chat/completions', payload);

        expect(vi.mocked(sendMessage).mock.calls[1][0].chatId).toBe('qwen-chat-42');
    });

    it('does not bind OpenWebUI service requests to a chat', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply('Title', { stream: false }));

        await server.post('/api/chat/completions', {
            messages: [{ role: 'user', content: '### Task:\nGenerate a title' }],
            conversation_id: 'conv-2'
        });

        expect(vi.mocked(sendMessage).mock.calls[0][0].chatId).toBeNull();
    });
});
