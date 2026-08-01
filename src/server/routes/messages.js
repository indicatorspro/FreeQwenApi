// Anthropic Messages API shim: POST /api/messages and /api/v1/messages.
//
// Lets Claude Code (and any Anthropic-format client) point ANTHROPIC_BASE_URL
// at this proxy. The Anthropic request is translated to our OpenAI-compatible
// service request and executed through runCompletion directly (no loopback, so
// streaming is real — the source's loopback re-emitted fake 16-char chunks).

import express from 'express';
import crypto from 'crypto';

import { logError, logInfo } from '../../shared/logger.js';
import { mapModel } from '../../core/models/mapping.js';
import { config } from '../../config/index.js';
import { normalizeId } from '../../shared/ids.js';
import { extractConversationHint, extractParentHint, shouldForceNewChat } from '../../core/conversations/resolver.js';
import { runCompletion } from '../../services/completions.js';
import { clientKey } from '../middleware/index.js';

const router = express.Router();

/** Extracts plain text from Anthropic content blocks (or a raw string). */
function anthropicTextFromContent(content) {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return JSON.stringify(content);

    return content.map((block) => {
        if (!block) return '';
        if (typeof block === 'string') return block;
        if (block.type === 'text') return block.text || '';
        if (block.type === 'tool_result') {
            const value = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
            return `Tool result (${block.tool_use_id || 'tool'}): ${value}`;
        }
        if (block.type === 'tool_use') {
            return `Assistant tool call: ${JSON.stringify({ name: block.name, input: block.input || {}, id: block.id })}`;
        }
        return JSON.stringify(block);
    }).filter(Boolean).join('\n');
}

/** Converts Anthropic messages to our OpenAI-compatible message list. */
function anthropicMessagesToOpenAI(body) {
    const messages = [];
    if (body.system) {
        messages.push({ role: 'system', content: anthropicTextFromContent(body.system) });
    }

    for (const msg of body.messages || []) {
        if (!msg) continue;
        const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content || '') }];
        const toolUseBlocks = content.filter((block) => block?.type === 'tool_use');
        const toolResultBlocks = content.filter((block) => block?.type === 'tool_result');
        const text = anthropicTextFromContent(content.filter((block) => block?.type !== 'tool_use'));

        if (msg.role === 'assistant' && toolUseBlocks.length > 0) {
            messages.push({
                role: 'assistant',
                content: text || null,
                tool_calls: toolUseBlocks.map((block) => ({
                    id: block.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
                    type: 'function',
                    function: { name: block.name, arguments: JSON.stringify(block.input || {}) }
                }))
            });
            continue;
        }

        if (toolResultBlocks.length > 0) {
            for (const block of toolResultBlocks) {
                messages.push({
                    role: 'tool',
                    tool_call_id: block.tool_use_id || 'tool',
                    content: anthropicTextFromContent(block.content)
                });
            }
            const onlyToolResults = content.every((block) => block?.type === 'tool_result');
            if (!onlyToolResults && text) messages.push({ role: 'user', content: text });
            continue;
        }

        messages.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: text });
    }
    return messages;
}

/** Converts Anthropic tools to OpenAI tools format. */
function anthropicToolsToOpenAI(tools) {
    if (!Array.isArray(tools)) return undefined;
    return tools.map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.input_schema || { type: 'object', properties: {} }
        }
    })).filter((tool) => tool.function.name);
}

