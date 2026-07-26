// Фильтр потока для режима с инструментами.
//
// Раньше при наличии `tools` стриминг просто выключался: агент несколько
// десятков секунд не получал ничего. Причина понятна — нельзя отдавать клиенту
// служебный JSON вызова как обычный текст. Решение: пропускать текст до тех пор,
// пока он заведомо не является началом <tool_call>, и придерживать «подозрительный»
// хвост до конца генерации.

import { TOOL_CALL_MARKERS, extractToolCalls } from './parser.js';

/** Длина самого длинного маркера — столько символов максимум придётся держать. */
const MAX_MARKER_LENGTH = Math.max(...TOOL_CALL_MARKERS.map(marker => marker.length));

/** Позиция первого полного маркера начиная с `from`, либо -1. */
function findMarker(text, from) {
    let best = -1;
    for (const marker of TOOL_CALL_MARKERS) {
        const index = text.indexOf(marker, from);
        if (index >= 0 && (best < 0 || index < best)) best = index;
    }
    return best;
}

/**
 * Позиция, с которой хвост может оказаться началом маркера.
 * Например, поток закончился на "<tool_c" — отдавать это клиенту нельзя.
 */
function findPartialMarkerStart(text, from) {
    const tailStart = Math.max(from, text.length - MAX_MARKER_LENGTH + 1);
    for (let index = tailStart; index < text.length; index++) {
        const tail = text.slice(index);
        if (TOOL_CALL_MARKERS.some(marker => marker.startsWith(tail))) return index;
    }
    return -1;
}

/**
 * Накопитель потокового ответа с отсечением вызовов инструментов.
 *
 * Использование:
 *   const filter = new ToolCallStreamFilter();
 *   onChunk = chunk => { const safe = filter.push(chunk); if (safe) sendContent(safe); };
 *   const { content, toolCalls } = filter.finish();
 */
export class ToolCallStreamFilter {
    constructor({ enabled = true } = {}) {
        this.enabled = enabled;
        this.raw = '';
        this.released = 0;
        this.holdFrom = -1;
    }

    /**
     * Добавляет очередной фрагмент потока.
     * @param {string} chunk
     * @returns {string} — текст, который безопасно отдать клиенту прямо сейчас
     */
    push(chunk) {
        if (typeof chunk !== 'string' || !chunk) return '';
        this.raw += chunk;

        if (!this.enabled) {
            const safe = this.raw.slice(this.released);
            this.released = this.raw.length;
            return safe;
        }

        // Как только встретился полный маркер, придерживаем всё до конца генерации.
        if (this.holdFrom < 0) {
            const marker = findMarker(this.raw, this.released);
            if (marker >= 0) this.holdFrom = marker;
        }

        const boundary = this.holdFrom >= 0
            ? this.holdFrom
            : (() => {
                const partial = findPartialMarkerStart(this.raw, this.released);
                return partial >= 0 ? partial : this.raw.length;
            })();

        if (boundary <= this.released) return '';

        const safe = this.raw.slice(this.released, boundary);
        this.released = boundary;
        return safe;
    }

    /** Весь текст ответа целиком, включая придержанный хвост. */
    get text() {
        return this.raw;
    }

    /**
     * Завершает поток.
     * @returns {{content: string, pending: string, toolCalls: Array|null}}
     *          pending — придержанный текст; если вызовов не нашлось, его нужно
     *          отдать клиенту как обычный контент, иначе ответ потеряется.
     */
    finish() {
        const pending = this.raw.slice(this.released);
        this.released = this.raw.length;

        const extracted = this.enabled ? extractToolCalls(this.raw) : null;
        if (extracted && extracted.calls.length > 0) {
            return { content: extracted.text, pending: '', toolCalls: extracted.calls };
        }

        return { content: this.raw, pending, toolCalls: null };
    }
}
