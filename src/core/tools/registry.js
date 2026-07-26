// Реестр инструментов запроса: нормализация того, что прислал клиент, и
// разрешение имени, которое вернула модель.
//
// Агенты присылают инструменты в разных формах: OpenAI `tools`, устаревшие
// `functions`, а MCP-клиенты — с префиксом сервера (`mcp__github__create_pr`,
// `github.create_pr`, `github/create_pr`). Модель регулярно отвечает коротким
// именем без префикса, поэтому одного точного сравнения недостаточно.

/** Разделители пространств имён, используемые MCP-клиентами. */
const NAMESPACE_SEPARATORS = ['__', '::', '/', '.', ':'];

function normalizeKey(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Короткое имя инструмента без префикса сервера. */
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
 * Реестр инструментов одного запроса.
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
            // Короткое имя регистрируем только если оно однозначно: два MCP-сервера
            // вполне могут отдать одинаковый `search`, и угадывать тут нельзя.
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
     * Находит инструмент по имени, которое вернула модель.
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

        // Модель ответила коротким именем, клиент ждёт полное (или наоборот).
        const short = this.byShortName.get(normalizeKey(stripNamespace(name)));
        if (short) return short;

        return null;
    }

    has(name) {
        return this.resolve(name) !== null;
    }
}

/**
 * Собирает реестр из полей запроса OpenAI.
 * @param {unknown} tools — поле `tools`
 * @param {unknown} functions — устаревшее поле `functions`
 * @returns {ToolRegistry}
 */
export function buildToolRegistry(tools, functions) {
    const source = Array.isArray(tools) && tools.length > 0
        ? tools
        : (Array.isArray(functions) ? functions : []);

    const definitions = [];
    const seen = new Set();

    for (const entry of source) {
        // Не-функциональные инструменты (web_search, code_interpreter и т.п.)
        // прокси выполнить не может — молча пропускаем, чтобы не сбивать модель.
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
 * Нормализует поле `tool_choice` запроса.
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