/** Maps a CompletionResult to an Anthropic message object. */
function openAIToAnthropicMessage(result, requestedModel) {
    const content = [];

    if (Array.isArray(result.toolCalls) && result.toolCalls.length > 0) {
        for (const call of result.toolCalls) {
            let input = {};
            try { input = JSON.parse(call.function?.arguments || '{}'); } catch { input = {}; }
            content.push({
                type: 'tool_use',
                id: call.id || `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
                name: call.function?.name,
                input
            });
        }
    }

    if (result.content) content.push({ type: 'text', text: result.content });
    if (content.length === 0) content.push({ type: 'text', text: '' });

    return {
        id: result.id || `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'message',
        role: 'assistant',
        model: result.model || requestedModel || config.server.defaultModel,
        content,
        stop_reason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: {
            input_tokens: result.usage?.prompt_tokens || 0,
            output_tokens: result.usage?.completion_tokens || 0
        },
        // Qwen continuation metadata (extra fields tolerated by clients).
        chatId: result.chatId,
        parentId: result.parentId,
        x_qwen_chat_id: result.chatId,
        x_qwen_parent_id: result.parentId
    };
}

/** Anthropic SSE stream writer for real (on-the-fly) streaming. */
class AnthropicStream {
    constructor(res) {
        this.res = res;
        this.id = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
        this.closed = false;
        this.blockStarted = false;
        this.textAccumulator = '';

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders?.();
    }

    write(event, data) {
        if (this.closed) return;
        this.res.write(`event: ${event}\n`);
        this.res.write(`data: ${JSON.stringify(data)}\n\n`);
    }

    start() {
        this.write('message_start', {
            type: 'message_start',
            message: {
                id: this.id,
                type: 'message',
                role: 'assistant',
                model: '',
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 }
            }
        });
    }

    /** Streams text content as a single text block (real-time chunks). */
    content(text) {
        if (!text || this.closed) return;
        this.textAccumulator += text;
        if (!this.blockStarted) {
            this.blockStarted = true;
            this.write('content_block_start', {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' }
            });
        }
        this.write('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text }
        });
    }

    /** Emits tool_use blocks after the text block (if any). */
    toolCalls(calls) {
        if (this.closed) return;
        if (this.blockStarted) {
            this.write('content_block_stop', { type: 'content_block_stop', index: 0 });
        }
        calls.forEach((call, index) => {
            const blockIndex = this.blockStarted ? index + 1 : index;
            let input = {};
            try { input = JSON.parse(call.function?.arguments || '{}'); } catch { input = {}; }
            this.write('content_block_start', {
                type: 'content_block_start',
                index: blockIndex,
                content_block: { type: 'tool_use', id: call.id || `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`, name: call.function?.name, input: {} }
            });
            this.write('content_block_delta', {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) }
            });
            this.write('content_block_stop', { type: 'content_block_stop', index: blockIndex });
        });
    }

    /** Ends the stream with the proper stop reason. */
    end(stopReason = 'end_turn', usage = null) {
        if (this.closed) return;
        this.closed = true;
        if (this.blockStarted) {
            this.write('content_block_stop', { type: 'content_block_stop', index: 0 });
        }
        this.write('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: usage?.completion_tokens || 0 }
        });
        this.write('message_stop', { type: 'message_stop' });
        this.res.end();
    }

    /** Emits an error event and closes. */
    error(message) {
        if (this.closed) return;
        this.closed = true;
        this.write('error', { type: 'error', error: { type: 'api_error', message } });
        this.res.end();
    }
}

/** Builds a service request from the Anthropic body. */
function buildAnthropicRequest(req) {
    const body = req.body || {};
    const headers = req.headers || {};
    const messages = anthropicMessagesToOpenAI(body);

    return {
        messages,
        model: mapModel(body.model),
        tools: anthropicToolsToOpenAI(body.tools),
        toolChoice: body.tool_choice?.type === 'tool'
            ? { type: 'function', function: { name: body.tool_choice.name } }
            : undefined,
        chatId: normalizeId(body.chatId) || normalizeId(body.chat_id),
        parentId: extractParentHint({ body, headers }),
        conversationHint: extractConversationHint({ body, headers }),
        forceNewChat: shouldForceNewChat({ body, headers }),
        clientKey: clientKey(req)
    };
}

router.post('/messages', async (req, res, next) => {
    try {
        const body = req.body || {};
        const stream = Boolean(body.stream);
        logInfo(`Anthropic Messages request${stream ? ' (stream)' : ''}`);

        const request = buildAnthropicRequest(req);

        if (!stream) {
            const result = await runCompletion(request);
            if (result.error) {
                return res.status(result.status || 500).json({
                    type: 'error',
                    error: { type: 'api_error', message: result.error, ...(result.details ? { details: result.details } : {}) }
                });
            }
            return res.json(openAIToAnthropicMessage(result, body.model));
        }

        const sse = new AnthropicStream(res);
        sse.start();
        res.on('close', () => { sse.closed = true; });

        const result = await runCompletion(request, {
            onContent: (text) => sse.content(text)
        });

        if (result.error) {
            if (!result.streamed) return sse.error(result.error);
            return sse.end('end_turn');
        }

        if (result.toolCalls) {
            sse.toolCalls(result.toolCalls);
            return sse.end('tool_use', result.usage);
        }

        return sse.end('end_turn', result.usage);
    } catch (error) {
        logError('Anthropic Messages request failed', error);
        if (res.headersSent) {
            try { res.end(); } catch { /* connection closed */ }
            return undefined;
        }
        return next(error);
    }
});

export default router;
