import { afterEach, describe, it, expect } from 'vitest';

import {
    buildChatKeyFromHint,
    buildChatKeyFromHistory,
    extractConversationHint,
    extractParentHint,
    isMetaRequest,
    resolveConversation,
    shouldForceNewChat
} from '../../src/core/conversations/resolver.js';
import { resetConversationState, saveSession } from '../../src/core/conversations/store.js';

afterEach(() => resetConversationState());

describe('isMetaRequest', () => {
    it('распознаёт служебный запрос OpenWebUI', () => {
        expect(isMetaRequest([{ role: 'user', content: '### Task:\nGenerate a title' }])).toBe(true);
        expect(isMetaRequest([{ role: 'user', content: 'History:\n...' }])).toBe(true);
    });

    it('не срабатывает на обычном сообщении', () => {
        expect(isMetaRequest([{ role: 'user', content: 'Привет' }])).toBe(false);
    });

    it('не срабатывает на мультимодальном сообщении', () => {
        expect(isMetaRequest([{ role: 'user', content: [{ type: 'text', text: '### Task:' }] }])).toBe(false);
    });
});

describe('извлечение идентификаторов', () => {
    it('читает conversation_id из тела и заголовков', () => {
        expect(extractConversationHint({ body: { conversation_id: 'c1' } })).toBe('c1');
        expect(extractConversationHint({ headers: { 'x-conversation-id': 'c2' } })).toBe('c2');
        expect(extractConversationHint({ body: { metadata: { chatId: 'c3' } } })).toBe('c3');
    });

    it('игнорирует мусорные значения', () => {
        expect(extractConversationHint({ body: { conversation_id: 'null' } })).toBeNull();
        expect(extractConversationHint({ body: { conversation_id: '  ' } })).toBeNull();
    });

    it('читает parentId из разных полей', () => {
        expect(extractParentHint({ body: { parent_id: 'p1' } })).toBe('p1');
        expect(extractParentHint({ body: { x_qwen_parent_id: 'p2' } })).toBe('p2');
    });

    it('распознаёт запрос нового чата', () => {
        expect(shouldForceNewChat({ body: { newChat: true } })).toBe(true);
        expect(shouldForceNewChat({ headers: { 'x-reset-chat': '1' } })).toBe(true);
        expect(shouldForceNewChat({ body: {} })).toBe(false);
    });
});

describe('ключи чатов', () => {
    it('детерминированы для одного и того же conversation_id', () => {
        expect(buildChatKeyFromHint('conv-1')).toBe(buildChatKeyFromHint('conv-1'));
        expect(buildChatKeyFromHint('conv-1')).not.toBe(buildChatKeyFromHint('conv-2'));
    });

    it('строятся по первому сообщению пользователя', () => {
        const messages = [{ role: 'user', content: 'привет' }, { role: 'assistant', content: 'да' }];
        expect(buildChatKeyFromHistory(messages)).toMatch(/^chat_/);
    });

    it('игнорируют служебные сообщения OpenWebUI при построении ключа', () => {
        const withMeta = [{ role: 'user', content: '### Task:\nx' }, { role: 'user', content: 'привет' }];
        expect(buildChatKeyFromHistory(withMeta)).toBe(buildChatKeyFromHistory([{ role: 'user', content: 'привет' }]));
    });
});

describe('resolveConversation', () => {
    const messages = [{ role: 'user', content: 'привет' }];

    it('использует явный chatId клиента', () => {
        const result = resolveConversation({ messages, explicitChatId: 'real-chat', parentId: 'p1' });
        expect(result).toMatchObject({ chatId: 'real-chat', parentId: 'p1', isMeta: false });
    });

    it('не привязывает служебный запрос к чату', () => {
        const result = resolveConversation({
            messages: [{ role: 'user', content: '### Task:\nGenerate a title' }],
            explicitChatId: 'real-chat'
        });
        expect(result).toMatchObject({ chatId: null, isMeta: true, persist: false });
    });

    it('восстанавливает чат из сессии по conversation_id', () => {
        saveSession('client-1::conversation:conv-1', { chatId: 'qwen-1', parentId: 'p9', scope: 'conversation:conv-1' });

        const result = resolveConversation({
            messages,
            conversationHint: 'conv-1',
            sessionKey: 'client-1'
        });

        expect(result).toMatchObject({ chatId: 'qwen-1', parentId: 'p9' });
    });

    it('строит стабильный ключ, если сессии ещё нет', () => {
        const result = resolveConversation({ messages, conversationHint: 'conv-new', sessionKey: 'client-1' });
        expect(result.chatId).toBe(buildChatKeyFromHint('conv-new'));
    });

    it('игнорирует сохранённую сессию при запросе нового чата', () => {
        saveSession('client-1::conversation:conv-1', { chatId: 'qwen-1', parentId: 'p9' });

        const result = resolveConversation({
            messages,
            conversationHint: 'conv-1',
            sessionKey: 'client-1',
            forceNewChat: true
        });

        expect(result.chatId).not.toBe('qwen-1');
        expect(result.parentId).toBeNull();
    });

    it('не восстанавливает контекст без идентификатора диалога', () => {
        const result = resolveConversation({ messages, sessionKey: 'client-1' });
        expect(result.chatId).toBeNull();
    });
});
