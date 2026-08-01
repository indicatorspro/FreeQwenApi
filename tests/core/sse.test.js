import { describe, it, expect } from 'vitest';

import { SseAccumulator } from '../../src/core/qwen/sse.js';

function feed(acc, dataLines) {
    acc.feedText(dataLines.map(d => `data: ${d}\n`).join(''));
    acc.flush();
}

function chunk(delta) {
    return JSON.stringify({ choices: [{ index: 0, delta }] });
}

describe('SseAccumulator thinking phases', () => {
    it('keeps only the answer phase when thinking is streamed', () => {
        const acc = new SseAccumulator();
        feed(acc, [
            chunk({ phase: 'think', content: 'Hmm, let me think about this.' }),
            chunk({ phase: 'thinking_summary', content: 'Summary of reasoning.' }),
            chunk({ phase: 'answer', content: 'Here is the final answer.' })
        ]);
        expect(acc.content).toBe('Here is the final answer.');
        const completion = acc.toCompletion('qwen3.8-max-preview');
        expect(completion.choices[0].message.content).toBe('Here is the final answer.');
    });

    it('ignores DeepThinking and KeepAlive phases', () => {
        const acc = new SseAccumulator();
        feed(acc, [
            chunk({ phase: 'DeepThinking', content: 'deep reasoning' }),
            chunk({ phase: 'KeepAlive' }),
            chunk({ phase: 'answer', content: 'OK' })
        ]);
        expect(acc.content).toBe('OK');
    });

    it('still accumulates phase-less chunks for non-thinking models', () => {
        const acc = new SseAccumulator();
        feed(acc, [
            chunk({ content: 'Plain' }),
            chunk({ content: ' answer' })
        ]);
        expect(acc.content).toBe('Plain answer');
    });

    it('does not forward thinking chunks through onChunk', () => {
        const emitted = [];
        const acc = new SseAccumulator({ onChunk: (c) => emitted.push(c) });
        feed(acc, [
            chunk({ phase: 'think', content: 'reasoning' }),
            chunk({ phase: 'answer', content: 'final' })
        ]);
        expect(emitted).toEqual(['final']);
        expect(acc.streamed).toBe(true);
    });

    it('does not stop at the think phase status=finished — the answer phase follows', () => {
        // Real qwen3.8-max-preview stream: the thinking phase ends with
        // status "finished", then the answer phase is streamed, then the
        // answer phase itself ends with status "finished".
        const acc = new SseAccumulator();
        feed(acc, [
            chunk({ phase: 'think', content: 'The user is greeting me casually...', status: 'typing' }),
            chunk({ phase: 'think', content: '', status: 'finished' }),
            chunk({ phase: 'answer', content: 'Tudo bem, e você?', status: 'typing' }),
            chunk({ phase: 'answer', content: '', status: 'finished' })
        ]);
        expect(acc.finished).toBe(true);
        expect(acc.content).toBe('Tudo bem, e você?');
    });

    it('does not stop at a phase-less status=finished that precedes more answer content', () => {
        const acc = new SseAccumulator();
        feed(acc, [
            chunk({ content: 'Plain', status: 'typing' }),
            chunk({ content: '', status: 'finished' })
        ]);
        expect(acc.finished).toBe(true);
        expect(acc.content).toBe('Plain');
    });

    it('captures the usage chunk that arrives between answer typing and finish', () => {
        const acc = new SseAccumulator();
        feed(acc, [
            chunk({ phase: 'answer', content: 'Hello', status: 'typing' }),
            JSON.stringify({ choices: [{ index: 0, delta: { content: '', role: 'assistant', status: 'typing', phase: 'answer' } }], usage: { total_tokens: 9 } }),
            chunk({ phase: 'answer', content: '', status: 'finished' })
        ]);
        expect(acc.finished).toBe(true);
        expect(acc.content).toBe('Hello');
        expect(acc.usage.total_tokens).toBe(9);
    });
});
