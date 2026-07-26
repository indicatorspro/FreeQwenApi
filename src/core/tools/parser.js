// Извлечение вызовов инструментов из текста ответа модели.
//
// Qwen отвечает как минимум четырьмя способами: штатным <tool_call> из своего
// chat-template, тем же JSON в markdown-фенсе, объектом {"tool_calls": [...]}
// и голым {"name": ..., "arguments": ...}. Плюс регулярно теряет закрывающую
// скобку в конце. Парсер обязан принимать всё перечисленное, иначе агент
// получает «модель просто поговорила» вместо вызова.

const TOOL_CALL_TAG = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/gi;
const FENCE = /```(?:json|tool_code|tool_call)?\s*([\s\S]*?)```/gi;

/** Маркеры, с которых может начинаться вызов — нужны и стриминг-фильтру. */
export const TOOL_CALL_MARKERS = Object.freeze([
    '<tool_call>',
    '```json',
    '```tool_call',
    '{"tool_calls"',
    '{ "tool_calls"',
    '{"name"',
    '{ "name"',
    '{"function_call"',
    '{"tool_call"'
]);

function stripTrailingCommas(text) {
    return text.replace(/,\s*([}\]])/g, '$1');
}

/** Достраивает скобки, потерянные моделью в конце ответа. */
function closeUnbalanced(text) {
    const stack = [];
    let inString = false;
    let escaped = false;

    for (const char of text) {
        if (escaped) { escaped = false; continue; }
        if (char === '\\') { escaped = true; continue; }
        if (char === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (char === '{' || char === '[') stack.push(char);
        else if (char === '}' && stack[stack.length - 1] === '{') stack.pop();
        else if (char === ']' && stack[stack.length - 1] === '[') stack.pop();
    }

    if (inString) text += '"';
    let result = text;
    while (stack.length > 0) {
        result += stack.pop() === '{' ? '}' : ']';
    }
    return result;
}

/**
 * Разбирает JSON, последовательно применяя ремонтные стратегии.
 * @returns {unknown|undefined} — undefined, если не удалось ни одной
 */
export function parseJsonLoose(raw) {
    if (typeof raw !== 'string') return undefined;
    const text = raw.trim();
    if (!text) return undefined;

    const candidates = [text];

    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first > 0 && last > first) candidates.push(text.slice(first, last + 1));

    candidates.push(stripTrailingCommas(text));
    candidates.push(closeUnbalanced(text));
    candidates.push(closeUnbalanced(stripTrailingCommas(text)));

    // Частая поломка Qwen: закрывается массив, но не объект аргументов.
    if (/^\s*\{\s*"tool_calls"\s*:\s*\[\s*\{/.test(text) && /\}\]\}\s*$/.test(text)) {
        candidates.push(text.replace(/\}\]\}\s*$/, '}}]}'));
    }

    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object') return parsed;
        } catch {
            // Пробуем следующую стратегию ремонта.
        }
    }
    return undefined;
}

/** Приводит разобранный объект к списку сырых вызовов. */
function toRawCalls(parsed) {
    if (!parsed || typeof parsed !== 'object') return [];

    if (Array.isArray(parsed)) {
        return parsed.flatMap(item => toRawCalls(item));
    }

    if (Array.isArray(parsed.tool_calls)) {
        return parsed.tool_calls.flatMap(item => toRawCalls(item));
    }

    if (parsed.function_call || parsed.tool_call) {
        return toRawCalls(parsed.function_call || parsed.tool_call);
    }

    const fn = parsed.function && typeof parsed.function === 'object' ? parsed.function : parsed;
    const name = fn.name || fn.tool || fn.tool_name || parsed.name;
    if (typeof name !== 'string' || !name.trim()) return [];

    const args = fn.arguments ?? fn.args ?? fn.input ?? fn.parameters ?? parsed.arguments ?? {};
    return [{ id: typeof parsed.id === 'string' ? parsed.id : null, name: name.trim(), arguments: args }];
}

function collectTagged(content, result) {
    TOOL_CALL_TAG.lastIndex = 0;
    let match;
    let firstIndex = -1;

    while ((match = TOOL_CALL_TAG.exec(content)) !== null) {
        const parsed = parseJsonLoose(match[1]);
        const calls = toRawCalls(parsed);
        if (calls.length > 0) {
            if (firstIndex < 0) firstIndex = match.index;
            result.push(...calls);
        }
    }
    return firstIndex;
}

function collectFenced(content, result) {
    FENCE.lastIndex = 0;
    let match;
    let firstIndex = -1;

    while ((match = FENCE.exec(content)) !== null) {
        const parsed = parseJsonLoose(match[1]);
        const calls = toRawCalls(parsed);
        if (calls.length > 0) {
            if (firstIndex < 0) firstIndex = match.index;
            result.push(...calls);
        }
    }
    return firstIndex;
}

/**
 * Извлекает вызовы инструментов из ответа модели.
 * @param {unknown} content
 * @returns {{calls: Array<{id: string|null, name: string, arguments: unknown}>, text: string} | null}
 *          text — проза до первого вызова (OpenAI разрешает её вместе с tool_calls)
 */
export function extractToolCalls(content) {
    if (typeof content !== 'string') return null;
    const text = content.trim();
    if (!text) return null;

    const calls = [];

    // 1. Штатный формат Qwen: <tool_call>{...}</tool_call>
    const taggedIndex = collectTagged(text, calls);
    if (calls.length > 0) {
        return { calls, text: text.slice(0, taggedIndex).trim() };
    }

    // 2. Тот же JSON, но завёрнутый в markdown-фенс.
    const fencedIndex = collectFenced(text, calls);
    if (calls.length > 0) {
        return { calls, text: text.slice(0, fencedIndex).trim() };
    }

    // 3. Голый JSON во всём ответе.
    const parsed = parseJsonLoose(text);
    const bare = toRawCalls(parsed);
    if (bare.length > 0) {
        return { calls: bare, text: '' };
    }

    return null;
}

/**
 * Может ли текст быть началом вызова инструмента.
 * Используется стриминг-фильтром, чтобы не отдавать клиенту служебный JSON.
 */
export function looksLikeToolCallStart(text) {
    const trimmed = text.trimStart();
    if (!trimmed) return false;
    return TOOL_CALL_MARKERS.some(marker =>
        trimmed.startsWith(marker) || marker.startsWith(trimmed.slice(0, marker.length))
    );
}
