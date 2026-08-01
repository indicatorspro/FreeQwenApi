import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/qwen/client.js', () => ({
    sendMessage: vi.fn(),
    getTaskStatus: vi.fn(),
    clearPagePool: vi.fn()
}));

const { sendMessage } = await import('../../src/core/qwen/client.js');
const { resetConversationState } = await import('../../src/core/conversations/store.js');
const { startTestServer, mockQwenReply } = await import('../helpers/server.js');

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

describe('POST /api/messages (Anthropic shim)', () => {
    it('returns a message in Anthropic format', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply('Hello from Qwen'));

        const response = await server.post('/api/messages', {
            model: 'qwen3.7-max',
            max_tokens: 100,
            messages: [{ role: 'user', content: 'Hi' }]
        });

        expect(response.status).toBe(200);
        const body = await response.json();

        expect(body.type).toBe('message');
        expect(body.role).toBe('assistant');
        expect(body.content[0]).toEqual({ type: 'text', text: 'Hello from Qwen' });
        expect(body.stop_reason).toBe('end_turn');
        expect(body.usage).toEqual({ input_tokens: 1, output_tokens: 2 });
    });

    it('handles system message from Anthropic system field', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply('OK'));

        const response = await server.post('/api/messages', {
            model: 'qwen3.7-max',
            system: 'You are helpful.',
            messages: [{ role: 'user', content: 'Say OK' }]
        });

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.content[0].text).toBe('OK');
        const call = vi.mocked(sendMessage).mock.calls[0][0];
        expect(call.systemMessage).toBe('You are helpful.');
    });

    it('converts Anthropic tool_use/tool_result history to OpenAI format', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply('Done'));

        const response = await server.post('/api/messages', {
            model: 'qwen3.7-max',
            tools: [{
                name: 'get_weather',
                description: 'Gets weather',
                input_schema: { type: 'object', properties: { city: { type: 'string' } } }
            }],
            messages: [
                { role: 'user', content: 'Weather in Paris?' },
                {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'I will check.' },
                        { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Paris' } }
                    ]
                },
                {
                    role: 'user',
                    content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '{"temp": 20}' }]
                }
            ]
        });

        expect(response.status).toBe(200);
        const call = vi.mocked(sendMessage).mock.calls[0][0];

        // Tools are folded into the system message by runCompletion.
        expect(call.systemMessage).toContain('get_weather');
        expect(call.systemMessage).toContain('<tool_call>');

        // Tool history is folded into a single message transcript.
        expect(call.message).toContain('get_weather');
        expect(call.message).toContain('"city":"Paris"');
        expect(call.message).toContain('<tool_response>');
        expect(call.message).toContain('temp');
    });

    it('returns tool_use blocks when model emits tool calls', async () => {
        vi.mocked(sendMessage).mockImplementation(mockQwenReply(
            '<tool_call>\n{"name": "get_weather", "arguments": {"city": "Paris"}}\n</tool_call>',
            { stream: false }
        ));

        const response = await server.post('/api/messages', {
            model: 'qwen3.7-max',
            tools: [{
                name: 'get_weather',
                description: 'Gets weather',
                input_schema: { type: 'object', properties: { city: { type: 'string' } } }
            }],
            messages: [{ role: 'user', content: 'Weather?' }]
        });

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.stop_reason).toBe('tool_use');
        expect(body.content[0]).toEqual({
            type: 'tool_use',
            id: expect.stringMatching(/^call_/),
            name: 'get_weather',
            input: { city: 'Paris' }
        });
    });

    it('returns error body in Anthropic format', async () => {
        vi.mocked(sendMessage).mockImplementation(async () => ({ error: 'All accounts rate-limited', status: 429 }));

        const response = await server.post('/api/messages', {
            model: 'qwen3.7-max',
            messages: [{ role: 'user', content: 'Hi' }]
        });

        expect(response.status).toBe(500);
        const body = await response.json();
        expect(body.type).toBe('error');
        expect(body.error.type).toBe('api_error');
        expect(body.error.message).toBe('All accounts rate-limited');
    });
});
