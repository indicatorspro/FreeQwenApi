import crypto from 'crypto';

/**
 * Приводит идентификатор из внешнего запроса к строке или null.
 * Клиенты присылают в полях id всё подряд: числа, "null", "undefined", пробелы.
 */
export function normalizeId(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    if (typeof value !== 'string') return null;

    const trimmed = value.trim();
    if (!trimmed) return null;

    const lower = trimmed.toLowerCase();
    if (lower === 'null' || lower === 'undefined') return null;

    return trimmed;
}

/** Первый непустой идентификатор из списка кандидатов. */
export function pickFirstId(candidates) {
    for (const candidate of candidates) {
        const normalized = normalizeId(candidate);
        if (normalized) return normalized;
    }
    return null;
}

/** Детерминированный короткий хеш — для стабильных ключей чатов. */
export function shortHash(value, length = 16) {
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

export function randomHex(bytes = 8) {
    return crypto.randomBytes(bytes).toString('hex');
}

export function uuid() {
    return crypto.randomUUID();
}

/** Идентификатор вызова инструмента в формате OpenAI (`call_...`). */
export function toolCallId() {
    return `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/** Идентификатор ответа chat.completion в формате OpenAI. */
export function completionId() {
    return `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

/** Unix-время в секундах — формат поля `created` у OpenAI. */
export function unixSeconds() {
    return Math.floor(Date.now() / 1000);
}
