// Determines the Qwen chat for an incoming request.
//
// Clients identify conversations differently: OpenWebUI sends conversation_id,
// agents send their own chat_id, some send nothing at all. Additionally, OpenWebUI
// sends service (meta) requests like title generation — these must not be bound
// to the main chat, otherwise they pollute the history.

import { config } from '../../config/index.js';
import { normalizeId, pickFirstId, randomHex, shortHash } from '../../shared/ids.js';
import { logDebug, logInfo } from '../../shared/logger.js';
import { getSession } from './store.js';

/** OpenWebUI service request (chat title, tags, autocomplete). */
export function isMetaRequest(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return false;

    const lastUser = messages.filter(message => message?.role === 'user').pop();
    if (!lastUser) return false;

    const content = lastUser.content;
    if (Array.isArray(content) || typeof content !== 'string') return false;

    const text = content.trimStart();
    if (text.startsWith('### Task:')) return true;
    if (text.startsWith('History:')) return true;
    if (text.includes('<chat_history>') && text.includes('### Task:')) return true;

    return false;
}

/** Conversation identifier sent by the client via any known method. */
export function extractConversationHint({ body = {}, headers = {} }) {
    const metadata = body && typeof body.metadata === 'object' ? body.metadata : {};
    return pickFirstId([
        body.conversation_id,
        body.conversationId,
        body.chat_id,
        metadata.conversation_id,
        metadata.conversationId,
        metadata.chat_id,
        metadata.chatId,
        headers['x-conversation-id'],
        headers['x-openwebui-conversation-id'],
        headers['x-chat-id'],
        headers['x-openwebui-chat-id']
    ]);
}

export function extractParentHint({ body = {}, headers = {} }) {
    const metadata = body && typeof body.metadata === 'object' ? body.metadata : {};
    return pickFirstId([
        body.parentId,
        body.parent_id,
        body.x_qwen_parent_id,
        body.response_id,
        metadata.parentId,
        metadata.parent_id,
        metadata.response_id,
        headers['x-parent-id'],
        headers['x-openwebui-parent-id']
    ]);
}

function isTruthyFlag(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value !== 'string') return false;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/** Client explicitly requested to start a new chat. */
export function shouldForceNewChat({ body = {}, headers = {} }) {
    return [
        body.newChat,
        body.new_chat,
        body.resetChat,
        body.reset_chat,
        headers['x-new-chat'],
        headers['x-reset-chat']
    ].some(isTruthyFlag);
}

/** Stable internal chat key derived from the client's conversation identifier. */
export function buildChatKeyFromHint(hint) {
    const normalized = normalizeId(hint);
    if (!normalized) return null;
    return `chat_${shortHash(`client-conversation:${normalized}`)}`;
}

/** Stable key based on the first user message (legacy mode). */
export function buildChatKeyFromHistory(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return null;

    // OpenWebUI service requests must not affect the key.
    const real = messages.filter(message => {
        if (message?.role !== 'user') return true;
        const content = typeof message.content === 'string' ? message.content : '';
        return !content.startsWith('### Task:') && !content.startsWith('History:');
    });

    const source = real.length > 0 ? real : messages;
    const firstUser = source
        .filter(message => message?.role === 'user')
        .slice(0, 1)
        .map(message => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
        .join('||');

    return firstUser ? `chat_${shortHash(firstUser)}` : null;
}

/**
 * Determines which chat to use for this request.
 *
 * @param {object} options
 * @param {Array} options.messages
 * @param {string|null} options.explicitChatId — chatId passed by the client
 * @param {string|null} options.parentId
 * @param {string|null} options.conversationHint
 * @param {boolean} options.forceNewChat
 * @param {string|null} options.sessionKey — client key (ip+user-agent)
 * @returns {{chatId: string|null, parentId: string|null, scope: string|null, isMeta: boolean, persist: boolean}}
 */
export function resolveConversation({
    messages,
    explicitChatId = null,
    parentId = null,
    conversationHint = null,
    forceNewChat = false,
    sessionKey = null
}) {
    const isMeta = isMetaRequest(messages);
    const scope = conversationHint ? `conversation:${conversationHint}` : null;

    if (isMeta) {
        logDebug('OpenWebUI service request: separate chat without session binding');
        return { chatId: null, parentId: null, scope, isMeta: true, persist: false };
    }

    let chatId = normalizeId(explicitChatId);
    let effectiveParentId = normalizeId(parentId);

    if (forceNewChat && !chatId) {
        logInfo('New chat requested (newChat/resetChat)');
        return {
            chatId: `chat_${randomHex(8)}`,
            parentId: null,
            scope,
            isMeta: false,
            persist: Boolean(scope) || config.server.allowUnscopedSessionRestore
        };
    }

    if (!chatId && conversationHint) {
        const saved = getSession(sessionKey ? `${sessionKey}::${scope}` : scope);
        if (saved?.chatId) {
            chatId = saved.chatId;
            if (!effectiveParentId) effectiveParentId = saved.parentId;
            logInfo(`Chat restored by conversation_id: ${chatId}`);
        } else {
            chatId = buildChatKeyFromHint(conversationHint);
            logInfo(`Chat key built from client conversation_id: ${chatId}`);
        }
    } else if (!chatId && config.server.allowUnscopedSessionRestore) {
        // Legacy mode: binding by IP + User-Agent. Unsafe when multiple clients
        // share one address, so it is disabled by default.
        const saved = getSession(sessionKey);
        if (saved?.chatId) {
            chatId = saved.chatId;
            if (!effectiveParentId) effectiveParentId = saved.parentId;
            logInfo(`Chat restored from session: ${chatId}`);
        } else {
            chatId = buildChatKeyFromHistory(messages);
            if (chatId) logInfo(`Chat key built from history: ${chatId}`);
        }
    } else if (!chatId) {
        logDebug('No conversation identifier provided, context continuation disabled');
    }

    return {
        chatId,
        parentId: effectiveParentId,
        scope,
        isMeta: false,
        persist: Boolean(scope) || config.server.allowUnscopedSessionRestore
    };
}

/** Session key under which the request context is stored. */
export function buildSessionKey(clientKey, scope = null) {
    if (!clientKey) return scope || null;
    return scope ? `${clientKey}::${scope}` : clientKey;
}
