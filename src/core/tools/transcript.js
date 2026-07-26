// Перенос истории OpenAI-диалога в одно сообщение для Qwen Chat.
//
// У Qwen Chat нет ролей `tool`/`assistant.tool_calls`: он хранит собственную
// историю на сервере. Когда агент присылает результат инструмента, продолжать
// «серверную» ветку нельзя — результат в неё не попадёт. Поэтому такой ход
// сворачивается в один запрос, оформленный в той же нотации <tool_call>/
// <tool_response>, что и chat-template Qwen.

import { config } from '../../config/index.js';

/** Приводит content любого формата OpenAI к тексту. */
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
    return `${text.slice(0, limit)}\n… [результат обрезан: ${text.length - limit} символов]`;
}

function renderToolCalls(toolCalls) {
    return toolCalls.map(call => {
        const fn = call.function || call;
        let args = fn.arguments;
        if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch { /* оставляем строкой */ }
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

/** Соответствие tool_call_id → имя функции, чтобы подписать результаты. */
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

/** Сворачивает историю в один текстовый блок. */
export function buildTranscript(messages) {
    const toolNameById = mapToolNames(messages);
    return (messages || [])
        .map(message => renderMessage(message, toolNameById))
        .filter(Boolean)
        .join('\n\n');
}

/** Есть ли в истории состояние инструментов (вызовы или их результаты). */
export function hasToolState(messages) {
    return (messages || []).some(message =>
        message?.role === 'tool' ||
        message?.role === 'function' ||
        (message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) ||
        (message?.role === 'assistant' && message.function_call)
    );
}

/**
 * Нужно ли сворачивать историю вместо опоры на серверную память Qwen.
 * @param {Array} messages
 * @param {import('../registry.js').ToolRegistry|null} registry
 * @param {string|null} chatId
 */
export function shouldFoldTranscript(messages, registry, chatId) {
    const conversational = (messages || []).filter(message => message && message.role !== 'system');
    if (conversational.length === 0) return false;

    // Результат инструмента в серверную историю Qwen не положить — только текстом.
    if (hasToolState(messages)) return true;

    // Полностью stateless-режим: клиент сам ведёт историю и не дал chatId.
    if (!chatId && conversational.length > 1) return true;

    // С инструментами дисциплина вызовов должна быть видна модели целиком,
    // а не зависеть от того, что Qwen запомнил в своей ветке.
    if (registry && !registry.isEmpty && conversational.length > 1) return true;

    return false;
}

/**
 * Готовит вход для Qwen из массива сообщений OpenAI.
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
