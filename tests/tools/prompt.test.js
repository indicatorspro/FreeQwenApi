import { describe, it, expect } from 'vitest';

import { buildToolRegistry } from '../../src/core/tools/registry.js';
import { applyToolsPrompt, buildToolsPrompt } from '../../src/core/tools/prompt.js';
import { config } from '../../src/config/index.js';

const registry = buildToolRegistry([
    { function: { name: 'read_file', description: 'Прочитать файл', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }
], null);

describe('buildToolsPrompt', () => {
    it('описывает инструменты в нативном формате Qwen', () => {
        const prompt = buildToolsPrompt(registry, { mode: 'auto', name: null });
        expect(prompt).toContain('<tools>');
        expect(prompt).toContain('<tool_call>');
        expect(prompt).toContain('"read_file"');
    });

    it('не содержит хардкода под конкретного агента', () => {
        const prompt = buildToolsPrompt(registry, { mode: 'auto', name: null });
        expect(prompt.toLowerCase()).not.toContain('hermes');
        expect(prompt).not.toContain('skill_view');
    });

    it('сохраняет полное имя с MCP-префиксом', () => {
        const namespaced = buildToolRegistry([{ function: { name: 'mcp__github__create_pr' } }], null);
        expect(buildToolsPrompt(namespaced, { mode: 'auto', name: null })).toContain('mcp__github__create_pr');
    });

    it('пуст при tool_choice=none', () => {
        expect(buildToolsPrompt(registry, { mode: 'none', name: null })).toBe('');
    });

    it('пуст без инструментов', () => {
        expect(buildToolsPrompt(buildToolRegistry([], null), { mode: 'auto', name: null })).toBe('');
    });

    it('требует конкретную функцию при tool_choice с именем', () => {
        const prompt = buildToolsPrompt(registry, { mode: 'required', name: 'read_file' });
        expect(prompt).toContain('MUST call the function "read_file"');
    });

    it('требует любой вызов при tool_choice=required', () => {
        expect(buildToolsPrompt(registry, { mode: 'required', name: null })).toContain('MUST call at least one');
    });

    it('укладывается в бюджет символов на большом наборе инструментов', () => {
        const many = buildToolRegistry(
            Array.from({ length: 120 }, (_, index) => ({
                function: {
                    name: `mcp__server__tool_${index}`,
                    description: 'Очень длинное описание инструмента. '.repeat(30),
                    parameters: {
                        type: 'object',
                        properties: Object.fromEntries(Array.from({ length: 12 }, (_, p) => [
                            `param_${p}`,
                            { type: 'string', description: 'Описание параметра. '.repeat(20) }
                        ])),
                        required: ['param_0']
                    }
                }
            })),
            null
        );

        const prompt = buildToolsPrompt(many, { mode: 'auto', name: null });
        expect(prompt.length).toBeLessThan(config.tools.promptMaxChars * 1.5);
        // Имена не теряются даже при максимальном сжатии — иначе модель не узнает
        // о существовании инструмента.
        expect(prompt).toContain('mcp__server__tool_119');
    });
});

describe('applyToolsPrompt', () => {
    it('дописывает блок к системному сообщению', () => {
        const result = applyToolsPrompt('Ты ассистент.', registry, { mode: 'auto', name: null });
        expect(result.startsWith('Ты ассистент.')).toBe(true);
        expect(result).toContain('<tools>');
    });

    it('возвращает исходное сообщение без инструментов', () => {
        expect(applyToolsPrompt('Ты ассистент.', buildToolRegistry([], null), { mode: 'auto', name: null }))
            .toBe('Ты ассистент.');
    });
});
