// Transport for Qwen Chat requests.
//
// Two paths, both needed:
//   • node fetch — fast, but Aliyun WAF periodically replaces response with captcha;
//   • fetch inside browser page — carries live session and doesn't get captcha.
//
// Previously browser path couldn't emit chunks outward: when WAF triggered,
// streaming silently turned into "silence, then everything at once". Now page
// passes SSE lines to Node via exposed function, and parsing is shared.
//
// Anti-bot detection: antibot.js module recognizes Aliyun WAF signatures
// (TMD, rgv587, PureCaptcha, Baxia) and classifies blocked responses.
// Node-first/browser-first strategy controlled by config.network.nodeFetchFirst.

import { config } from '../../config/index.js';
import { logDebug, logWarn } from '../../shared/logger.js';
import { randomHex } from '../../shared/ids.js';
import { SseAccumulator, parseNonSseBody } from './sse.js';
import { isAntiBotChallenge, isHtmlResponse, classifyBlockedResponse, formatDiagnostic } from './antibot.js';
import { SOURCE_HEADER } from './protocol.js';

/**
 * @typedef {object} TransportResult
 * @property {boolean} ok
 * @property {'completion'|'task'} [kind]
 * @property {object} [data]
 * @property {boolean} [streamed] — chunks already sent to client
 * @property {number} [status]
 * @property {string} [statusText]
 * @property {string} [errorBody]
 * @property {string} [error]
 * @property {boolean} [antiBot] — response is Aliyun WAF anti-bot challenge
 * @property {boolean} [html] — response is HTML page (not JSON/SSE)
 */

/** Code executed inside browser page. Must be self-contained. */
async function inPageRequest({ url, payload, headers = {}, token, bindingName, sourceHeader }) {
    try {
        if (!token) return { ok: false, error: 'Authorization token not found' };

        const response = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                'Accept': '*/*',
                Authorization: `Bearer ${token}`,
                'X-Accel-Buffering': 'no',
                'X-Request-Id': crypto.randomUUID(),
                'source': sourceHeader,
                ...headers
            },
            body: JSON.stringify(payload)
        });

        const contentType = response.headers.get('content-type') || '';

        if (!response.ok) {
            return { ok: false, status: response.status, statusText: response.statusText, body: await response.text() };
        }

        if (payload.stream === false || !contentType.includes('text/event-stream') || !response.body) {
            return { ok: true, status: response.status, contentType, body: await response.text() };
        }

        // Read stream and simultaneously emit lines to Node if bridge available.
        // Qwen keeps the SSE connection open after [DONE] / finish_reason, so we
        // must break on stream-finish signals — otherwise this loop never ends
        // and the request hangs until the outer timeout.
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const bridge = bindingName ? window[bindingName] : null;
        let buffer = '';
        let full = '';
        let finished = false;

        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            full += text;
            buffer += text;

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (bridge) {
                    try { await bridge(line); } catch { /* bridge failed — ignore */ }
                }
                const trimmed = line.trim();
                if (trimmed === 'data: [DONE]') { finished = true; break; }
                if (trimmed.startsWith('data:')) {
                    try {
                        const chunk = JSON.parse(trimmed.slice(5).trim());
                        const choice = chunk?.choices?.[0];
                        const delta = choice?.delta;
                        const phase = delta?.phase;
                        const isAnswerPhase = !phase || phase === 'answer';
                        // `status: "finished"` ends a phase, not the stream — a
                        // thinking phase finishes before the answer phase starts.
                        if (choice?.finish_reason || (delta?.status === 'finished' && isAnswerPhase)) { finished = true; break; }
                    } catch { /* not JSON — keep reading */ }
                }
            }
            if (finished) break;
        }
        if (bridge && buffer) {
            try { await bridge(buffer); } catch { /* ignore */ }
        }

        return { ok: true, status: response.status, contentType, body: full };
    } catch (error) {
        return { ok: false, error: String(error) };
    }
}

