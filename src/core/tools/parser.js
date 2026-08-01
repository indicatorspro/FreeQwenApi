// Tool call parser: extracts tool calls from model response.
//
// Supports four formats (in priority order):
// 1. <tool_call> tag — most common
// 2. Markdown fence — ```json {"tool_calls":[...]} ```
// 3. Bare JSON — {"name":"...","arguments":{...}}
// 4. DSML (XML) — <tool_calls><invoke name="...">
//
// Source: heymoma + FreeQwenApi_ForgetMeAI (DSML support).

import crypto from 'crypto';
import { parseDsmlToolCalls, looksLikeDsml } from './dsml.js';

/** Removes code fences (```json ... ```). */
function stripCodeFences(text) {
    const trimmed = String(text || '').trim();
    const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fence ? fence[1].trim() : trimmed;
}

/** Serializes arguments to JSON string. */
function serializeArguments(rawArgs) {
    if (typeof rawArgs === 'string') {
        const trimmed = rawArgs.trim();
        if (!trimmed) return '{}';
        try {
            return JSON.stringify(JSON.parse(trimmed));
        } catch {
            return rawArgs;
        }
    }
    return JSON.stringify(rawArgs || {});
}

/** Normalizes tool calls to OpenAI format. */
function normalizeToolCalls(calls) {
    if (!Array.isArray(calls) || calls.length === 0) return null;

    const normalized = calls.map((call, index) => {
        const name = call?.name || call?.tool || call?.function?.name;
        const rawArgs = call?.arguments ?? call?.args ?? call?.input ?? call?.function?.arguments ?? {};

        if (!name) return null;

        return {
            id: call.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
            type: 'function',
            function: { name, arguments: serializeArguments(rawArgs) },
            index: Number.isInteger(call.index) ? call.index : index
        };
    }).filter(Boolean);

    return normalized.length > 0 ? normalized : null;
}

/**
 * Parses <tool_call> tag format.
 * @param {string} content
 * @returns {Array|null}
 */
function parseToolCallTag(content) {
    const matches = [...content.matchAll(/([\s\S]*?)<\/tool_call>/gi)];
    if (matches.length === 0) return null;

    const calls = [];
    for (const match of matches) {
        const inner = stripCodeFences(match[1]);
        try {
            const parsed = JSON.parse(inner);
            calls.push(parsed);
        } catch {
            // Try to extract JSON from mixed content.
            const jsonMatch = inner.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    calls.push(JSON.parse(jsonMatch[0]));
                } catch { /* skip */ }
            }
        }
    }

    return normalizeToolCalls(calls);
}

/**
 * Parses markdown fence format.
 * @param {string} content
 * @returns {Array|null}
 */
function parseMarkdownFence(content) {
    const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (!fenceMatch) return null;

    const inner = fenceMatch[1].trim();
    try {
        const parsed = JSON.parse(inner);

        // Could be {"tool_calls": [...]} or direct array.
        if (parsed.tool_calls) {
            return normalizeToolCalls(parsed.tool_calls);
        }
        if (Array.isArray(parsed)) {
            return normalizeToolCalls(parsed);
        }
        if (parsed.name || parsed.function?.name) {
            return normalizeToolCalls([parsed]);
        }
    } catch { /* not JSON */ }

    return null;
}

/**
 * Parses bare JSON format.
 * @param {string} content
 * @returns {Array|null}
 */
function parseBareJson(content) {
    const trimmed = stripCodeFences(content);

    // Try direct parse.
    try {
        const parsed = JSON.parse(trimmed);

        if (parsed.tool_calls) {
            return normalizeToolCalls(parsed.tool_calls);
        }
        if (Array.isArray(parsed)) {
            return normalizeToolCalls(parsed);
        }
        if (parsed.name || parsed.function?.name) {
            return normalizeToolCalls([parsed]);
        }
    } catch { /* not JSON */ }

    // Try to extract JSON object from text.
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.name || parsed.function?.name) {
                return normalizeToolCalls([parsed]);
            }
            if (parsed.tool_calls) {
                return normalizeToolCalls(parsed.tool_calls);
            }
        } catch { /* skip */ }
    }

    return null;
}

/**
 * Main parser: tries all formats in priority order.
 *
 * @param {string} content — model response text
 * @returns {Array<{id: string, type: string, function: {name: string, arguments: string}, index: number}>|null}
 */
export function parseToolCalls(content) {
    if (!content || typeof content !== 'string') return null;

    // 1. <tool_call> tag (highest priority).
    const tagResult = parseToolCallTag(content);
    if (tagResult) return tagResult;

    // 2. Markdown fence.
    const fenceResult = parseMarkdownFence(content);
    if (fenceResult) return fenceResult;

    // 3. Bare JSON.
    const jsonResult = parseBareJson(content);
    if (jsonResult) return jsonResult;

    // 4. DSML (XML) — check last as it's legacy.
    if (looksLikeDsml(content)) {
        const dsmlResult = parseDsmlToolCalls(content);
        if (dsmlResult) return dsmlResult;
    }

    return null;
}

