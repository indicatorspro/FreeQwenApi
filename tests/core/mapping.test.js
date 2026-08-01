import { describe, it, expect } from 'vitest';

import { CANONICAL_MODELS, MODEL_MAPPING, mapModel } from '../../src/core/models/mapping.js';

describe('mapModel', () => {
    it('passes a canonical name through unchanged', () => {
        expect(mapModel('qwen3.7-max')).toBe('qwen3.7-max');
    });

    it('translates OpenAI-style aliases', () => {
        expect(mapModel('qwen-max')).toBe('qwen3-max');
        expect(mapModel('qwen-vl-plus')).toBe('qwen3-vl-plus');
    });

    it('is case-insensitive', () => {
        expect(mapModel('Qwen3-Max')).toBe('qwen3-max');
        expect(mapModel('QWEN3.7-MAX')).toBe('qwen3.7-max');
    });

    it('returns the default model for an unknown name', () => {
        expect(mapModel('gpt-4o', 'qwen3.7-max')).toBe('qwen3.7-max');
    });

    it('returns the default model if no name is provided', () => {
        expect(mapModel(null, 'qwen3.7-plus')).toBe('qwen3.7-plus');
    });
});

describe('model table', () => {
    it('contains no duplicate canonical names', () => {
        expect(new Set(CANONICAL_MODELS).size).toBe(CANONICAL_MODELS.length);
    });

    // Regression: previously qwen3.5-plus and qwen3.5-397b-a17b were declared twice,
    // and the second declaration silently overwrote the first one's aliases.
    it('preserves aliases of models that were declared twice', () => {
        expect(MODEL_MAPPING['qwen3.5']).toBe('qwen3.5-plus');
        expect(MODEL_MAPPING['qwen3.5-plus-latest']).toBe('qwen3.5-plus');
        expect(MODEL_MAPPING['qwen3.5-huge']).toBe('qwen3.5-397b-a17b');
        expect(MODEL_MAPPING['Qwen3.5-397B-A17B']).toBe('qwen3.5-397b-a17b');
    });

    it('all aliases point to existing models', () => {
        const canonical = new Set(CANONICAL_MODELS);
        for (const target of Object.values(MODEL_MAPPING)) {
            expect(canonical.has(target)).toBe(true);
        }
    });
});