/** Converts raw response body to TransportResult. */
function interpretBody({ body, contentType, payload, streamed }) {
    if (payload.stream === false) {
        try {
            const parsed = JSON.parse(body);
            if (parsed.code === 'RateLimited' || parsed.error) {
                return { ok: false, status: 429, errorBody: JSON.stringify(parsed) };
            }
            return { ok: true, kind: 'task', data: parsed, streamed };
        } catch {
            return { ok: false, error: 'Invalid JSON in task response', errorBody: body };
        }
    }

    if (!contentType.includes('text/event-stream')) {
        const parsed = parseNonSseBody(body);
        return parsed.ok
            ? { ok: true, kind: 'completion', data: parsed.data, streamed }
            : { ok: false, status: parsed.status, error: parsed.error, errorBody: parsed.errorBody };
    }

    const accumulator = new SseAccumulator();
    accumulator.feedText(body);
    accumulator.flush();

    if (accumulator.error) {
        return { ok: false, ...accumulator.error, streamed };
    }

    return { ok: true, kind: 'completion', data: accumulator.toCompletion(payload.model), streamed };
}

/** Request directly from Node (with timeout from config). */
export async function requestViaNode({ url, payload, token, onChunk = null }) {
    if (!token) return { ok: false, error: 'Authorization token not found' };
    if (typeof fetch !== 'function') return { ok: false, error: 'Fetch API not available' };

    const { headers: payloadHeaders = {}, ...body } = payload;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeouts.nodeFetch);

    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
                Accept: '*/*',
                ...payloadHeaders
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });
    } catch (error) {
        const timedOut = error?.name === 'AbortError';
        return {
            ok: false,
            error: timedOut
                ? `Node fetch timed out after ${config.timeouts.nodeFetch} ms`
                : String(error),
            timedOut
        };
    } finally {
        clearTimeout(timeoutId);
    }

    if (!response.ok) {
        return { ok: false, status: response.status, statusText: response.statusText, errorBody: await response.text() };
    }

    const contentType = response.headers.get('content-type') || '';
    const reader = payload.stream === false ? null : response.body?.getReader?.();

    if (!reader) {
        return interpretBody({ body: await response.text(), contentType, payload, streamed: false });
    }

    const accumulator = new SseAccumulator({ onChunk });
    const decoder = new TextDecoder();

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        accumulator.feedText(decoder.decode(value, { stream: true }));
        if (accumulator.finished || accumulator.error) break;
    }
    accumulator.flush();

    if (accumulator.error) {
        return { ok: false, ...accumulator.error, streamed: accumulator.streamed };
    }

    if (!contentType.includes('text/event-stream')) {
        return interpretBody({ body: accumulator.content, contentType, payload, streamed: false });
    }

    return {
        ok: true,
        kind: 'completion',
        data: accumulator.toCompletion(payload.model),
        streamed: accumulator.streamed
    };
}

/** Returns true when the webapp's anti-bot fetch patch is initialized. */
async function fetchPatchReady(page) {
    try {
        return await page.evaluate(() => {
            try {
                return Boolean(window.AWSC) || String(window.fetch).length > 100;
            } catch {
                return false;
            }
        });
    } catch {
        return false;
    }
}

/**
 * Reloads the page and waits until the webapp's fetch patch is actually ready.
 * Reused/pooled tabs get a stale fetch patch — completions hang or return
 * Bad_Request. A fixed settle after 'load' is unreliable: the patch can take
 * longer than the sleep, so we poll for the deterministic readiness signal.
 */
async function reloadChatPage(page) {
    try {
        await page.goto(config.qwen.chatPageUrl, { waitUntil: 'load', timeout: config.timeouts.page });
    } catch (error) {
        logWarn(`requestViaBrowser: failed to reload chat page: ${error.message}`);
        return false;
    }

    const deadline = Date.now() + config.timeouts.baxiaReady;
    while (Date.now() < deadline) {
        if (await fetchPatchReady(page)) {
            logDebug('requestViaBrowser: page reloaded, fetch patch ready');
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }

    logWarn(`requestViaBrowser: fetch patch not ready after ${config.timeouts.baxiaReady} ms; failing fast instead of hanging`);
    return false;
}

/** Rejects if the promise does not settle within ms. */
function withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), ms);
        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error) => { clearTimeout(timer); reject(error); }
        );
    });
}

