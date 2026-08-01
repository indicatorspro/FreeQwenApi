import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

puppeteer.use(StealthPlugin());

const ACCOUNT = process.env.PROBE_ACCOUNT || 'acc_1785510149756';
const MODEL = process.env.PROBE_MODEL || 'qwen3.7-max';
const WITH_BAXIA = process.env.PROBE_BAXIA !== '0';
const BASE = 'https://chat.qwen.ai';

const tokens = JSON.parse(fs.readFileSync('session/tokens.json', 'utf8'));
const token = tokens.find(t => t.id === ACCOUNT)?.token;
if (!token) { console.error('NO TOKEN'); process.exit(1); }

const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--disable-web-security', '--disable-features=IsolateOrigins,site-per-process', '--disable-gpu'],
    protocolTimeout: 60000
});

try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    const cookies = JSON.parse(fs.readFileSync(`session/accounts/${ACCOUNT}/cookies.json`, 'utf8'));
    await page.setCookie(...cookies);

const WAIT_UNTIL = process.env.PROBE_WAIT || 'domcontentloaded';

    await page.goto(BASE + '/', { waitUntil: WAIT_UNTIL, timeout: 60000 });
    await page.evaluate((t) => localStorage.setItem('token', t), token);

    if (WITH_BAXIA) {
        await page.evaluate(async () => {
            const load = (src) => new Promise((resolve) => {
                const s = document.createElement('script');
                s.src = src; s.async = true; s.onload = () => resolve(true); s.onerror = () => resolve(false);
                document.head.appendChild(s);
            });
            await load('https://g.alicdn.com/AWSC/AWSC/awsc.js');
            await load('https://g.alicdn.com/sd/baxia-entry/baxiaCommon.js');
        });
        console.log('Baxia scripts loaded');
    }
    const POLL = process.env.PROBE_POLL !== '0';
    if (POLL) {
        const deadline = Date.now() + 12000;
        let ready = false;
        while (Date.now() < deadline) {
            ready = await page.evaluate(() => {
                try {
                    return Boolean(window.AWSC) || String(window.fetch).length > 100;
                } catch { return false; }
            }).catch(() => false);
            if (ready) break;
            await new Promise(r => setTimeout(r, 250));
        }
        console.log(`Poll fetch patch ready=${ready} after ${Date.now() - (deadline - 12000)}ms`);
    } else {
        await new Promise(r => setTimeout(r, 5000));
    }

    const state = await page.evaluate(() => {
        try {
            return { hasAwsc: Boolean(window.AWSC), hasBaxia: Boolean(window.__baxia__), fetchPatched: window.fetch.toString().length > 100 ? 'patched' : 'native' };
        } catch { return {}; }
    });
    console.log('State:', JSON.stringify(state));

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'X-Accel-Buffering': 'no',
        'X-Request-Id': crypto.randomUUID()
    };

    const createChat = await page.evaluate(async ({ url, token, headers }) => {
        const r = await fetch(url, { method: 'POST', headers, credentials: 'include', body: JSON.stringify({ chatId: '', title: 'probe', models: ['qwen3.7-max'], chat_mode: 'normal', chat_type: 't2t', timestamp: Date.now() }) });
        return { status: r.status, body: await r.text() };
    }, { url: BASE + '/api/v2/chats/new', token, headers });
    let chatId = null;
    try { chatId = JSON.parse(createChat.body)?.data?.id || null; } catch {}
    console.log('chatId:', chatId, '| createChat:', createChat.status);

    if (!chatId) process.exit(0);

    const now = Math.floor(Date.now() / 1000);
    const payload = {
        stream: true, version: '2.1', incremental_output: true, chatId, parentId: '', chat_id: chatId, chat_mode: 'normal',
        messages: [{ fid: crypto.randomUUID(), parentId: '', parent_id: null, role: 'user', content: 'oi', chat_type: 't2t', sub_chat_type: 't2t', timestamp: now, user_action: 'chat', model: '', models: [MODEL], files: [], childrenIds: [crypto.randomUUID()], extra: { meta: { subChatType: 't2t' } }, feature_config: { thinking_enabled: /max-preview/.test(MODEL) || /thinking/.test(MODEL), output_schema: 'phase' } }],
        model: MODEL, parent_id: null, timestamp: now
    };

    const t0 = Date.now();
    const r = await page.evaluate(async ({ url, token, headers, payload }) => {
        const response = await fetch(url, { method: 'POST', headers, credentials: 'include', body: JSON.stringify(payload) });
        return { status: response.status, contentType: response.headers.get('content-type') || '', body: await response.text() };
    }, { url: BASE + '/api/v2/chat/completions?chat_id=' + chatId, token, headers, payload });

    console.log(`Completion in ${Date.now() - t0}ms | status: ${r.status} | contentType: ${r.contentType}`);
    fs.writeFileSync('logs/probe-raw-sse.log', r.body);
    console.log('Body length:', r.body.length);

    const lines = r.body.split('\n');
    const phases = new Map();
    const contents = new Map();
    let doneSeen = false;
    for (const line of lines) {
        const t = line.trim();
        if (t === 'data: [DONE]') { doneSeen = true; continue; }
        if (!t.startsWith('data:')) continue;
        const p = t.slice(5).trim();
        if (!p) continue;
        let c;
        try { c = JSON.parse(p); } catch { continue; }
        const choice = c.choices?.[0];
        const d = choice?.delta;
        const key = d
            ? `phase=${d.phase || 'none'}|status=${d.status || '-'}|finish=${choice.finish_reason || '-'}`
            : `no-delta|keys=${Object.keys(c).join(',')}`;
        phases.set(key, (phases.get(key) || 0) + 1);
        if (d?.content) {
            const ck = `phase=${d.phase || 'none'}`;
            contents.set(ck, (contents.get(ck) || '') + d.content);
        }
    }
    console.log('SSE summary:');
    for (const [k, v] of phases) console.log(`  ${v}x  ${k}`);
    console.log('Content by phase:');
    for (const [k, v] of contents) console.log(`  [${k}] ${v.length} chars`);
    console.log('usage chunk:', r.body.match(/"usage":\{[^}]*\}/)?.[0] || 'none');
    console.log('DONE seen:', doneSeen);
    console.log('Last 2 data lines:');
    const dataLines = lines.map(l => l.trim()).filter(l => l.startsWith('data:')).slice(-2);
    for (const l of dataLines) console.log('  ' + l);
} catch (error) {
    console.error('ERROR:', String(error.message || error));
} finally {
    await browser.close();
}
