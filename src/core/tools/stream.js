// Stream filter for tool mode.
//
// Previously with `tools` present, streaming was simply disabled: agent received
// nothing for several tens of seconds. Reason is clear — can't send client
// service JSON of call as regular text. Solution: skip text until it's definitely
// not start of <tool_call>, and hold "suspicious" tail until end of generation.

import { TOOL_CALL_MARKERS, extractToolCalls } from './parser.js';

/** Length of longest marker — that many characters maximum need to be held. */
const MAX_MARKER_LENGTH = Math.max(...TOOL_CALL_MARKERS.map(marker => marker.length));

/** Position of first complete marker starting from `from`, or -1. */
function findMarker(text, from) {
    let best = -1;
    for (const marker of TOOL_CALL_MARKERS) {
        const index = text.indexOf(marker, from);
        if (index >= 0 && (best < 0 || index < best)) best = index;
    }
    return best;
}

/**
 * Position from which the tail may be the beginning of a marker.
 * For example, if the stream ended at "<tool_c" — it must not be sent to the client.
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
 * Stream response accumulator with tool call cutoff.
 *
 * Usage:
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
     * Adds the next stream fragment.
     * @param {string} chunk
     * @returns {string} — text that is safe to send to the client right now
     */
    push(chunk) {
        if (typeof chunk !== 'string' || !chunk) return '';
        this.raw += chunk;

        if (!this.enabled) {
            const safe = this.raw.slice(this.released);
            this.released = this.raw.length;
            return safe;
        }

        // As soon as a full marker is encountered, hold everything until generation ends.
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

    /** The entire response text, including the held-back tail. */
    get text() {
        return this.raw;
    }

    /**
     * Completes the stream.
     * @returns {{content: string, pending: string, toolCalls: Array|null}}
     *          pending — held-back text; if no calls are found, it must
     *          be sent to the client as normal content, otherwise the response will be lost.
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
