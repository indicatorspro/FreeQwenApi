import { describe, it, expect } from 'vitest';

import { CANONICAL_MODELS, MODEL_MAPPING, mapModel } from '../../src/core/models/mapping.js';

describe('mapModel', () => {
    it('пропускает каноническое имя без изменений', () => {
        expect(mapModel('qwen3.7-max')).toBe('qwen3.7-max');
    });

    it('переводит алиасы OpenAI-стиля', () => {
        expect(mapModel('qwen-max')).toBe('qwen3-max');
        expect(mapModel('qwen-vl-plus')).toBe('qwen3-vl-plus');
    });

    it('не зависит от регистра', () => {
        expect(mapModel('Qwen3-Max')).toBe('qwen3-max');
        expect(mapModel('QWEN3.7-MAX')).toBe('qwen3.7-max');
    });

    it('возвращает модель по умолчанию для неизвестного имени', () => {
        expect(mapModel('gpt-4o', 'qwen3.7-max')).toBe('qwen3.7-max');
    });

    it('возвращает модель по умолчанию, если имя не передано', () => {
        expect(mapModel(null, 'qwen3.7-plus')).toBe('qwen3.7-plus');
    });
});

describe('таблица моделей', () => {
    it('не содержит дубликатов канонических имён', () => {
        expect(new Set(CANONICAL_MODELS).size).toBe(CANONICAL_MODELS.length);
    });

    // Регрессия: раньше qwen3.5-plus и qwen3.5-397b-a17b объявлялись дважды,
    // и второе объявление молча затирало алиасы первого.
    it('сохраняет алиасы моделей, объявлявшихся дважды', () => {
        expect(MODEL_MAPPING['qwen3.5']).toBe('qwen3.5-plus');
        expect(MODEL_MAPPING['qwen3.5-plus-latest']).toBe('qwen3.5-plus');
        expect(MODEL_MAPPING['qwen3.5-huge']).toBe('qwen3.5-397b-a17b');
        expect(MODEL_MAPPING['Qwen3.5-397B-A17B']).toBe('qwen3.5-397b-a17b');
    });

    it('все алиасы указывают на существующие модели', () => {
        const canonical = new Set(CANONICAL_MODELS);
        for (const target of Object.values(MODEL_MAPPING)) {
            expect(canonical.has(target)).toBe(true);
        }
    });
});
