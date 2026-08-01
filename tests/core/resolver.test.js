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
    it('recognizes an OpenWebUI service request', () => {
        expect(isMetaRequest([{ role: 'user', content: '### Task:\nGenerate a title' }])).toBe(true);
        expect(isMetaRequest([{ role: 'user', content: 'History:\n...' }])).toBe(true);
    });

    it('does not trigger on a regular message', () => {
        expect(isMetaRequest([{ role: 'user', content: 'Hello' }])).toBe(false);
    });

    it('does not trigger on a multimodal message', () => {
        expect(isMetaRequest([{ role: 'user', content: [{ type: 'text', text: '### Task:' }] }])).toBe(false);
    });
});

describe('identifier extraction', () => {
    it('reads conversation_id from body and headers', () => {
        expect(extractConversationHint({ body: { conversation_id: 'c1' } })).toBe('c1');
        expect(extractConversationHint({ headers: { 'x-conversation-id': 'c2' } })).toBe('c2');
        expect(extractConversationHint({ body: { metadata: { chatId: 'c3' } } })).toBe('c3');
    });

    it('ignores garbage values', () => {
        expect(extractConversationHint({ body: { conversation_id: 'null' } })).toBeNull();
        expect(extractConversationHint({ body: { conversation_id: '  ' } })).toBeNull();
    });

    it('reads parentId from different fields', () => {
        expect(extractParentHint({ body: { parent_id: 'p1' } })).toBe('p1');
        expect(extractParentHint({ body: { x_qwen_parent_id: 'p2' } })).toBe('p2');
    });

    it('recognizes a new chat request', () => {
        expect(shouldForceNewChat({ body: { newChat: true } })).toBe(true);
        expect(shouldForceNewChat({ headers: { 'x-reset-chat': '1' } })).toBe(true);
        expect(shouldForceNewChat({ body: {} })).toBe(false);
    });
});

describe('chat keys', () => {
    it('are deterministic for the same conversation_id', () => {
        expect(buildChatKeyFromHint('conv-1')).toBe(buildChatKeyFromHint('conv-1'));
        expect(buildChatKeyFromHint('conv-1')).not.toBe(buildChatKeyFromHint('conv-2'));
    });

    it('are built from the first user message', () => {
        const messages = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'yes' }];
        expect(buildChatKeyFromHistory(messages)).toMatch(/^chat_/);
    });

    it('ignore OpenWebUI service messages when building the key', () => {
        const withMeta = [{ role: 'user', content: '### Task:\nx' }, { role: 'user', content: 'hello' }];
        expect(buildChatKeyFromHistory(withMeta)).toBe(buildChatKeyFromHistory([{ role: 'user', content: 'hello' }]));
    });
});

describe('resolveConversation', () => {
    const messages = [{ role: 'user', content: 'hello' }];

    it('uses the explicit client chatId', () => {
        const result = resolveConversation({ messages, explicitChatId: 'real-chat', parentId: 'p1' });
        expect(result).toMatchObject({ chatId: 'real-chat', parentId: 'p1', isMeta: false });
    });

    it('does not bind a service request to a chat', () => {
        const result = resolveConversation({
            messages: [{ role: 'user', content: '### Task:\nGenerate a title' }],
            explicitChatId: 'real-chat'
        });
        expect(result).toMatchObject({ chatId: null, isMeta: true, persist: false });
    });

    it('restores a chat from the session by conversation_id', () => {
        saveSession('client-1::conversation:conv-1', { chatId: 'qwen-1', parentId: 'p9', scope: 'conversation:conv-1' });

        const result = resolveConversation({
            messages,
            conversationHint: 'conv-1',
            sessionKey: 'client-1'
        });

        expect(result).toMatchObject({ chatId: 'qwen-1', parentId: 'p9' });
    });

    it('builds a stable key if no session exists yet', () => {
        const result = resolveConversation({ messages, conversationHint: 'conv-new', sessionKey: 'client-1' });
        expect(result.chatId).toBe(buildChatKeyFromHint('conv-new', 'client-1'));
    });

    it('scopes the built key by client so clients do not collide', () => {
        const resultA = resolveConversation({ messages, conversationHint: 'conv-new', sessionKey: 'client-A' });
        const resultB = resolveConversation({ messages, conversationHint: 'conv-new', sessionKey: 'client-B' });
        expect(resultA.chatId).not.toBe(resultB.chatId);
        expect(resultA.chatId).toMatch(/^chat_/);
    });

    it('ignores the saved session when a new chat is requested', () => {
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

    it('does not restore context without a conversation identifier', () => {
        const result = resolveConversation({ messages, sessionKey: 'client-1' });
        expect(result.chatId).toBeNull();
    });
});
