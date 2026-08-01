// Request payload construction for Qwen Chat API.
//
// Qwen API v2 expects specific payload format:
// - chat_id, parent_id for conversation continuity
// - messages array with role/content
// - stream flag for SSE responses
//
// Stateless mode: no chat_id/parent_id for one-shot requests.

import { uuid, unixSeconds } from '../../shared/ids.js';

/** Chat types supported by Qwen. */
export const CHAT_TYPES = Object.freeze({
    TEXT: 't2t',      // text-to-text
    IMAGE: 't2i',     // text-to-image
    VIDEO: 't2v'      // text-to-video
});

/**
 * Models where thinking cannot be disabled (Qwen meta think_skip.enable=false,
 * abilities.thinking=4 — "ActiveUncancellable"). The Qwen Chat web app always
 * sends thinking_enabled:true for these; sending false is rejected by the
 * backend with invalid_input.
 */
export const THINKING_LOCKED_MODELS = Object.freeze([
    'qwen3.8-max-preview'
]);

/** @returns {boolean} whether the given model cannot skip thinking. */
export function isThinkingLocked(model) {
    return THINKING_LOCKED_MODELS.includes(String(model || ''));
}

/**
 * Validates message content.
 * @param {string|Array} message
 * @returns {{ content: string|null, error: string|null }}
 */
export function validateMessageContent(message) {
    if (!message) {
        return { content: null, error: 'Message content is required' };
    }

    // Array format: extract last user message.
    if (Array.isArray(message)) {
        const userMessages = message.filter(m => m?.role === 'user');
        const lastUser = userMessages[userMessages.length - 1];
        const content = lastUser?.content;

        if (!content) {
            return { content: null, error: 'No user message found in messages array' };
        }

        // Handle content parts (multimodal).
        if (Array.isArray(content)) {
            const textParts = content.filter(p => p?.type === 'text').map(p => p.text);
            return { content: textParts.join('\n') || null, error: textParts.length ? null : 'No text content found' };
        }

        return { content: String(content), error: null };
    }

    // String format.
    const content = String(message).trim();
    if (!content) {
        return { content: null, error: 'Message content cannot be empty' };
    }

    return { content, error: null };
}

/**
 * Builds standard chat payload for Qwen API v2.
 *
 * @param {object} params
 * @param {string} params.content — message text
 * @param {string} params.model
 * @param {string|null} params.chatId
 * @param {string|null} params.parentId
 * @param {string|null} params.systemMessage
 * @param {string} params.chatType — t2t/t2i/t2v
 * @param {string|null} params.size — image/video size
 * @param {boolean} params.stream
 * @param {Array} params.files — uploaded file references
 * @returns {object}
 */
export function buildChatPayload({
    content,
    model,
    chatId = null,
    parentId = null,
    systemMessage = null,
    chatType = CHAT_TYPES.TEXT,
    size = null,
    stream = true,
    files = null
}) {
    const messages = [];

    // User message matching Heymoma format.
    const userMessageId = uuid();
    const assistantChildId = uuid();

    const userMessage = {
        fid: userMessageId,
        parentId: parentId || '',
        parent_id: parentId || null,
        role: 'user',
        content,
        chat_type: chatType,
        sub_chat_type: chatType,
        timestamp: unixSeconds(),
        user_action: 'chat',
        model: '',
        models: [model],
        files: files || [],
        childrenIds: [assistantChildId],
        extra: { meta: { subChatType: chatType } },
        feature_config: {
            thinking_enabled: isThinkingLocked(model),
            output_schema: 'phase'
        }
    };

    messages.push(userMessage);

    const payload = {
        stream,
        version: '2.1',
        incremental_output: true,
        chatId,
        parentId: parentId || '',
        chat_id: chatId,
        chat_mode: 'normal',
        messages,
        model,
        parent_id: parentId || null,
        timestamp: unixSeconds(),
        headers: { 'X-Request-Id': uuid() }
    };

    // Size for image/video generation.
    if (size && (chatType === CHAT_TYPES.IMAGE || chatType === CHAT_TYPES.VIDEO)) {
        payload.size = size;
    }

    // System message goes at top level (matching Heymoma/ForgetMeAI).
    if (systemMessage) {
        payload.system_message = systemMessage;
    }

    return payload;
}

/**
 * Builds stateless payload (no chat_id/parent_id).
 * Used for one-shot requests when QWEN_STATELESS_DIRECT=true.
 *
 * @param {object} params
 * @param {string} params.content
 * @param {string} params.model
 * @param {string|null} params.systemMessage
 * @param {boolean} params.stream
 * @returns {object}
 */
export function buildStatelessPayload({
    content,
    model,
    systemMessage = null,
    stream = true
}) {
    const messages = [];

    if (systemMessage) {
        messages.push({ role: 'system', content: systemMessage });
    }

    messages.push({ role: 'user', content });

    return {
        // No chat_id, parent_id, session_id — stateless request.
        messages,
        model,
        stream
    };
}
