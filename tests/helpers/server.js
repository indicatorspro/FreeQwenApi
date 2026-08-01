// Utilities for HTTP-layer integration tests.

import { createApp } from '../../src/server/app.js';

/** Starts the application on a free port. */
export async function startTestServer() {
    const app = createApp();
    const server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    return {
        baseUrl,
        async post(path, body, options = {}) {
            return fetch(`${baseUrl}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
                body: JSON.stringify(body)
            });
        },
        async get(path) {
            return fetch(`${baseUrl}${path}`);
        },
        async close() {
            await new Promise(resolve => server.close(resolve));
        }
    };
}

/** Parses an SSE response into a list of chat.completion.chunk events. */
export async function readSse(response) {
    const text = await response.text();
    return text
        .split('\n\n')
        .map(block => block.trim())
        .filter(block => block.startsWith('data:'))
        .map(block => block.slice(5).trim())
        .filter(payload => payload && payload !== '[DONE]')
        .map(payload => JSON.parse(payload));
}

/** Joins content from SSE deltas. */
export function sseContent(events) {
    return events.map(event => event.choices?.[0]?.delta?.content || '').join('');
}

/** Collects tool calls from SSE deltas. */
export function sseToolCalls(events) {
    return events.flatMap(event => event.choices?.[0]?.delta?.tool_calls || []);
}

/** Finish reason of the last chunk. */
export function sseFinishReason(events) {
    return events.map(event => event.choices?.[0]?.finish_reason).filter(Boolean).pop() || null;
}

/**
 * Mock Qwen response: emits text in chunks via onChunk and returns a completion.
 */
export function mockQwenReply(text, { chatId = 'qwen-chat-1', stream = true, chunkSize = 8 } = {}) {
    return async ({ onChunk }) => {
        if (stream && typeof onChunk === 'function') {
            for (let index = 0; index < text.length; index += chunkSize) {
                onChunk(text.slice(index, index + chunkSize));
            }
        }
        return {
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: 1,
            model: 'qwen3.7-max',
            choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
            chatId,
            parentId: 'parent-1',
            streamed: stream && typeof onChunk === 'function'
        };
    };
}
