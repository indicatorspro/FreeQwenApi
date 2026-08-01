// Unified chat completions logic: for /api/chat/completions,
// /api/v1/chat/completions, and any other transport.
//
// Previously these were two nearly verbatim copies of ~340 lines in routes.js,
// which diverged in behavior (one saved chat alias, the other didn't).
// Here HTTP layer only handles request parsing and response format.

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

/** Converts OpenAI content to internal Qwen format. */
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
 * Real Qwen chatId for internal key.
 * Internal keys (chat_xxx) are created by us, so before first Qwen response
 * no chat corresponds to them — return null, and sendMessage will create chat
 * under same account that will send the message.
 */
function resolveQwenChatId(chatId) {
    if (!chatId) return null;
    const alias = resolveChatIdAlias(chatId);
    if (alias) {
        logDebug(`Chat alias: ${chatId} → ${alias}`);
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
 * @property {string|null} [clientKey] — stable client key (ip+user-agent)
 *
 * @typedef {object} CompletionResult
 * @property {string} id
 * @property {string} model
 * @property {string} content
 * @property {Array|null} toolCalls
 * @property {string|null} chatId
 * @property {string|null} parentId
 * @property {object} usage
 * @property {boolean} streamed — content already sent via onContent
 * @property {string} [error]
 * @property {unknown} [details]
 */

/**
 * Executes a completion request.
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
        return { error: 'Messages are not provided', status: 400 };
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
        return { error: 'The request has no user messages', status: 400 };
    }
    if (prepared.folded) {
        logInfo('History folded into a single request (tool results / stateless mode)');
    }

    const model = mapModel(requestedModel);
    if (requestedModel && model !== requestedModel) {
        logInfo(`Model "${requestedModel}" replaced with "${model}"`);
    }

    const systemMessage = extractSystemMessage(messages);
    const toolAwareSystem = toolsActive ? applyToolsPrompt(systemMessage, registry, choice) : systemMessage;

    if (toolsActive) {
        logInfo(`Tools active: ${registry.size} items, tool_choice=${choice.mode}${choice.name ? `:${choice.name}` : ''}`);
    }

    // Until it is clear whether the response will be a tool call, service JSON
    // is not sent to the client — the filter holds back the suspicious fragment.
    const filter = onContent ? new ToolCallStreamFilter({ enabled: toolsActive }) : null;
    // Accumulate what has already been sent to the client: at the end we must send exactly what is missing
    // and duplicate nothing.
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
        clientScope: clientKey,
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

    if (filter) {
        const finished = filter.finish();
        // The response may have arrived non-streamed (JSON instead of SSE) — then the filter is empty.
        if (filter.text) {
            content = finished.content;
            toolCalls = finished.toolCalls;
        }
    }

    if (toolsActive && !toolCalls) {
        const extracted = extractToolCalls(content);
        if (extracted) {
            toolCalls = extracted.calls;
            content = extracted.text;
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
        }
    }

    const finalToolCalls = validated.calls.length > 0 ? validated.calls : null;

    // No tools found: `content` already contains the full raw response (including
    // any held-back text), so nothing extra needs appending.

    if (!finalToolCalls && validated.problems.length > 0) {
        logWarn(`Tool calls discarded: ${validated.problems.map(p => p.reason).join('; ')}`);
    }

    const finalContent = finalToolCalls ? content : (content || rawContent);

    // Send the remainder: part of the text may have been held back by the filter, and the response
    // may have arrived non-streamed altogether (Qwen sometimes responds with plain JSON).
    if (onContent) {
        const remainder = finalContent.startsWith(emittedText)
            ? finalContent.slice(emittedText.length)
            : (emittedText ? '' : finalContent);
        if (remainder) onContent(remainder);
    }

    // Local copy of history — for the dashboard and incident investigation.
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
        // Content has been fully delivered via onContent — no need to send it again.
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
 * Re-asks the model when a call could not be accepted.
 *
 * The client executes calls literally, so it is better to spend one request on
 * clarification than to return a nonexistent function or broken arguments to the agent.
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
        : [{ name: choice.name || '', reason: 'The response does not contain a function call, although one is required.' }];

    let currentChatId = chatId;
    let currentParentId = parentId;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        logWarn(`Invalid tool call, clarification request ${attempt}/${maxAttempts}`);

        const response = await sendMessage({
            message: buildRepairPrompt(problems, registry),
            model,
            chatId: currentChatId,
            parentId: currentParentId,
            systemMessage
        });

        if (response.error) {
            logWarn(`Clarification request failed: ${response.error}`);
            return null;
        }

        currentChatId = response.chatId ?? currentChatId;
        currentParentId = response.parentId ?? response.response_id ?? currentParentId;

        const content = response.choices?.[0]?.message?.content ?? '';
        const extracted = extractToolCalls(content);

        if (!extracted) {
            // The model responded with prose — this is an acceptable outcome if the call is not required.
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
            logInfo('Clarification request produced a valid tool call');
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
