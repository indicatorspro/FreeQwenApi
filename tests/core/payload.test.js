import { describe, it, expect } from 'vitest';

import {
    buildChatPayload,
    buildFeatureConfig,
    isThinkingLocked,
    CHAT_TYPES,
    THINKING_LOCKED_MODELS
} from '../../src/core/qwen/payload.js';

describe('isThinkingLocked', () => {
    it('marks models whose thinking cannot be disabled', () => {
        expect(THINKING_LOCKED_MODELS).toContain('qwen3.8-max-preview');
        expect(isThinkingLocked('qwen3.8-max-preview')).toBe(true);
    });

    it('does not mark skippable models', () => {
        expect(isThinkingLocked('qwen3.7-max')).toBe(false);
        expect(isThinkingLocked('qwen3.7-plus')).toBe(false);
        expect(isThinkingLocked('qwen3.6-plus')).toBe(false);
        expect(isThinkingLocked('')).toBe(false);
        expect(isThinkingLocked(null)).toBe(false);
    });
});

describe('buildChatPayload feature_config', () => {
    it('enables thinking for qwen3.8-max-preview', () => {
        const payload = buildChatPayload({ content: 'Reply with exactly OK.', model: 'qwen3.8-max-preview' });
        expect(payload.messages[0].feature_config.thinking_enabled).toBe(true);
        expect(payload.messages[0].feature_config.output_schema).toBe('phase');
        expect(payload.messages[0].models).toEqual(['qwen3.8-max-preview']);
        expect(payload.model).toBe('qwen3.8-max-preview');
    });

    it('disables thinking for skippable models', () => {
        for (const model of ['qwen3.7-max', 'qwen3.7-plus']) {
            const payload = buildChatPayload({ content: 'hi', model });
            expect(payload.messages[0].feature_config.thinking_enabled).toBe(false);
        }
    });
});

describe('buildFeatureConfig', () => {
    it('adds video research/thinking fields for t2v', () => {
        const config = buildFeatureConfig({ model: 'qwen3.7-max', chatType: CHAT_TYPES.VIDEO });
        expect(config.output_schema).toBe('phase');
        expect(config.thinking_enabled).toBe(true);
        expect(config.research_mode).toBe('normal');
        expect(config.auto_thinking).toBe(true);
        expect(config.thinking_format).toBe('summary');
        expect(config.auto_search).toBe(true);
    });

    it('keeps base config for text and image', () => {
        for (const chatType of [CHAT_TYPES.TEXT, CHAT_TYPES.IMAGE]) {
            const config = buildFeatureConfig({ model: 'qwen3.7-max', chatType });
            expect(config.output_schema).toBe('phase');
            expect(config.thinking_enabled).toBe(false);
            expect(config.research_mode).toBeUndefined();
            expect(config.auto_thinking).toBeUndefined();
            expect(config.thinking_format).toBeUndefined();
            expect(config.auto_search).toBeUndefined();
        }
    });

    it('keeps thinking locked for qwen3.8-max-preview even on text', () => {
        const config = buildFeatureConfig({ model: 'qwen3.8-max-preview', chatType: CHAT_TYPES.TEXT });
        expect(config.thinking_enabled).toBe(true);
    });
});
