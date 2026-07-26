// Определение чата Qwen для входящего запроса.
//
// Клиенты идентифицируют диалог по-разному: OpenWebUI шлёт conversation_id,
// агенты — свой chat_id, кто-то не шлёт ничего. Плюс OpenWebUI отправляет
// служебные (meta) запросы вроде генерации заголовка — их нельзя привязывать
// к основному чату, иначе они засоряют историю.

import { config } from '../../config/index.js';
import { normalizeId, pickFirstId, randomHex, shortHash } from '../../shared/ids.js';
import { logDebug, logInfo } from '../../shared/logger.js';
import { getSession } from './store.js';

/** Служебный запрос OpenWebUI (заголовок чата, теги, автодополнение). */
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

/** Идентификатор диалога, присланный клиентом любым из известных способов. */
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

/** Клиент явно попросил начать новый чат. */
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

/** Стабильный внутренний ключ чата по идентификатору диалога клиента. */
export function buildChatKeyFromHint(hint) {
    const normalized = normalizeId(hint);
    if (!normalized) return null;
    return `chat_${shortHash(`client-conversation:${normalized}`)}`;
}

/** Стабильный ключ по первому сообщению пользователя (legacy-режим). */
export function buildChatKeyFromHistory(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return null;

    // Служебные запросы OpenWebUI не должны влиять на ключ.
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
 * Определяет, с каким чатом работать в этом запросе.
 *
 * @param {object} options
 * @param {Array} options.messages
 * @param {string|null} options.explicitChatId — chatId, переданный клиентом
 * @param {string|null} options.parentId
 * @param {string|null} options.conversationHint
 * @param {boolean} options.forceNewChat
 * @param {string|null} options.sessionKey — ключ клиента (ip+user-agent)
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
        logDebug('Служебный запрос OpenWebUI: отдельный чат без привязки к сессии');
        return { chatId: null, parentId: null, scope, isMeta: true, persist: false };
    }

    let chatId = normalizeId(explicitChatId);
    let effectiveParentId = normalizeId(parentId);

    if (forceNewChat && !chatId) {
        logInfo('Запрошен новый чат (newChat/resetChat)');
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
            logInfo(`Чат восстановлен по conversation_id: ${chatId}`);
        } else {
            chatId = buildChatKeyFromHint(conversationHint);
            logInfo(`Ключ чата построен по conversation_id клиента: ${chatId}`);
        }
    } else if (!chatId && config.server.allowUnscopedSessionRestore) {
        // Legacy-режим: привязка к IP + User-Agent. Небезопасен при нескольких
        // клиентах за одним адресом, поэтому по умолчанию выключен.
        const saved = getSession(sessionKey);
        if (saved?.chatId) {
            chatId = saved.chatId;
            if (!effectiveParentId) effectiveParentId = saved.parentId;
            logInfo(`Чат восстановлен из сессии: ${chatId}`);
        } else {
            chatId = buildChatKeyFromHistory(messages);
            if (chatId) logInfo(`Ключ чата построен по истории: ${chatId}`);
        }
    } else if (!chatId) {
        logDebug('Идентификатор диалога не передан, продолжение контекста отключено');
    }

    return {
        chatId,
        parentId: effectiveParentId,
        scope,
        isMeta: false,
        persist: Boolean(scope) || config.server.allowUnscopedSessionRestore
    };
}

/** Ключ сессии, под которым хранится контекст запроса. */
export function buildSessionKey(clientKey, scope = null) {
    if (!clientKey) return scope || null;
    return scope ? `${clientKey}::${scope}` : clientKey;
}
