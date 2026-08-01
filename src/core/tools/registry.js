// Request tool registry: normalization of what client sent, and
// resolution of name returned by model.
//
// Agents send tools in different forms: OpenAI `tools`, legacy
// `functions`, and MCP clients — with server prefix (`mcp__github__create_pr`,
// `github.create_pr`, `github/create_pr`). Model regularly responds with short
// name without prefix, so single exact comparison is not enough.

/** Namespace separators used by MCP clients. */
const NAMESPACE_SEPARATORS = ['__', '::', '/', '.', ':'];

function normalizeKey(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Short tool name without server prefix. */
export function stripNamespace(name) {
    let result = String(name);
    for (const separator of NAMESPACE_SEPARATORS) {
        const index = result.lastIndexOf(separator);
        if (index >= 0 && index + separator.length < result.length) {
            result = result.slice(index + separator.length);
        }
    }
    return result;
}

function normalizeParameters(parameters) {
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
        return { type: 'object', properties: {} };
    }
    if (!parameters.type && !parameters.properties && !parameters.oneOf && !parameters.anyOf) {
        return { type: 'object', properties: {} };
    }
    return parameters;
}

function toToolDefinition(entry) {
    if (!entry || typeof entry !== 'object') return null;

    // { type: 'function', function: {...} } | { name, description, parameters }
    const fn = entry.function && typeof entry.function === 'object' ? entry.function : entry;
    const name = typeof fn.name === 'string' ? fn.name.trim() : '';
    if (!name) return null;

    return {
        name,
        description: typeof fn.description === 'string' ? fn.description : '',
        parameters: normalizeParameters(fn.parameters ?? fn.input_schema),
        strict: fn.strict === true
    };
}

/**
 * Tool registry for one request.
 * @typedef {{name: string, description: string, parameters: object, strict: boolean}} ToolDefinition
 */
export class ToolRegistry {
    /** @param {ToolDefinition[]} definitions */
    constructor(definitions = []) {
        /** @type {ToolDefinition[]} */
        this.tools = definitions;
        this.byName = new Map();
        this.byNormalized = new Map();
        this.byShortName = new Map();

        for (const tool of definitions) {
            this.byName.set(tool.name, tool);

            const normalized = normalizeKey(tool.name);
            if (!this.byNormalized.has(normalized)) this.byNormalized.set(normalized, tool);

            const short = normalizeKey(stripNamespace(tool.name));
            // A short name is registered only if it is unambiguous: two MCP servers
            // may well return the same `search`, and guessing here is not acceptable.
            if (this.byShortName.has(short)) this.byShortName.set(short, null);
            else this.byShortName.set(short, tool);
        }
    }

    get size() {
        return this.tools.length;
    }

    get isEmpty() {
        return this.tools.length === 0;
    }

    /** @returns {string[]} */
    get names() {
        return this.tools.map(tool => tool.name);
    }

    /**
     * Finds a tool by the name returned by the model.
     * @param {string} rawName
     * @returns {ToolDefinition | null}
     */
    resolve(rawName) {
        if (typeof rawName !== 'string' || !rawName.trim()) return null;
        const name = rawName.trim();

        const exact = this.byName.get(name);
        if (exact) return exact;

        const normalized = this.byNormalized.get(normalizeKey(name));
        if (normalized) return normalized;

        // The model responded with a short name, while the client expects the full one (or vice versa).
        const short = this.byShortName.get(normalizeKey(stripNamespace(name)));
        if (short) return short;

        return null;
    }

    has(name) {
        return this.resolve(name) !== null;
    }
}

/**
 * Builds a registry from the fields of an OpenAI request.
 * @param {unknown} tools — the `tools` field
 * @param {unknown} functions — the deprecated `functions` field
 * @returns {ToolRegistry}
 */
export function buildToolRegistry(tools, functions) {
    const source = Array.isArray(tools) && tools.length > 0
        ? tools
        : (Array.isArray(functions) ? functions : []);

    const definitions = [];
    const seen = new Set();

    for (const entry of source) {
        // Non-function tools (web_search, code_interpreter, etc.)
        // cannot be executed by the proxy — silently skip them to avoid confusing the model.
        if (entry && typeof entry === 'object' && entry.type && entry.type !== 'function' && !entry.function) {
            continue;
        }

        const definition = toToolDefinition(entry);
        if (!definition || seen.has(definition.name)) continue;

        seen.add(definition.name);
        definitions.push(definition);
    }

    return new ToolRegistry(definitions);
}

/**
 * Normalizes the request's `tool_choice` field.
 * @param {unknown} toolChoice
 * @returns {{mode: 'auto'|'none'|'required', name: string|null}}
 */
export function normalizeToolChoice(toolChoice) {
    if (toolChoice === undefined || toolChoice === null) return { mode: 'auto', name: null };

    if (typeof toolChoice === 'string') {
        const value = toolChoice.trim().toLowerCase();
        if (value === 'none') return { mode: 'none', name: null };
        if (value === 'required' || value === 'any') return { mode: 'required', name: null };
        return { mode: 'auto', name: null };
    }

    if (typeof toolChoice === 'object') {
        const name = toolChoice.function?.name || toolChoice.name || null;
        if (name) return { mode: 'required', name: String(name) };
        if (toolChoice.type === 'any' || toolChoice.type === 'required') return { mode: 'required', name: null };
        if (toolChoice.type === 'none') return { mode: 'none', name: null };
    }

    return { mode: 'auto', name: null };
}