/**
 * Detects if content contains tool calls (quick check).
 * @param {string} content
 * @returns {boolean}
 */
export function hasToolCalls(content) {
    if (!content || typeof content !== 'string') return false;
    const lower = content.toLowerCase();
    return lower.includes('<tool_call>') ||
           lower.includes('"tool_calls"') ||
           lower.includes('"name"') && lower.includes('"arguments"') ||
           looksLikeDsml(content);
}

/**
 * Markers that may indicate the start of a tool call in a streamed chunk.
 * Used by the stream filter to hold back partial tool-call JSON.
 */
export const TOOL_CALL_MARKERS = ['<tool_call>', '{"tool_calls"', '{"name"', '```json'];


/**
 * Parses JSON with repair heuristics for truncated or slightly malformed
 * tool-call payloads. Returns undefined when the input is not JSON-like.
 */
export function parseJsonLoose(raw) {
    if (typeof raw !== 'string') return undefined;
    const text = raw.trim();
    if (!text) return undefined;
    if (!text.startsWith('{') && !text.startsWith('[')) return undefined;

    const direct = tryParseJson(text);
    if (direct !== undefined) return direct;

    const candidates = [
        text.replace(/,\s*([}\]])/g, '$1'),
        text.replace(/'\s*([}\]])/g, '$1'),
        text.replace(/]\s*}\s*$/, '}}]')
    ];

    for (const candidate of candidates) {
        const parsed = tryParseJson(candidate);
        if (parsed !== undefined) return parsed;
    }

    for (const candidate of candidates) {
        const parsed = tryParseJson(repairJsonBrackets(candidate));
        if (parsed !== undefined) return parsed;
    }

    return undefined;
}


function tryParseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function repairJsonBrackets(text) {
    const stack = [];
    let out = '';
    let inString = false;
    let escaped = false;

    for (const ch of text) {
        if (inString) {
            out += ch;
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
            out += ch;
            continue;
        }

        if (ch === '{' || ch === '[') {
            stack.push(ch);
            out += ch;
            continue;
        }

        if (ch === '}' || ch === ']') {
            const wanted = ch === '}' ? '{' : '[';
            while (stack.length && stack[stack.length - 1] !== wanted) {
                const open = stack.pop();
                out += open === '{' ? '}' : ']';
            }
            if (stack.length && stack[stack.length - 1] === wanted) {
                stack.pop();
                out += ch;
            }
            continue;
        }

        out += ch;
    }

    while (stack.length) {
        const open = stack.pop();
        out += open === '{' ? '}' : ']';
    }

    return out;
}


/**
 * Extracts tool calls from raw model text.
 * Returns { text, calls } or null when no tool call is present.
 */
export function extractToolCalls(content) {
    if (typeof content !== 'string') return null;
    const trimmed = content.trim();
    if (!trimmed) return null;

    return extractTagCalls(content) || extractBareJsonCalls(trimmed);
}

// stripCodeFences is defined above.

function toCallDescriptor(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;

    const name = parsed.name || parsed.function?.name || parsed.tool;
    if (!name || typeof name !== 'string') return null;

    let args = parsed.arguments ?? parsed.args ?? parsed.input ?? parsed.function?.arguments ?? {};
    if (typeof args === 'string') {
        args = parseJsonLoose(args) ?? {};
    }
    if (!args || typeof args !== 'object') {
        args = {};
    }

    return {
        id: typeof parsed.id === 'string' && parsed.id ? parsed.id : null,
        name,
        arguments: args
    };
}


function extractTagCalls(content) {
    const openTag = '<tool_call>';
    const closeTag = '</tool_call>';
    const firstOpen = content.indexOf(openTag);
    if (firstOpen < 0) return null;

    const text = content.slice(0, firstOpen).trim();
    const calls = [];
    const segments = content.slice(firstOpen).split(openTag).slice(1);

    for (const segment of segments) {
        let jsonPart = segment;
        const closeIdx = segment.indexOf(closeTag);
        if (closeIdx >= 0) jsonPart = segment.slice(0, closeIdx);

        const descriptor = toCallDescriptor(parseJsonLoose(stripCodeFences(jsonPart)));
        if (descriptor) calls.push(descriptor);
    }

    return calls.length > 0 ? { text, calls } : null;
}

function extractBareJsonCalls(content) {
    const parsed = parseJsonLoose(stripCodeFences(content));
    if (!parsed || typeof parsed !== 'object') return null;

    if (Array.isArray(parsed.tool_calls)) {
        const calls = parsed.tool_calls.map(toCallDescriptor).filter(Boolean);
        return calls.length > 0 ? { text: '', calls } : null;
    }

    const hasName = Boolean(parsed.name || parsed.function?.name);
    const hasArgs = parsed.arguments !== undefined || parsed.args !== undefined ||
        parsed.input !== undefined || parsed.function?.arguments !== undefined;

    if (hasName && hasArgs) {
        const descriptor = toCallDescriptor(parsed);
        if (descriptor) return { text: '', calls: [descriptor] };
    }

    return null;
}
