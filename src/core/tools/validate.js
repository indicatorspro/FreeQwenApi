// Validation and repair of call before sending to client.
//
// Client (Codex, Claude Code, OpenCode) executes call literally: wrong name
// or string "5" instead of number crashes their side, not ours. Therefore name
// is resolved via registry, and arguments are coerced to types from JSON Schema.

import { config } from '../../config/index.js';
import { toolCallId } from '../../shared/ids.js';
import { parseJsonLoose } from './parser.js';

function schemaTypes(schema) {
    if (!schema || typeof schema !== 'object') return [];
    if (Array.isArray(schema.type)) return schema.type;
    if (typeof schema.type === 'string') return [schema.type];
    if (schema.properties) return ['object'];
    if (schema.items) return ['array'];
    return [];
}

function matchesType(value, type) {
    switch (type) {
        case 'string': return typeof value === 'string';
        case 'number': return typeof value === 'number' && Number.isFinite(value);
        case 'integer': return typeof value === 'number' && Number.isInteger(value);
        case 'boolean': return typeof value === 'boolean';
        case 'array': return Array.isArray(value);
        case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
        case 'null': return value === null;
        default: return true;
    }
}

/** Coerces value to type from schema; returns original if cannot coerce. */
function coerceValue(value, schema) {
    const types = schemaTypes(schema);
    if (types.length === 0) return value;
    if (types.some(type => matchesType(value, type))) {
        // Already suitable type — but nested object/array fields should be checked.
        if (matchesType(value, 'object') && schema.properties) return coerceObject(value, schema);
        if (Array.isArray(value) && schema.items) return value.map(item => coerceValue(item, schema.items));
        return value;
    }

    const target = types[0];

    if ((target === 'number' || target === 'integer') && typeof value === 'string') {
        const parsed = Number(value.trim());
        if (Number.isFinite(parsed) && (target === 'number' || Number.isInteger(parsed))) return parsed;
    }

    if (target === 'boolean' && typeof value === 'string') {
        const lower = value.trim().toLowerCase();
        if (['true', 'yes', '1'].includes(lower)) return true;
        if (['false', 'no', '0'].includes(lower)) return false;
    }

    if (target === 'string' && (typeof value === 'number' || typeof value === 'boolean')) {
        return String(value);
    }

    if ((target === 'object' || target === 'array') && typeof value === 'string') {
        const parsed = parseJsonLoose(value);
        if (parsed !== undefined && matchesType(parsed, target)) {
            return target === 'object' ? coerceObject(parsed, schema) : parsed;
        }
    }

    // The model often returns a single value where an array of one element is expected.
    if (target === 'array' && value !== null && value !== undefined) {
        const items = schema.items ? coerceValue(value, schema.items) : value;
        return [items];
    }

    return value;
}

function coerceObject(value, schema) {
    if (!schema?.properties || typeof value !== 'object' || value === null) return value;
    const out = Array.isArray(value) ? value : { ...value };
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
        if (key in out) out[key] = coerceValue(out[key], propertySchema);
    }
    return out;
}

function missingRequired(args, schema) {
    if (!Array.isArray(schema?.required)) return [];
    return schema.required.filter(key => args[key] === undefined);
}

/**
 * Parses arguments no matter how the model sent them.
 * @returns {{args: object}|{error: string}}
 */
function readArguments(raw, tool) {
    if (raw === undefined || raw === null || raw === '') return { args: {} };

    if (typeof raw === 'object' && !Array.isArray(raw)) return { args: raw };

    if (typeof raw === 'string') {
        const parsed = parseJsonLoose(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { args: parsed };

        // Single required string parameter — tolerantly accept
        // a "bare" value instead of an object.
        const required = Array.isArray(tool.parameters?.required) ? tool.parameters.required : [];
        if (required.length === 1) {
            const schema = tool.parameters?.properties?.[required[0]];
            if (schemaTypes(schema).includes('string')) {
                return { args: { [required[0]]: raw } };
            }
        }
        return { error: `arguments of function "${tool.name}" are not a JSON object` };
    }

    return { error: `arguments of function "${tool.name}" have an unsupported type` };
}

/**
 * @typedef {{id: string, type: 'function', index: number, function: {name: string, arguments: string}}} OpenAIToolCall
 */

/**
 * Validates raw calls and normalizes them to the OpenAI format.
 * @param {Array<{id: string|null, name: string, arguments: unknown}>} rawCalls
 * @param {import('./registry.js').ToolRegistry} registry
 * @returns {{calls: OpenAIToolCall[], problems: Array<{name: string, reason: string}>}}
 */
export function validateToolCalls(rawCalls, registry) {
    const calls = [];
    const problems = [];

    for (const raw of rawCalls || []) {
        const tool = registry.resolve(raw.name);
        if (!tool) {
            problems.push({
                name: raw.name,
                reason: `Function "${raw.name}" is not declared by the client.`
            });
            continue;
        }

        const parsed = readArguments(raw.arguments, tool);
        if (parsed.error) {
            problems.push({ name: tool.name, reason: parsed.error });
            continue;
        }

        const args = config.tools.coerceArguments
            ? coerceObject(parsed.args, tool.parameters)
            : parsed.args;

        const missing = missingRequired(args, tool.parameters);
        if (missing.length > 0) {
            problems.push({
                name: tool.name,
                reason: `call "${tool.name}" is missing required arguments: ${missing.join(', ')}.`
            });
            continue;
        }

        calls.push({
            id: raw.id || toolCallId(),
            type: 'function',
            index: calls.length,
            function: { name: tool.name, arguments: JSON.stringify(args) }
        });
    }

    return { calls, problems };
}
