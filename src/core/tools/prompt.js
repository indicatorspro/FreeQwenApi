// Построение системной инструкции с описанием инструментов.
//
// Веб-API Qwen Chat не принимает поле `tools`, поэтому вызовы эмулируются через
// промпт. Формат берётся из штатного chat-template Qwen (<tools> + <tool_call>):
// модель на нём обучена, и попадание в него на порядок стабильнее, чем в
// самодельные JSON-схемы ответа.

import { config } from '../../config/index.js';
import { logDebug, logWarn } from '../../shared/logger.js';

/** Уровни компактности: применяются по очереди, пока блок не влезет в бюджет. */
const COMPACTION_LEVELS = [
    { descriptionLimit: 400, propertyDescriptionLimit: 160, maxDepth: 4, keepEnums: true },
    { descriptionLimit: 200, propertyDescriptionLimit: 80, maxDepth: 3, keepEnums: true },
    { descriptionLimit: 100, propertyDescriptionLimit: 0, maxDepth: 2, keepEnums: false },
    { descriptionLimit: 60, propertyDescriptionLimit: 0, maxDepth: 1, keepEnums: false }
];

function truncate(value, maxLength) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!maxLength || text.length <= maxLength) return text;
    return `${text.slice(0, maxLength).trimEnd()}…`;
}

/**
 * Ужимает JSON Schema до размера, пригодного для промпта.
 * Сохраняет то, без чего модель не соберёт корректный вызов: type, enum,
 * required и имена свойств.
 */
function compactSchema(schema, level, depth = 0) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) {
        return schema.slice(0, 20).map(item => compactSchema(item, level, depth + 1));
    }

    const out = {};
    if (schema.type !== undefined) out.type = schema.type;
    if (level.keepEnums && Array.isArray(schema.enum)) out.enum = schema.enum.slice(0, 30);
    if (Array.isArray(schema.required) && schema.required.length > 0) out.required = schema.required;
    if (schema.default !== undefined) out.default = schema.default;

    const descriptionLimit = depth === 0 ? level.descriptionLimit : level.propertyDescriptionLimit;
    if (schema.description && descriptionLimit > 0) {
        out.description = truncate(schema.description, descriptionLimit);
    }

    if (depth >= level.maxDepth) {
        // Глубже не идём: оставляем только перечень свойств, без их схем.
        if (schema.properties && typeof schema.properties === 'object') {
            out.properties = Object.keys(schema.properties).reduce((acc, key) => {
                acc[key] = {};
                return acc;
            }, {});
        }
        return out;
    }

    if (schema.properties && typeof schema.properties === 'object') {
        out.properties = {};
        for (const [name, property] of Object.entries(schema.properties)) {
            out.properties[name] = compactSchema(property, level, depth + 1);
        }
    }
    if (schema.items) out.items = compactSchema(schema.items, level, depth + 1);
    if (schema.oneOf) out.oneOf = compactSchema(schema.oneOf, level, depth + 1);
    if (schema.anyOf) out.anyOf = compactSchema(schema.anyOf, level, depth + 1);
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        out.additionalProperties = compactSchema(schema.additionalProperties, level, depth + 1);
    }

    return out;
}

function renderToolLines(registry, level) {
    return registry.tools.map(tool => JSON.stringify({
        type: 'function',
        function: {
            name: tool.name,
            description: truncate(tool.description, level.descriptionLimit),
            parameters: compactSchema(tool.parameters, level)
        }
    }));
}

function typeLabel(schema) {
    if (!schema || typeof schema !== 'object') return 'any';
    if (Array.isArray(schema.type)) return schema.type.join('|');
    return schema.type || (schema.properties ? 'object' : 'any');
}

/**
 * Предельно плотный формат: сигнатура вместо JSON Schema.
 * Применяется, когда агент прислал столько инструментов, что схемы не влезают
 * ни в одном уровне сжатия — потерять имена нельзя, детали схем потерять можно.
 */
function renderSignatureLines(registry, { descriptionLimit = 0, includeParams = true } = {}) {
    return registry.tools.map(tool => {
        const description = truncate(tool.description, descriptionLimit);
        if (!includeParams) {
            return `- ${tool.name}${description ? ` — ${description}` : ''}`;
        }

        const properties = tool.parameters?.properties ?? {};
        const required = new Set(Array.isArray(tool.parameters?.required) ? tool.parameters.required : []);
        const params = Object.entries(properties)
            .map(([name, schema]) => `${name}${required.has(name) ? '*' : ''}: ${typeLabel(schema)}`)
            .join(', ');
        return `- ${tool.name}(${params})${description ? ` — ${description}` : ''}`;
    });
}

