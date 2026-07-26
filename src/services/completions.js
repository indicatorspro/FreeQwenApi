// Единая логика chat completions: и для /api/chat/completions, и для
// /api/v1/chat/completions, и для любого другого транспорта.
//
// Раньше это были две почти дословные копии по ~340 строк в routes.js, которые
// успели разойтись в поведении (в одной сохранялся алиас чата, в другой нет).
// Здесь HTTP-слой отвечает только за разбор запроса и формат ответа.

import { config } from '../config/index.js';
import { completionId, unixSeconds } from '../shared/ids.js';
import { logDebug, logInfo, logWarn } from '../shared/logger.js';
import { mapModel } from '../core/models/mapping.js';
import { sendMessage } from '../core/qwen/client.js';
import { mapChatId, resolveChatIdAlias, saveSession } from '../core/conversations/store.js';
import { buildSessionKey, resolveConversation } from '../core/conversations/resolver.js';
import { buildToolRegistry, normalizeToolChoice } from '../core/tools/registry.js';
import { applyToolsPrompt, buildRepairPrompt } from '../core/tools/prompt.js';
import { extractToolCalls } from '../core/tools/parser.js';
import { ToolCallStreamFilter } from '../core/tools/stream.js';
import { validateToolCalls } from '../core/tools/validate.js';
import { prepareMessageInput } from '../core/tools/transcript.js';
import { appendMessages } from '../core/history/store.js';

/** Приводит content OpenAI к внутреннему формату Qwen. */
function normalizeContent(content) {
    if (!Array.isArray(content)) return content;

    return content.map(item => {
        if (item?.type === 'text') return { type: 'text', text: item.text };
        if (item?.type === 'image_url' && item.image_url) return { type: 'image', image: item.image_url.url };
        if (item?.type === 'image') return { type: 'image', image: item.image };
        return item;
    });
}

function extractSystemMessage(messages) {
    const system = (messages || []).find(message => message?.role === 'system');
    if (!system) return null;
    const content = system.content;
    return typeof content === 'string' ? content : (Array.isArray(content) ? normalizeContent(content).map(i => i.text).filter(Boolean).join('\n') : null);
}

/**
 * Реальный chatId Qwen для внутреннего ключа.
 * Внутренние ключи (chat_xxx) создаются нами, поэтому до первого ответа Qwen
 * им не соответствует ни один чат — возвращаем null, и sendMessage создаст чат
 * под тем же аккаунтом, под которым отправит сообщение.
 */
function resolveQwenChatId(chatId) {
    if (!chatId) return null;
    const alias = resolveChatIdAlias(chatId);
    if (alias) {
        logDebug(`Алиас чата: ${chatId} → ${alias}`);
        return alias;
    }
    return chatId.startsWith('chat_') ? null : chatId;
}

/**
 * @typedef {object} CompletionRequest
 * @property {Array} messages
 * @property {string} [model]
 * @property {unknown} [tools]
 * @property {unknown} [functions]
 * @property {unknown} [toolChoice]
 * @property {string|null} [chatId]
 * @property {string|null} [parentId]
 * @property {string|null} [conversationHint]
 * @property {boolean} [forceNewChat]
 * @property {string|null} [clientKey] — стабильный ключ клиента (ip+user-agent)
 *
 * @typedef {object} CompletionResult
 * @property {string} id
 * @property {string} model
 * @property {string} content
 * @property {Array|null} toolCalls
 * @property {string|null} chatId
 * @property {string|null} parentId
 * @property {object} usage
 * @property {boolean} streamed — контент уже отдан через onContent
 * @property {string} [error]
 * @property {unknown} [details]
 */

/**
 * Выполняет запрос completion.
 * @param {CompletionRequest} request
 * @param {{onContent?: (text: string) => void}} [handlers]
 * @returns {Promise<CompletionResult>}
 */
