import { describe, it, expect } from 'vitest';

import { buildToolRegistry } from '../../src/core/tools/registry.js';
import { applyToolsPrompt, buildToolsPrompt } from '../../src/core/tools/prompt.js';
import { config } from '../../src/config/index.js';

const registry = buildToolRegistry([
    { function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }
], null);

describe('buildToolsPrompt', () => {
    it('describes tools in the native Qwen format', () => {
        const prompt = buildToolsPrompt(registry, { mode: 'auto', name: null });
        expect(prompt).toContain('<tools>');
        expect(prompt).toContain('<tool_call>');
        expect(prompt).toContain('"read_file"');
    });

    it('does not contain hardcoding for a specific agent', () => {
        const prompt = buildToolsPrompt(registry, { mode: 'auto', name: null });
        expect(prompt.toLowerCase()).not.toContain('hermes');
        expect(prompt).not.toContain('skill_view');
    });

    it('preserves the full name with MCP prefix', () => {
        const namespaced = buildToolRegistry([{ function: { name: 'mcp__github__create_pr' } }], null);
        expect(buildToolsPrompt(namespaced, { mode: 'auto', name: null })).toContain('mcp__github__create_pr');
    });

    it('is empty when tool_choice=none', () => {
        expect(buildToolsPrompt(registry, { mode: 'none', name: null })).toBe('');
    });

    it('is empty without tools', () => {
        expect(buildToolsPrompt(buildToolRegistry([], null), { mode: 'auto', name: null })).toBe('');
    });

    it('requires a specific function when tool_choice has a name', () => {
        const prompt = buildToolsPrompt(registry, { mode: 'required', name: 'read_file' });
        expect(prompt).toContain('MUST call the function "read_file"');
    });

    it('requires any call when tool_choice=required', () => {
        expect(buildToolsPrompt(registry, { mode: 'required', name: null })).toContain('MUST call at least one');
    });

    it('fits within the character budget on a large tool set', () => {
        const many = buildToolRegistry(
            Array.from({ length: 120 }, (_, index) => ({
                function: {
                    name: `mcp__server__tool_${index}`,
                    description: 'A very long tool description. '.repeat(30),
                    parameters: {
                        type: 'object',
                        properties: Object.fromEntries(Array.from({ length: 12 }, (_, p) => [
                            `param_${p}`,
                            { type: 'string', description: 'Parameter description. '.repeat(20) }
                        ])),
                        required: ['param_0']
                    }
                }
            })),
            null
        );

        const prompt = buildToolsPrompt(many, { mode: 'auto', name: null });
        expect(prompt.length).toBeLessThan(config.tools.promptMaxChars * 1.5);
        // Names are not lost even at maximum compression — otherwise the model
        // will not know the tool exists.
        expect(prompt).toContain('mcp__server__tool_119');
    });
});

describe('applyToolsPrompt', () => {
    it('appends the block to the system message', () => {
        const result = applyToolsPrompt('You are an assistant.', registry, { mode: 'auto', name: null });
        expect(result.startsWith('You are an assistant.')).toBe(true);
        expect(result).toContain('<tools>');
    });

    it('returns the original message without tools', () => {
        expect(applyToolsPrompt('You are an assistant.', buildToolRegistry([], null), { mode: 'auto', name: null }))
            .toBe('You are an assistant.');
    });
});