function totalLength(lines) {
    return lines.reduce((sum, line) => sum + line.length + 1, 0);
}

function choiceInstruction(choice, registry) {
    if (choice.mode === 'required' && choice.name) {
        const resolved = registry.resolve(choice.name);
        const name = resolved ? resolved.name : choice.name;
        return `\nYou MUST call the function "${name}" now. Do not answer in prose.`;
    }
    if (choice.mode === 'required') {
        return '\nYou MUST call at least one of the functions above now. Do not answer in prose.';
    }
    return '';
}

/**
 * Собирает блок описания инструментов для системного сообщения.
 * @param {import('./registry.js').ToolRegistry} registry
 * @param {{mode: string, name: string|null}} choice
 * @returns {string} — пустая строка, если инструментов нет или выбран режим none
 */
export function buildToolsPrompt(registry, choice = { mode: 'auto', name: null }) {
    if (!registry || registry.isEmpty || choice.mode === 'none') return '';

    const budget = config.tools.promptMaxChars;
    let lines = null;
    let usedLevel = 0;
    let signatureMode = false;
    let omitted = 0;

    for (let index = 0; index < COMPACTION_LEVELS.length; index++) {
        lines = renderToolLines(registry, COMPACTION_LEVELS[index]);
        usedLevel = index;
        if (totalLength(lines) <= budget) break;
    }

    if (totalLength(lines) > budget) {
        // JSON Schema не помещается ни в одном уровне — переходим на сигнатуры.
        // Имена инструментов урезаются в последнюю очередь: инструмент, которого
        // нет в промпте, для модели не существует вовсе.
        signatureMode = true;
        const fallbacks = [
            { descriptionLimit: 120, includeParams: true },
            { descriptionLimit: 0, includeParams: true },
            { descriptionLimit: 80, includeParams: false },
            { descriptionLimit: 0, includeParams: false }
        ];
        for (const options of fallbacks) {
            lines = renderSignatureLines(registry, options);
            if (totalLength(lines) <= budget) break;
        }

        if (totalLength(lines) > budget) {
            // Даже голые сигнатуры не влезают: обрезаем список, но говорим об этом
            // и в лог, и самой модели — молча «терять» инструменты нельзя.
            const kept = [];
            let size = 0;
            for (const line of lines) {
                if (size + line.length + 1 > budget) break;
                kept.push(line);
                size += line.length + 1;
            }
            omitted = lines.length - kept.length;
            lines = kept;
        }

        logWarn(`Схемы ${registry.size} инструментов не помещаются в бюджет ${budget} символов: используется компактный формат сигнатур${omitted ? `, ${omitted} инструментов не попали в промпт` : ''}.`);
    } else if (usedLevel > 0) {
        logDebug(`Схемы инструментов сжаты до уровня ${usedLevel} (${totalLength(lines)} символов).`);
    }

    const formatNote = signatureMode
        ? 'You are provided with compact function signatures within <tools></tools> XML tags. `name*` marks a required argument:'
        : 'You are provided with function signatures within <tools></tools> XML tags:';

    const omittedNote = omitted > 0
        ? `\n(${omitted} more functions were omitted because the tool list is too large.)`
        : '';

    return `

# Tools

You may call one or more functions to assist with the user query.

${formatNote}
<tools>
${lines.join('\n')}
</tools>${omittedNote}

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call>

Rules:
- Use the function name exactly as written above, including any prefix.
- Put every argument inside the "arguments" object; never inline them into the name.
- Emit one <tool_call> block per call; several blocks in a row are allowed.
- Never invent results of a call: emit the call and stop.
- If no function is needed, answer normally without <tool_call> blocks.${choiceInstruction(choice, registry)}`;
}

/**
 * Дописывает блок инструментов к системному сообщению пользователя.
 * @param {string|null} systemMessage
 * @param {import('./registry.js').ToolRegistry} registry
 * @param {{mode: string, name: string|null}} choice
 * @returns {string|null}
 */
export function applyToolsPrompt(systemMessage, registry, choice) {
    const block = buildToolsPrompt(registry, choice);
    if (!block) return systemMessage ?? null;
    return `${systemMessage ?? ''}${block}`.trim();
}

/**
 * Корректирующее сообщение для повторной попытки, когда модель вернула
 * несуществующий инструмент или неразбираемые аргументы.
 */
export function buildRepairPrompt(problems, registry) {
    const details = problems.map(problem => `- ${problem.reason}`).join('\n');
    return `Your previous reply was not a valid tool call.

${details}

Available function names:
${registry.names.join(', ')}

Reply again with a correct <tool_call> block, or answer in prose if no function is needed.`;
}