/** Request via fetch inside browser page (live session, no captcha). */
export async function requestViaBrowser({ page, url, payload, token, onChunk = null }) {
    const wantsStreaming = Boolean(onChunk) && payload.stream !== false;
    const live = wantsStreaming ? new SseAccumulator({ onChunk }) : null;

    let bindingName = null;

    try {
        // Fresh page load before the request — the webapp's fetch patch must be
        // fully initialized, otherwise the in-page fetch hangs or fails.
        const reloaded = await reloadChatPage(page);
        if (!reloaded) {
            return { ok: false, error: 'browser fetch patch not initialized after page reload' };
        }

        if (live) {
            bindingName = `__fqaChunk_${randomHex(6)}`;
            try {
                await page.exposeFunction(bindingName, (line) => { live.feedLine(line); });
            } catch (error) {
                logWarn(`Failed to create streaming bridge: ${error.message}; response will come as single chunk`);
                bindingName = null;
            }
        }

        const { headers: payloadHeaders = {}, ...body } = payload;
        logDebug(`requestViaBrowser: calling page.evaluate for ${url}`);
        let result;
        try {
            result = await withTimeout(
                page.evaluate(inPageRequest, { url, payload: body, headers: payloadHeaders, token, bindingName, sourceHeader: SOURCE_HEADER }),
                config.timeouts.browserFetch,
                'browser page request timed out'
            );
        } catch (error) {
            const patchReady = await fetchPatchReady(page);
            logWarn(`requestViaBrowser: page.evaluate failed (fetchPatchReady=${patchReady}): ${error.message}`);
            throw error;
        }
        logDebug(`requestViaBrowser: page.evaluate completed, ok=${result.ok}`);

        if (!result.ok) {
            return {
                ok: false,
                status: result.status,
                statusText: result.statusText,
                errorBody: result.body,
                error: result.error,
                streamed: Boolean(live?.streamed)
            };
        }

        return interpretBody({
            body: result.body,
            contentType: result.contentType || '',
            payload: body,
            streamed: Boolean(live?.streamed)
        });
    } catch (error) {
        logWarn(`requestViaBrowser: failed: ${error.message}`);
        return { ok: false, error: String(error.message || error), streamed: Boolean(live?.streamed) };
    } finally {
        if (bindingName && typeof page.removeExposedFunction === 'function') {
            // Tab returns to pool: name must be free for next request.
            try { await page.removeExposedFunction(bindingName); } catch { /* already removed */ }
        }
    }
}

/**
 * Determines if response is blocked by anti-bot protection.
 * Checks WAF signatures in error body and errorBody.
 */
function isWafBlocked(result) {
    if (result.ok === true) return false;

    // Check response body for anti-bot signatures.
    const body = String(result.errorBody || '');
    if (isAntiBotChallenge(body)) return true;

    // Check if response is HTML (WAF replaced JSON/SSE with page).
    if (isHtmlResponse(body)) return true;

    // Old heuristic for compatibility.
    return /Unexpected non-SSE 200/i.test(String(result.error || ''));
}

/**
 * Enriches TransportResult with anti-bot detection flags.
 */
function enrichWithAntiBotInfo(result) {
    if (result.ok === true) return result;

    const body = String(result.errorBody || '');
    const classification = classifyBlockedResponse(body);

    if (classification.antiBot || classification.html || classification.waf) {
        const diagnostic = formatDiagnostic({
            status: result.status,
            antiBot: classification.antiBot,
            waf: classification.waf,
            html: classification.html
        });
        logDebug(`Anti-bot detection: ${diagnostic}`);

        return {
            ...result,
            antiBot: classification.antiBot,
            html: classification.html,
            status: classification.antiBot ? 403 : result.status
        };
    }

    return result;
}

/**
 * Main entry: selects strategy (node-first or browser-first),
 * executes request with fallback on WAF block.
 *
 * For streaming: always try Node.js first (like Heymoma/ForgetMeAI).
 * Node.js streaming is faster and more reliable. Browser fallback only on WAF.
 *
 * For non-streaming: controlled by config.network.nodeFetchFirst.
 *
 * @returns {Promise<TransportResult>}
 */
