// Сборка тела запроса к /api/v2/chat/completions.

import { uuid, unixSeconds } from '../../shared/ids.js';
import { logDebug } from '../../shared/logger.js';

/** Типы генерации Qwen Chat. */
export const CHAT_TYPES = Object.freeze({
    TEXT: 't2t',
    IMAGE: 't2i',
    VIDEO: 't2v'
});

/**
 * @param {object} options
 * @param {string|Array} options.content — текст либо составное сообщение
 * @param {string} options.model
 * @param {string} options.chatId
 * @param {string|null} [options.parentId]
 * @param {Array} [options.files]
 * @param {string|null} [options.systemMessage]
 * @param {string} [options.chatType]
 * @param {string|null} [options.size] — соотношение сторон для медиа
 * @returns {object}
 */
export function buildChatPayload({
    content,
    model,
    chatId,
    parentId = null,
    files = null,
    systemMessage = null,
    chatType = CHAT_TYPES.TEXT,
    size = null
}) {
    const userMessageId = uuid();
    const assistantChildId = uuid();
    const isVideo = chatType === CHAT_TYPES.VIDEO;

    const featureConfig = {
        thinking_enabled: isVideo,
        output_schema: 'phase'
    };
    if (isVideo) {
        featureConfig.research_mode = 'normal';
        featureConfig.auto_thinking = true;
        featureConfig.thinking_format = 'summary';
        featureConfig.auto_search = true;
    }

    const message = {
        fid: userMessageId,
        parentId,
        parent_id: parentId,
        role: 'user',
        content,
        chat_type: chatType,
        sub_chat_type: chatType,
        timestamp: unixSeconds(),
        user_action: 'chat',
        models: [model],
        files: files || [],
        childrenIds: [assistantChildId],
        extra: { meta: { subChatType: chatType } },
        feature_config: featureConfig
    };

    const payload = {
        // Видео приходит задачей, а не потоком.
        stream: !isVideo,
        incremental_output: true,
        chat_id: chatId,
        chat_mode: 'normal',
        messages: [message],
        model,
        parent_id: parentId,
        timestamp: unixSeconds()
    };

    if (size) payload.size = size;
    if (systemMessage) {
        payload.system_message = systemMessage;
        logDebug(`System message: ${String(systemMessage).slice(0, 100)}${systemMessage.length > 100 ? '…' : ''}`);
    }

    return payload;
}

/**
 * Проверяет структуру сообщения перед отправкой.
 * @returns {{content: string|Array}|{error: string}}
 */
export function validateMessageContent(message) {
    if (message === null || message === undefined) {
        return { error: 'Сообщение не может быть пустым' };
    }
    if (typeof message === 'string') {
        return { content: message };
    }
    if (Array.isArray(message)) {
        const isValid = message.every(item =>
            (item?.type === 'text' && typeof item.text === 'string') ||
            (item?.type === 'image' && typeof item.image === 'string') ||
            (item?.type === 'file' && typeof item.file === 'string')
        );
        return isValid ? { content: message } : { error: 'Некорректная структура составного сообщения' };
    }
    return { error: 'Неподдерживаемый формат сообщения' };
}
