import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

puppeteer.use(StealthPlugin());

const ACCOUNT = process.env.PROBE_ACCOUNT || 'acc_1785510149756';
const MODEL = process.env.PROBE_MODEL || 'qwen3.7-max';
const CONTENT = process.env.PROBE_CONTENT || 'oi';

const BASE = 'https://chat.qwen.ai';
const COOKIES_FILE = path.join('session', 'accounts', ACCOUNT, 'cookies.json');
const TOKENS_FILE = path.join('session', 'tokens.json');

function loadToken() {
    const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    const acc = tokens.find(t => t.id === ACCOUNT);
    return acc?.token || null;
}

const token = loadToken();
if (!token) { console.error('NO TOKEN for', ACCOUNT); process.exit(1); }
console.log('Token:', token.slice(0, 30) + '...');

const browser = await puppeteer.launch({
    headless: true,
    args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage', '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--ignore-certificate-errors'
    ],
    protocolTimeout: 120000
});

try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

    const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
    await page.setCookie(...cookies);
    console.log('Cookies loaded:', cookies.length);

    await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 90000 });
    console.log('Navigated + networkidle2');
    await page.evaluate((t) => localStorage.setItem('token', t), token);

    // Check baxia state
    const baxia = await page.evaluate(() => {
        try {
            const fy = window.__baxia__?.getFYModule?.();
            return {
                hasBaxia: Boolean(window.__baxia__),
                hasAwsc: Boolean(window.AWSC),
                uidToken: fy?.getUidToken?.() ? 'yes' : 'no'
            };
        } catch (e) { return { error: String(e) }; }
    });
    console.log('Baxia state:', JSON.stringify(baxia));

    const makeHeaders = () => ({
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'X-Accel-Buffering': 'no',
        'X-Request-Id': crypto.randomUUID()
    });

    const createChat = async () => {
        const r = await page.evaluate(async ({ url, token, headers }) => {
            const response = await fetch(url, {
                method: 'POST',
                headers,
                credentials: 'include',
                body: JSON.stringify({ chatId: '', title: 'probe', models: ['qwen3.7-max'], chat_mode: 'normal', chat_type: 't2t', timestamp: Date.now() })
            });
            return { status: response.status, body: await response.text() };
        }, { url: BASE + '/api/v2/chats/new', token, headers: makeHeaders() });
        try { return { chatId: JSON.parse(r.body)?.data?.id || null, raw: r }; }
        catch { return { chatId: null, raw: r }; }
    };

    const completion = async (label, payload) => {
        const chat = await createChat();
        if (!chat.chatId) { console.log(label, '-> NO CHAT:', chat.raw.body.slice(0, 300)); return; }
        console.log(label, 'chatId:', chat.chatId);
        const r = await page.evaluate(async ({ url, token, headers, payload }) => {
            const response = await fetch(url, {
                method: 'POST',
                headers,
                credentials: 'include',
                body: JSON.stringify(payload)
            });
            return { status: response.status, contentType: response.headers.get('content-type') || '', body: await response.text() };
        }, { url: BASE + '/api/v2/chat/completions?chat_id=' + chat.chatId, token, headers: makeHeaders(), payload });
        console.log(label, 'status:', r.status, '| contentType:', r.contentType);
        console.log(label, 'body:', r.body.slice(0, 400));
        return r;
    };

    const now = Math.floor(Date.now() / 1000);
    const baseMessage = {
        role: 'user', content: CONTENT,
        chat_type: 't2t', sub_chat_type: 't2t',
        timestamp: now, user_action: 'chat',
        files: [], extra: { meta: { subChatType: 't2t' } },
        feature_config: { thinking_enabled: /max-preview/.test(MODEL) || /thinking/.test(MODEL), output_schema: 'phase' }
    };

    // Heymoma-style (no chatId/parentId/model/headers)
    const heymomaPayload = (chatId) => ({
        stream: true, incremental_output: true, chat_id: chatId, chat_mode: 'normal',
        messages: [{ fid: crypto.randomUUID(), parentId: null, parent_id: null, ...baseMessage, models: [MODEL], childrenIds: [crypto.randomUUID()] }],
        model: MODEL, parent_id: null, timestamp: now
    });

    // Ivanqo-style (with chatId/parentId/model:''/headers)
    const ivanqoPayload = (chatId) => ({
        stream: true, version: '2.1', incremental_output: true, chatId, parentId: '', chat_id: chatId, chat_mode: 'normal',
        messages: [{ fid: crypto.randomUUID(), parentId: '', parent_id: null, model: '', ...baseMessage, models: [MODEL], childrenIds: [crypto.randomUUID()] }],
        model: MODEL, parent_id: null, timestamp: now,
        headers: { 'X-Request-Id': crypto.randomUUID() }
    });

    // Note: for Ivanqo, the headers field must be split out and sent as real headers.
    const ivanqoHeaders = () => ({ ...makeHeaders(), 'X-Request-Id': crypto.randomUUID() });

    console.log('\n===== TEST 1: Heymoma-style payload =====');
    const r1 = await completion('HEYMOMA', heymomaPayload);

    console.log('\n===== TEST 2: Ivanqo-style payload (headers split out) =====');
    const chat2 = await createChat();
    if (!chat2.chatId) { console.log('IVANQO -> NO CHAT:', chat2.raw.body.slice(0, 300)); }
    else {
        console.log('IVANQO chatId:', chat2.chatId);
        const payload = ivanqoPayload(chat2.chatId);
        const { headers: _h, ...body } = payload;
        const r2 = await page.evaluate(async ({ url, token, headers, payload }) => {
            const response = await fetch(url, {
                method: 'POST', headers, credentials: 'include', body: JSON.stringify(payload)
            });
            return { status: response.status, contentType: response.headers.get('content-type') || '', body: await response.text() };
        }, { url: BASE + '/api/v2/chat/completions?chat_id=' + chat2.chatId, token, headers: ivanqoHeaders(), payload: body });
        console.log('IVANQO status:', r2.status, '| contentType:', r2.contentType);
        console.log('IVANQO body:', r2.body.slice(0, 400));
    }

    console.log('\n===== TEST 3: Node fetch, NO cookies, Ivanqo-style payload =====');
    const chat3 = await createChat();
    if (!chat3.chatId) { console.log('NODE -> NO CHAT:', chat3.raw.body.slice(0, 300)); }
    else {
        console.log('NODE chatId:', chat3.chatId);
        const payload = ivanqoPayload(chat3.chatId);
        const { headers: _h, ...body } = payload;
        const r3 = await fetch(BASE + '/api/v2/chat/completions?chat_id=' + chat3.chatId, {
            method: 'POST',
            headers: ivanqoHeaders(),
            body: JSON.stringify(body)
        });
        const ct3 = r3.headers.get('content-type') || '';
        const text3 = await r3.text();
        console.log('NODE status:', r3.status, '| contentType:', ct3);
        console.log('NODE body:', text3.slice(0, 400));
    }

    console.log('\n===== TEST 4: mimic app — domcontentloaded + 5s wait =====');
    const page2 = await browser.newPage();
    await page2.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    await page2.setCookie(...cookies);
    await page2.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    console.log('TEST4: navigated domcontentloaded, waiting 5s (baxia)');
    await new Promise(r => setTimeout(r, 5000));
    await page2.evaluate((t) => localStorage.setItem('token', t), token);
    const chat4 = await page2.evaluate(async ({ url, token, headers }) => {
        const response = await fetch(url, { method: 'POST', headers, credentials: 'include', body: JSON.stringify({ chatId: '', title: 'probe', models: ['qwen3.7-max'], chat_mode: 'normal', chat_type: 't2t', timestamp: Date.now() }) });
        return { status: response.status, body: await response.text() };
    }, { url: BASE + '/api/v2/chats/new', token, headers: makeHeaders() });
    let chatId4 = null;
    try { chatId4 = JSON.parse(chat4.body)?.data?.id || null; } catch {}
    console.log('TEST4 chatId:', chatId4, '| createChat status:', chat4.status);
    if (chatId4) {
        const payload = ivanqoPayload(chatId4);
        const { headers: _h, ...body } = payload;
        const r4 = await page2.evaluate(async ({ url, token, headers, payload }) => {
            const response = await fetch(url, { method: 'POST', headers, credentials: 'include', body: JSON.stringify(payload) });
            return { status: response.status, contentType: response.headers.get('content-type') || '', body: await response.text() };
        }, { url: BASE + '/api/v2/chat/completions?chat_id=' + chatId4, token, headers: ivanqoHeaders(), payload: body });
        console.log('TEST4 status:', r4.status, '| contentType:', r4.contentType);
        console.log('TEST4 body:', r4.body.slice(0, 300));
    }

    console.log('\n===== TEST 5: same tab, reload networkidle2, retry =====');
    await page2.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 90000 });
    await page2.evaluate((t) => localStorage.setItem('token', t), token);
    const chat5 = await page2.evaluate(async ({ url, token, headers }) => {
        const response = await fetch(url, { method: 'POST', headers, credentials: 'include', body: JSON.stringify({ chatId: '', title: 'probe', models: ['qwen3.7-max'], chat_mode: 'normal', chat_type: 't2t', timestamp: Date.now() }) });
        return { status: response.status, body: await response.text() };
    }, { url: BASE + '/api/v2/chats/new', token, headers: makeHeaders() });
    let chatId5 = null;
    try { chatId5 = JSON.parse(chat5.body)?.data?.id || null; } catch {}
    console.log('TEST5 chatId:', chatId5, '| createChat status:', chat5.status);
    if (chatId5) {
        const payload = ivanqoPayload(chatId5);
        const { headers: _h, ...body } = payload;
        const r5 = await page2.evaluate(async ({ url, token, headers, payload }) => {
            const response = await fetch(url, { method: 'POST', headers, credentials: 'include', body: JSON.stringify(payload) });
            return { status: response.status, contentType: response.headers.get('content-type') || '', body: await response.text() };
        }, { url: BASE + '/api/v2/chat/completions?chat_id=' + chatId5, token, headers: ivanqoHeaders(), payload: body });
        console.log('TEST5 status:', r5.status, '| contentType:', r5.contentType);
        console.log('TEST5 body:', r5.body.slice(0, 300));
    }

    console.log('\n===== TEST 6: load Baxia scripts then complete (mimic app) =====');
    await page2.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page2.evaluate((t) => localStorage.setItem('token', t), token);
    await page2.evaluate(async () => {
        const load = (src) => new Promise((resolve) => {
            const s = document.createElement('script');
            s.src = src; s.async = true; s.onload = () => resolve(true); s.onerror = () => resolve(false);
            document.head.appendChild(s);
        });
        await load('https://g.alicdn.com/AWSC/AWSC/awsc.js');
        await load('https://g.alicdn.com/sd/baxia-entry/baxiaCommon.js');
    });
    console.log('TEST6: baxia scripts loaded, waiting 5s');
    await new Promise(r => setTimeout(r, 5000));
    const baxiaState = await page2.evaluate(() => ({ hasAwsc: Boolean(window.AWSC), hasBaxia: Boolean(window.__baxia__) }));
    console.log('TEST6 baxia state:', JSON.stringify(baxiaState));
    const chat6 = await page2.evaluate(async ({ url, token, headers }) => {
        const response = await fetch(url, { method: 'POST', headers, credentials: 'include', body: JSON.stringify({ chatId: '', title: 'probe', models: ['qwen3.7-max'], chat_mode: 'normal', chat_type: 't2t', timestamp: Date.now() }) });
        return { status: response.status, body: await response.text() };
    }, { url: BASE + '/api/v2/chats/new', token, headers: makeHeaders() });
    let chatId6 = null;
    try { chatId6 = JSON.parse(chat6.body)?.data?.id || null; } catch {}
    console.log('TEST6 chatId:', chatId6, '| createChat status:', chat6.status);
    if (chatId6) {
        const payload = ivanqoPayload(chatId6);
        const { headers: _h, ...body } = payload;
        const r6 = await page2.evaluate(async ({ url, token, headers, payload }) => {
            const response = await fetch(url, { method: 'POST', headers, credentials: 'include', body: JSON.stringify(payload) });
            return { status: response.status, contentType: response.headers.get('content-type') || '', body: await response.text() };
        }, { url: BASE + '/api/v2/chat/completions?chat_id=' + chatId6, token, headers: ivanqoHeaders(), payload: body });
        console.log('TEST6 status:', r6.status, '| contentType:', r6.contentType);
        console.log('TEST6 body:', r6.body.slice(0, 300));
    }
} catch (error) {
    console.error('ERROR:', error);
} finally {
    await browser.close();
}
