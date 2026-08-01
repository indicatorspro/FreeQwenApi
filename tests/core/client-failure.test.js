import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/browser/browser.js', () => ({
    getBrowserContext: vi.fn(() => ({})),
    initBrowser: vi.fn(),
    setAuthenticationStatus: vi.fn(),
    shutdownBrowser: vi.fn()
}));

vi.mock('../../src/browser/auth.js', () => ({ checkVerification: vi.fn(() => false) }));
vi.mock('../../src/core/accounts/store.js', () => ({
    hasAvailableAccounts: vi.fn(() => false),
    markInvalid: vi.fn(),
    markRateLimited: vi.fn(),
    getAccountById: vi.fn(() => null)
}));
vi.mock('../../src/core/qwen/authState.js', () => ({
    clearAuthToken: vi.fn(),
    getAuthToken: vi.fn(() => 'token'),
    setAuthToken: vi.fn(),
    setBrowserTokenRateLimited: vi.fn()
}));
vi.mock('../../src/core/qwen/chats.js', () => ({ createChat: vi.fn() }));
vi.mock('../../src/core/qwen/media.js', () => ({
    extractTaskId: vi.fn(() => null),
    extractMediaUrl: vi.fn(() => null)
}));
vi.mock('../../src/core/qwen/pagePool.js', () => ({
    pagePool: { acquire: vi.fn(), release: vi.fn(), clear: vi.fn() },
    withPage: vi.fn()
}));
vi.mock('../../src/core/qwen/tasks.js', () => ({ pollTaskStatus: vi.fn() }));
vi.mock('../../src/core/qwen/transport.js', () => ({ executeChatRequest: vi.fn() }));
vi.mock('../../src/core/qwen/tokens.js', () => ({ resolveAccount: vi.fn() }));
vi.mock('../../src/core/models/registry.js', () => ({ isValidModel: vi.fn(() => true) }));
vi.mock('../../src/core/qwen/baxia.js', () => ({ preparePageForApi: vi.fn() }));
vi.mock('../../src/core/qwen/antibot.js', () => ({ isAntiBotChallenge: vi.fn(() => false) }));

const { handleFailure } = await import('../../src/core/qwen/client.js');

describe('handleFailure partial-stream guard', () => {
    it('does not rotate accounts when chunks were already streamed', async () => {
        const { hasAvailableAccounts, markInvalid } =
            await import('../../src/core/accounts/store.js');
        const { clearAuthToken: clearToken } = await import('../../src/core/qwen/authState.js');

        const result = await handleFailure(
            { ok: false, status: 401, error: 'Unauthorized', errorBody: 'Unauthorized', streamed: true },
            { id: 'acc-1' },
            { chatId: 'chat-1' }
        );

        expect(result.streamed).toBe(true);
        expect(result.error).toBe('Unauthorized');
        expect(hasAvailableAccounts).not.toHaveBeenCalled();
        expect(markInvalid).not.toHaveBeenCalled();
        expect(clearToken).not.toHaveBeenCalled();
    });

    it('returns details when errorBody present and stream already started', async () => {
        const result = await handleFailure(
            { ok: false, status: 429, error: 'RateLimited', errorBody: '{"code":"RateLimited"}', streamed: true },
            { id: 'acc-2' },
            { chatId: 'chat-2' }
        );

        expect(result.streamed).toBe(true);
        expect(result.error).toBe('RateLimited');
        expect(result.details).toBe('{"code":"RateLimited"}');
        expect(result.chatId).toBe('chat-2');
    });
});
