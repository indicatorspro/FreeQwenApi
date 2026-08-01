// Transferring OpenAI dialog history into single message for Qwen Chat.
//
// Qwen Chat has no `tool`/`assistant.tool_calls` roles: it stores own
// history on server. When agent sends tool result, can't continue
// "server" branch — result won't get into it. Therefore such turn
// is folded into single request, formatted in same <tool_call>/
// response> notation as Qwen chat-template.

import { config } from '../../config/index.js';

/** Converts content of any OpenAI format to text. */
export function stringifyContent(content) {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;

    if (Array.isArray(content)) {
        return content.map(item => {
            if (!item) return '';
            if (typeof item === 'string') return item;
            if (item.type === 'text') return item.text || '';
            if (item.type === 'image_url') return `[image: ${item.image_url?.url || ''}]`;
            if (item.type === 'image') return `[image: ${item.image || ''}]`;
            if (item.type === 'file') return `[file: ${item.file || item.name || ''}]`;
            return JSON.stringify(item);
        }).filter(Boolean).join('\n');
    }

    return JSON.stringify(content);
}

function truncateResult(text) {
    const limit = config.tools.resultMaxChars;
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n… [result truncated: ${text.length - limit} chars]`;
}

function renderToolCalls(toolCalls) {
    return toolCalls.map(call => {
        const fn = call.function || call;
        let args = fn.arguments;
        if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch { /* keep as string */ }
        }
        return `<tool_call>\n${JSON.stringify({ name: fn.name, arguments: args ?? {} })}\n</tool_call>`;
    }).join('\n');
}

function renderMessage(message, toolNameById) {
    if (!message || message.role === 'system') return null;

    switch (message.role) {
        case 'user':
            return `User: ${stringifyContent(message.content)}`;

        case 'assistant': {
            const parts = [];
            const text = stringifyContent(message.content);
            if (text) parts.push(`Assistant: ${text}`);
            if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
                parts.push(renderToolCalls(message.tool_calls));
            } else if (message.function_call) {
                parts.push(renderToolCalls([{ function: message.function_call }]));
            }
            return parts.length > 0 ? parts.join('\n') : null;
        }

        case 'tool':
        case 'function': {
            const name = message.name || toolNameById.get(message.tool_call_id) || 'tool';
            const body = truncateResult(stringifyContent(message.content));
            return `<tool_response>\n{"name": ${JSON.stringify(name)}, "content": ${JSON.stringify(body)}}\n</tool_response>`;
        }

        default:
            return `${message.role || 'message'}: ${stringifyContent(message.content)}`;
    }
}

/** Mapping tool_call_id → function name, used to label results. */
function mapToolNames(messages) {
    const map = new Map();
    for (const message of messages || []) {
        if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
        for (const call of message.tool_calls) {
            if (call?.id && call.function?.name) map.set(call.id, call.function.name);
        }
    }
    return map;
}

/** Collapses history into a single text block. */
export function buildTranscript(messages) {
    const toolNameById = mapToolNames(messages);
    return (messages || [])
        .map(message => renderMessage(message, toolNameById))
        .filter(Boolean)
        .join('\n\n');
}

/** Whether the history contains tool state (calls or their results). */
export function hasToolState(messages) {
    return (messages || []).some(message =>
        message?.role === 'tool' ||
        message?.role === 'function' ||
        (message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) ||
        (message?.role === 'assistant' && message.function_call)
    );
}

/**
 * Whether history should be collapsed instead of relying on Qwen server-side memory.
 * @param {Array} messages
 * @param {import('../registry.js').ToolRegistry|null} registry
 * @param {string|null} chatId
 */
export function shouldFoldTranscript(messages, registry, chatId) {
    const conversational = (messages || []).filter(message => message && message.role !== 'system');
    if (conversational.length === 0) return false;

    // A tool result cannot be placed into Qwen server history — only as text.
    if (hasToolState(messages)) return true;

    // Fully stateless mode: the client maintains history itself and did not provide a chatId.
    if (!chatId && conversational.length > 1) return true;

    // With tools, the call discipline must be fully visible to the model,
    // rather than depending on what Qwen remembered in its own branch.
    if (registry && !registry.isEmpty && conversational.length > 1) return true;

    return false;
}

/**
 * Prepares input for Qwen from an array of OpenAI messages.
 * @returns {{messageContent: unknown, files: Array, folded: boolean, missingUser: boolean}}
 */
export function prepareMessageInput(messages, registry, chatId) {
    const lastUser = (messages || []).filter(message => message && message.role === 'user').pop();

    if (shouldFoldTranscript(messages, registry, chatId)) {
        return {
            messageContent: buildTranscript(messages),
            files: lastUser?.files || [],
            folded: true,
            missingUser: false
        };
    }

    if (!lastUser) {
        return { messageContent: null, files: [], folded: false, missingUser: true };
    }

    return {
        messageContent: lastUser.content,
        files: lastUser.files || [],
        folded: false,
        missingUser: false
    };
}
