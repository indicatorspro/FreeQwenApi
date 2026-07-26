// Транспорт запросов к Qwen Chat.
//
// Путей два, и оба нужны:
//   • node fetch — быстрый, но Aliyun WAF периодически подменяет ответ капчей;
//   • fetch внутри страницы браузера — несёт живую сессию и капчу не получает.
//
// Раньше браузерный путь не умел отдавать чанки наружу: при срабатывании WAF
// стриминг молча превращался в «тишина, потом всё разом». Теперь страница
// прокидывает строки SSE в Node через exposed-функцию, а разбор общий.

import { logDebug, logWarn } from '../../shared/logger.js';
import { randomHex } from '../../shared/ids.js';
import { SseAccumulator, parseNonSseBody } from './sse.js';

/**
 * @typedef {object} TransportResult
 * @property {boolean} ok
 * @property {'completion'|'task'} [kind]
 * @property {object} [data]
 * @property {boolean} [streamed] — чанки уже отданы клиенту
 * @property {number} [status]
 * @property {string} [statusText]
 * @property {string} [errorBody]
 * @property {string} [error]
 */

/** Код, исполняемый внутри страницы браузера. Должен быть самодостаточным. */
async function inPageRequest({ url, payload, token, bindingName }) {
    try {
        if (!token) return { ok: false, error: 'Токен авторизации не найден' };

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
                Accept: '*/*'
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

        // Читаем поток и параллельно отдаём строки в Node, если мост доступен.
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const bridge = bindingName ? window[bindingName] : null;
        let buffer = '';
        let full = '';

        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            full += text;
            if (!bridge) continue;

            buffer += text;
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                try { await bridge(line); } catch { /* мост отвалился — дочитаем в Node */ }
            }
        }
        if (bridge && buffer) {
            try { await bridge(buffer); } catch { /* игнорируем */ }
        }

        return { ok: true, status: response.status, contentType, body: full };
    } catch (error) {
        return { ok: false, error: String(error) };
    }
}

/** Приводит сырое тело ответа к TransportResult. */
function interpretBody({ body, contentType, payload, streamed }) {
    if (payload.stream === false) {
        try {
            const parsed = JSON.parse(body);
            if (parsed.code === 'RateLimited' || parsed.error) {
                return { ok: false, status: 429, errorBody: JSON.stringify(parsed) };
            }
            return { ok: true, kind: 'task', data: parsed, streamed };
        } catch {
            return { ok: false, error: 'Некорректный JSON в ответе задачи', errorBody: body };
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

/** Запрос напрямую из Node. */
export async function requestViaNode({ url, payload, token, onChunk = null }) {
    if (!token) return { ok: false, error: 'Токен авторизации не найден' };
    if (typeof fetch !== 'function') return { ok: false, error: 'Fetch API недоступен' };

    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
                Accept: '*/*'
            },
            body: JSON.stringify(payload)
        });
    } catch (error) {
        return { ok: false, error: String(error) };
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

/** Запрос через fetch внутри страницы браузера (живая сессия, без капчи). */
export async function requestViaBrowser({ page, url, payload, token, onChunk = null }) {
    const wantsStreaming = Boolean(onChunk) && payload.stream !== false;
    const live = wantsStreaming ? new SseAccumulator({ onChunk }) : null;

    let bindingName = null;
    if (live) {
        bindingName = `__fqaChunk_${randomHex(6)}`;
        try {
            await page.exposeFunction(bindingName, (line) => { live.feedLine(line); });
        } catch (error) {
            logWarn(`Не удалось создать мост для стриминга: ${error.message}; ответ придёт одним куском`);
            bindingName = null;
        }
    }

    try {
        const result = await page.evaluate(inPageRequest, { url, payload, token, bindingName });

        if (!result.ok) {
            return {
                ok: false,
                status: result.status,
                statusText: result.statusText,
                errorBody: result.body,
                error: result.error
            };
        }

        return interpretBody({
            body: result.body,
            contentType: result.contentType || '',
            payload,
            streamed: Boolean(live?.streamed)
        });
    } finally {
        if (bindingName && typeof page.removeExposedFunction === 'function') {
            // Вкладка возвращается в пул: имя должно быть свободно для следующего запроса.
            try { await page.removeExposedFunction(bindingName); } catch { /* уже снято */ }
        }
    }
}

/** Признак того, что WAF подменил ответ вместо SSE. */
function isWafBlocked(result) {
    return result.ok !== true && /Unexpected non-SSE 200/i.test(String(result.error || ''));
}

/**
 * Основной вход: пробует Node, при блокировке WAF уходит в браузер.
 * @returns {Promise<TransportResult>}
 */
export async function executeChatRequest({ page, url, payload, token, onChunk = null }) {
    if (payload.stream !== false && typeof onChunk === 'function') {
        const nodeResult = await requestViaNode({ url, payload, token, onChunk });

        if (!isWafBlocked(nodeResult)) {
            const conclusive = nodeResult.ok
                || Boolean(nodeResult.status)
                || Boolean(nodeResult.errorBody)
                || nodeResult.streamed === true;
            if (conclusive) return nodeResult;
        } else {
            logDebug('WAF подменил ответ node-запроса, переключаемся на браузер');
        }

        logWarn(`Node-запрос не дал результата (${nodeResult.error || 'неизвестная ошибка'}), фолбэк в браузер`);
    }

    return requestViaBrowser({ page, url, payload, token, onChunk });
}

/** Простой POST через страницу браузера — для создания чата и подобных вызовов. */
export async function postViaBrowser({ page, url, payload, token }) {
    return page.evaluate(async (data) => {
        try {
            const response = await fetch(data.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.token}` },
                body: JSON.stringify(data.payload)
            });
            if (response.ok) return { ok: true, data: await response.json() };
            return { ok: false, status: response.status, errorBody: await response.text() };
        } catch (error) {
            return { ok: false, error: String(error) };
        }
    }, { url, payload, token });
}

/** Простой GET через страницу браузера — для опроса статуса задач. */
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