export async function executeChatRequest({ page, url, payload, token, onChunk = null }) {
    const useNodeFirst = config.network.nodeFetchFirst;
    const wantsStreaming = payload.stream !== false && typeof onChunk === 'function';

    // Streaming: always try Node.js first (Heymoma behavior).
    if (wantsStreaming) {
        const nodeResult = await requestViaNode({ url, payload, token, onChunk });

        if (!isWafBlocked(nodeResult)) {
            const conclusive = nodeResult.ok
                || Boolean(nodeResult.status)
                || Boolean(nodeResult.errorBody)
                || nodeResult.streamed === true;
            if (conclusive) return enrichWithAntiBotInfo(nodeResult);
        } else {
            const diagnostic = formatDiagnostic({
                status: nodeResult.status,
                antiBot: isAntiBotChallenge(String(nodeResult.errorBody || '')),
                html: isHtmlResponse(String(nodeResult.errorBody || ''))
            });
            logDebug(`WAF blocked node streaming (${diagnostic}), switching to browser`);
        }

        logWarn(`Node streaming failed (${nodeResult.error || 'unknown error'}), fallback to browser`);
        const browserResult = await requestViaBrowser({ page, url, payload, token, onChunk });
        return enrichWithAntiBotInfo(browserResult);
    }

    // Non-streaming: browser-first is more reliable (carries live session).
    if (!useNodeFirst) {
        const result = await requestViaBrowser({ page, url, payload, token, onChunk });
        return enrichWithAntiBotInfo(result);
    }

    // Node-first for non-streaming: try fast path, on WAF fallback to browser.
    const nodeResult = await requestViaNode({ url, payload, token, onChunk });

    if (!isWafBlocked(nodeResult)) {
        const conclusive = nodeResult.ok
            || Boolean(nodeResult.status)
            || Boolean(nodeResult.errorBody)
            || nodeResult.streamed === true;
        if (conclusive) return enrichWithAntiBotInfo(nodeResult);
    } else {
        const diagnostic = formatDiagnostic({
            status: nodeResult.status,
            antiBot: isAntiBotChallenge(String(nodeResult.errorBody || '')),
            html: isHtmlResponse(String(nodeResult.errorBody || ''))
        });
        logDebug(`WAF blocked node request (${diagnostic}), switching to browser`);
    }

    logWarn(`Node request failed (${nodeResult.error || 'unknown error'}), fallback to browser`);
    const browserResult = await requestViaBrowser({ page, url, payload, token, onChunk });
    return enrichWithAntiBotInfo(browserResult);
}

/** Simple POST via browser page — for chat creation and similar calls. */
export async function postViaBrowser({ page, url, payload, token }) {
    logDebug(`postViaBrowser: calling page.evaluate for ${url}`);

    try {
        const result = await page.evaluate(async (data) => {
            try {
                const response = await fetch(data.url, {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        Authorization: `Bearer ${data.token}`,
                        'X-Accel-Buffering': 'no',
                        'X-Request-Id': crypto.randomUUID(),
                        'source': data.sourceHeader
                    },
                    body: JSON.stringify(data.payload)
                });
                if (response.ok) return { ok: true, data: await response.json() };
                return { ok: false, status: response.status, errorBody: await response.text() };
            } catch (error) {
                return { ok: false, error: String(error) };
            }
        }, { url, payload, token, sourceHeader: SOURCE_HEADER });

        logDebug(`postViaBrowser: completed, ok=${result.ok}`);
        return result;
    } catch (error) {
        logDebug(`postViaBrowser: error: ${error.message}`);
        return { ok: false, error: String(error) };
    }
}

/** Simple GET via browser page — for task status polling. */
export async function getViaBrowser({ page, url, token }) {
    return page.evaluate(async (data) => {
        try {
            const response = await fetch(data.url, {
                method: 'GET',
                headers: { Authorization: `Bearer ${data.token}`, Accept: 'application/json' }
            });
            if (!response.ok) return { ok: false, status: response.status, error: await response.text() };
            return { ok: true, data: await response.json() };
        } catch (error) {
            return { ok: false, error: String(error) };
        }
    }, { url, token });
}
