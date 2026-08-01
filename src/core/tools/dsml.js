// DSML (DashScope Markup Language) parser for tool calls.
//
// Some DashScope legacy models respond with XML format instead of JSON:
//
//   <tool_calls>
//     <invoke name="get_weather">
//       <parameter name="city">São Paulo</parameter>
//     </invoke>
//   </tool_calls>
//
// This module normalizes DSML → OpenAI tool_calls format.
//
// Source: FreeQwenApi_ForgetMeAI (toolParser.js).

import crypto from 'crypto';

/** Removes code fences (```json ... ```). */
function stripCodeFences(text) {
    const trimmed = String(text || '').trim();
    const fence = trimmed.match(/^```(?:json|xml|dsml)?\s*([\s\S]*?)\s*```$/i);
    return fence ? fence[1].trim() : trimmed;
}

/** Normalizes argument value: JSON strings, CDATA. */
function normalizeToolArgumentValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value !== 'string') return value;

    const trimmed = value.trim();
    if (!trimmed) return '';

    // Try to parse embedded JSON in string.
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
            return JSON.parse(trimmed);
        } catch {
            // Keep original string.
        }
    }

    // Remove CDATA wrappers.
    return value.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
}

/** Serializes arguments to JSON string. */
function serializeToolArguments(rawArgs) {
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

/** Normalizes tool calls list to OpenAI format. */
function normalizeToolCalls(calls) {
    if (!Array.isArray(calls) || calls.length === 0) return null;

    const normalized = calls.map((call, index) => {
        const name = call?.name || call?.tool || call?.function?.name;
        const rawArgs = call?.arguments ?? call?.args ?? call?.input ?? call?.function?.arguments ?? {};

        if (!name) return null;

        return {
            id: call.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
            type: 'function',
            function: { name, arguments: serializeToolArguments(rawArgs) },
            index: Number.isInteger(call.index) ? call.index : index
        };
    }).filter(Boolean);

    return normalized.length > 0 ? normalized : null;
}

/**
 * Normalizes DSML tags with Chinese Unicode characters.
 * Ex: 〈tool_calls〉 → <tool_calls>
 */
function normalizeDsmlTags(content) {
    const text = stripCodeFences(content)
        // Replace Chinese angle brackets.
        .replace(/[〈《]/g, '<')
        .replace(/[〉》]/g, '>')
        // Replace Chinese quotes.
        .replace(/[""]/g, '"')
        .replace(/['']/g, "'")
        // Normalize CDATA.
        .replace(/<!\[CDATA\[/g, '<![CDATA[')
        .replace(/\]\]>/g, ']]>');

    // Normalize tag names: tool_calls, invoke, parameter.
    return text.replace(/<([^<>]+)>/g, (full, rawInner) => {
        const inner = rawInner.trim();
        const closing = inner.startsWith('/');
        const body = (closing ? inner.slice(1) : inner).trim();

        // Remove Chinese punctuation and control characters.
        // eslint-disable-next-line no-control-regex -- \u0002 is a deliberate tool-call delimiter
        const searchable = body.replace(/[|｜！!、,;:※\u0002]+/g, ' ');
        const match = searchable.match(/(tool[_\s-]*calls|toolcalls|invoke|parameter)([\s\S]*)/i);

        if (!match) return full;

        const compactName = match[1].toLowerCase().replace(/[^a-z]/g, '');
        const tagName = compactName === 'toolcalls' ? 'tool_calls' : compactName;

        let attrs = closing ? '' : (match[2] || '')
            // eslint-disable-next-line no-control-regex -- \u0002 is a deliberate tool-call delimiter
            .replace(/[|｜！!、,;:※\u0002\s]+$/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        attrs = attrs ? ` ${attrs}` : '';

        return `<${closing ? '/' : ''}${tagName}${attrs}>`;
    });
}

/** Extracts XML attribute by name. */
function extractXmlAttr(attrs, name) {
    const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
    const match = String(attrs || '').match(re);
    return match ? (match[1] ?? match[2] ?? match[3] ?? '') : '';
}

/**
 * Parses tool calls in DSML format.
 * @param {string} content
 * @returns {Array<{id: string, type: string, function: {name: string, arguments: string}, index: number}>|null}
 */
export function parseDsmlToolCalls(content) {
    const text = normalizeDsmlTags(content);

    // Look for <tool_calls>...</tool_calls> wrapper.
    let wrapperMatch = text.match(/<tool_calls\b[^>]*>([\s\S]*?)<\/tool_calls>/i);

    // Repair: tolerate missing opening wrapper if there's closing and complete invokes.
    if (!wrapperMatch && /<\/tool_calls>\s*$/i.test(text) && /<invoke\b/i.test(text)) {
        wrapperMatch = [`s>${text}`, text.replace(/<\/tool_calls>\s*$/i, '')];
    }

    if (!wrapperMatch) return null;

    const body = wrapperMatch[1];
    const invokeRe = /<invoke\b([^>]*)>([\s\S]*?)<\/invoke>/gi;
    const calls = [];

    let invokeMatch;
    while ((invokeMatch = invokeRe.exec(body)) !== null) {
        const name = extractXmlAttr(invokeMatch[1], 'name');
        if (!name) continue;

        const invokeBody = invokeMatch[2];
        const args = {};

        // Extract parameters.
        const paramRe = /<parameter\b([^>]*)>([\s\S]*?)<\/parameter>/gi;
        let paramMatch;
        while ((paramMatch = paramRe.exec(invokeBody)) !== null) {
            const paramName = extractXmlAttr(paramMatch[1], 'name');
            if (!paramName) continue;

            let value = paramMatch[2].trim();
            value = value.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/i, '$1');
            args[paramName] = normalizeToolArgumentValue(value);
        }

        // If there were <parameter> tags but none parsed, abort.
        if (/<parameter\b/i.test(invokeBody) && Object.keys(args).length === 0) {
            return null;
        }

        calls.push({ name, arguments: args });
    }

    // If there were <invoke> tags but none parsed, abort.
    if (/<invoke\b/i.test(body) && calls.length === 0) {
        return null;
    }

    return normalizeToolCalls(calls);
}

/**
 * Detects if content looks like DSML.
 * @param {string} content
 * @returns {boolean}
 */
export function looksLikeDsml(content) {
    if (typeof content !== 'string') return false;
    const lower = content.toLowerCase();
    return lower.includes('<tool_calls') ||
           lower.includes('<invoke') ||
           lower.includes('〈tool_calls') ||
           lower.includes('《tool_calls');
}