export async function runCompletion(request, { onContent = null } = {}) {
    const {
        messages,
        model: requestedModel,
        tools,
        functions,
        toolChoice,
        chatId: explicitChatId = null,
        parentId = null,
        conversationHint = null,
        forceNewChat = false,
        clientKey = null
    } = request;

    if (!Array.isArray(messages) || messages.length === 0) {
        return { error: 'Сообщения не указаны', status: 400 };
    }

    const registry = buildToolRegistry(tools, functions);
    const choice = normalizeToolChoice(toolChoice);
    const toolsActive = !registry.isEmpty && choice.mode !== 'none';

    const conversation = resolveConversation({
        messages,
        explicitChatId,
        parentId,
        conversationHint,
        forceNewChat,
        sessionKey: clientKey
    });

    const prepared = prepareMessageInput(messages, toolsActive ? registry : null, conversation.chatId);
    if (prepared.missingUser) {
        return { error: 'В запросе нет сообщений от пользователя', status: 400 };
    }
    if (prepared.folded) {
        logInfo('История свёрнута в один запрос (результаты инструментов / stateless-режим)');
    }

    const model = mapModel(requestedModel);
    if (requestedModel && model !== requestedModel) {
        logInfo(`Модель "${requestedModel}" заменена на "${model}"`);
    }

    const systemMessage = extractSystemMessage(messages);
    const toolAwareSystem = toolsActive ? applyToolsPrompt(systemMessage, registry, choice) : systemMessage;

    if (toolsActive) {
        logInfo(`Активны инструменты: ${registry.size} шт., tool_choice=${choice.mode}${choice.name ? `:${choice.name}` : ''}`);
    }

    // Пока не ясно, окажется ли ответ вызовом инструмента, служебный JSON
    // клиенту не отдаём — фильтр придержит подозрительный фрагмент.
    const filter = onContent ? new ToolCallStreamFilter({ enabled: toolsActive }) : null;
    // Копим то, что уже ушло клиенту: в конце нужно дослать ровно недостающее
    // и ничего не продублировать.
    let emittedText = '';
    const handleChunk = filter
        ? (chunk) => {
            const safe = filter.push(chunk);
            if (safe) {
                emittedText += safe;
                onContent(safe);
            }
        }
        : null;

    const response = await sendMessage({
        message: normalizeContent(prepared.messageContent),
        model,
        chatId: resolveQwenChatId(conversation.chatId),
        parentId: conversation.parentId,
        files: prepared.files,
        systemMessage: toolAwareSystem,
        onChunk: handleChunk
    });

    if (response.error) {
        return {
            error: response.error,
            details: response.details,
            chatId: response.chatId ?? conversation.chatId,
            status: 500
        };
    }

    persistConversation({ conversation, clientKey, response });

    const rawContent = response.choices?.[0]?.message?.content ?? '';
    let content = rawContent;
    let toolCalls = null;
    let pending = '';

    if (filter) {
        const finished = filter.finish();
        // Ответ мог прийти не потоком (JSON вместо SSE) — тогда фильтр пуст.
        if (filter.text) {
            content = finished.content;
            pending = finished.pending;
            toolCalls = finished.toolCalls;
        }
    }

    if (toolsActive && !toolCalls) {
        const extracted = extractToolCalls(content);
        if (extracted) {
            toolCalls = extracted.calls;
            content = extracted.text;
            pending = '';
        }
    }

    let usage = response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let chatId = response.chatId ?? conversation.chatId;
    let parent = response.parentId ?? response.response_id ?? null;
    let validated = toolCalls ? validateToolCalls(toolCalls, registry) : { calls: [], problems: [] };

    if (toolsActive) {
        const repaired = await repairIfNeeded({
            validated,
            toolCalls,
            registry,
            choice,
            model,
            chatId,
            parentId: parent,
            systemMessage: toolAwareSystem
        });

        if (repaired) {
            validated = repaired.validated;
            content = repaired.content;
            chatId = repaired.chatId ?? chatId;
            parent = repaired.parentId ?? parent;
            usage = repaired.usage || usage;
            pending = '';
        }
    }

    const finalToolCalls = validated.calls.length > 0 ? validated.calls : null;

    // Инструментов не нашлось: придержанный фильтром текст — обычный ответ.
    if (!finalToolCalls && pending) content += pending;

    if (!finalToolCalls && validated.problems.length > 0) {
        logWarn(`Вызовы инструментов отброшены: ${validated.problems.map(p => p.reason).join('; ')}`);
    }

    const finalContent = finalToolCalls ? content : (content || rawContent);

    // Досылаем остаток: часть текста могла быть придержана фильтром, а ответ
    // мог прийти и вовсе не потоком (Qwen иногда отвечает обычным JSON).
    if (onContent) {
        const remainder = finalContent.startsWith(emittedText)
            ? finalContent.slice(emittedText.length)
            : (emittedText ? '' : finalContent);
        if (remainder) onContent(remainder);
    }

    // Локальная копия истории — для дашборда и разбора инцидентов.
    if (chatId && !conversation.isMeta) {
        const lastUser = messages.filter(message => message?.role === 'user').pop();
        appendMessages(chatId, [
            ...(lastUser ? [{ role: 'user', content: lastUser.content }] : []),
            {
                role: 'assistant',
                content: finalContent,
                ...(finalToolCalls ? { tool_calls: finalToolCalls.map(({ index, ...call }) => call) } : {})
            }
        ]);
    }

    return {
        id: response.id || completionId(),
        created: unixSeconds(),
        model: response.model || model,
        content: finalContent,
        toolCalls: finalToolCalls,
        chatId,
        parentId: parent,
        usage,
        // Контент полностью доставлен через onContent — повторно слать не нужно.
        streamed: Boolean(onContent)
    };
}

function persistConversation({ conversation, clientKey, response }) {
    if (conversation.isMeta || !response.chatId) return;

    if (conversation.chatId?.startsWith('chat_')) {
        mapChatId(conversation.chatId, response.chatId);
    }

    if (conversation.persist) {
        saveSession(buildSessionKey(clientKey, conversation.scope), {
            chatId: response.chatId,
            parentId: response.parentId ?? response.response_id ?? null,
            scope: conversation.scope
        });
    }
}

/**
 * Переспрашивает модель, когда вызов не удалось принять.
 *
 * Клиент исполняет вызовы буквально, поэтому лучше потратить один запрос на
 * уточнение, чем вернуть агенту несуществующую функцию или битые аргументы.
 */
async function repairIfNeeded({
    validated,
    toolCalls,
    registry,
    choice,
    model,
    chatId,
    parentId,
    systemMessage
}) {
    const maxAttempts = config.tools.maxRepairAttempts;
    if (maxAttempts <= 0) return null;

    const needsRepair = (validated.calls.length === 0 && validated.problems.length > 0)
        || (choice.mode === 'required' && !toolCalls);
    if (!needsRepair) return null;

    const problems = validated.problems.length > 0
        ? validated.problems
        : [{ name: choice.name || '', reason: 'Ответ не содержит вызова функции, хотя он обязателен.' }];

    let currentChatId = chatId;
    let currentParentId = parentId;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        logWarn(`Некорректный вызов инструмента, уточняющий запрос ${attempt}/${maxAttempts}`);

        const response = await sendMessage({
            message: buildRepairPrompt(problems, registry),
            model,
            chatId: currentChatId,
            parentId: currentParentId,
            systemMessage
        });

        if (response.error) {
            logWarn(`Уточняющий запрос не удался: ${response.error}`);
            return null;
        }

        currentChatId = response.chatId ?? currentChatId;
        currentParentId = response.parentId ?? response.response_id ?? currentParentId;

        const content = response.choices?.[0]?.message?.content ?? '';
        const extracted = extractToolCalls(content);

        if (!extracted) {
            // Модель ответила прозой — это допустимый исход, если вызов не обязателен.
            if (choice.mode !== 'required') {
                return {
                    validated: { calls: [], problems: [] },
                    content,
                    chatId: currentChatId,
                    parentId: currentParentId,
                    usage: response.usage
                };
            }
            continue;
        }

        const revalidated = validateToolCalls(extracted.calls, registry);
        if (revalidated.calls.length > 0) {
            logInfo('Уточняющий запрос дал корректный вызов инструмента');
            return {
                validated: revalidated,
                content: extracted.text,
                chatId: currentChatId,
                parentId: currentParentId,
                usage: response.usage
            };
        }
    }

    return null;
}
