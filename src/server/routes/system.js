// Service endpoints: health, account status, models, download proxy.

import express from 'express';

import { config } from '../../config/index.js';
import { logError, logInfo, logWarn } from '../../shared/logger.js';
import { accountsSummary, isAvailable, listAccounts, markInvalid, markRateLimited, markValid } from '../../core/accounts/store.js';
import { getAvailableModels, listModelsOpenAI } from '../../core/models/registry.js';
import { getBrowserContext, getAuthenticationStatus } from '../../browser/browser.js';
import { checkAuthentication } from '../../browser/auth.js';
import { testToken } from '../../core/qwen/tokens.js';

const router = express.Router();

router.get('/health', (req, res, next) => {
    try {
        const accounts = accountsSummary();
        res.json({
            ok: accounts.available > 0,
            service: 'FreeQwenApi',
            baseUrl: '/api',
            models: getAvailableModels().length,
            accounts,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        next(error);
    }
});

router.get('/models', (req, res, next) => {
    try {
        const models = listModelsOpenAI();
        logInfo(`Models returned: ${models.data.length}`);
        res.json(models);
    } catch (error) {
        next(error);
    }
});

router.get('/status', async (req, res, next) => {
    try {
        logInfo('Authentication status request');
        const context = getBrowserContext();

        const accounts = await Promise.all(listAccounts().map(async account => {
            const info = { id: account.id, status: 'UNKNOWN', resetAt: account.resetAt || null };

            if (!isAvailable(account)) {
                info.status = account.invalid ? 'INVALID' : 'WAIT';
                return info;
            }

            if (!context) {
                info.status = 'UNKNOWN';
                return info;
            }

            const result = await testToken(context, account.token);
            if (result === 'OK') {
                info.status = 'OK';
                if (account.invalid || account.resetAt) markValid(account.id);
            } else if (result === 'RATELIMIT') {
                info.status = 'WAIT';
                markRateLimited(account.id);
            } else if (result === 'UNAUTHORIZED') {
                info.status = 'INVALID';
                if (!account.invalid) markInvalid(account.id);
            } else {
                info.status = 'ERROR';
            }
            return info;
        }));

        if (!context) {
            logWarn('Browser not initialized');
            return res.json({ authenticated: false, message: 'Browser not initialized', accounts });
        }

        if (getAuthenticationStatus()) return res.json({ authenticated: true, accounts });

        await checkAuthentication(context);
        const authenticated = getAuthenticationStatus();
        return res.json({
            authenticated,
            message: authenticated ? 'Authentication active' : 'Authentication required',
            accounts
        });
    } catch (error) {
        next(error);
    }
});

// ─── Media download proxy ───────────────────────────────────────────────────
// Frontend cannot fetch a file from Qwen CDN directly because of CORS.
// Only https and Qwen/Aliyun domains are allowed; each redirect is revalidated.

const ALLOWED_DOWNLOAD_HOSTS = ['qwenlm.ai', 'aliyuncs.com', 'alicdn.com', 'aliyun.com'];
const MAX_REDIRECTS = 3;

function validateDownloadUrl(raw) {
    let url;
    try {
        url = new URL(String(raw));
    } catch {
        return null;
    }

    if (url.protocol !== 'https:') return null;

    const host = url.hostname.toLowerCase();
    // Reject IP literals and localhost — this is a classic SSRF vector.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host === 'localhost') return null;
    if (!ALLOWED_DOWNLOAD_HOSTS.some(domain => host === domain || host.endsWith(`.${domain}`))) return null;

    return url;
}

router.get('/download', async (req, res) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeouts.download);

    try {
        if (!req.query.url) {
            return res.status(400).json({ error: 'url parameter is required' });
        }

        let url = validateDownloadUrl(req.query.url);
        if (!url) {
            return res.status(403).json({ error: 'URL not allowed (https and Qwen/Aliyun CDN domains only)' });
        }

        let upstream;
        let hops = 0;
        for (;;) {
            upstream = await fetch(url.toString(), {
                redirect: 'manual',
                signal: controller.signal,
                headers: {
                    'Referer': 'https://chat.qwen.ai/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                },
            });
            if (upstream.status < 300 || upstream.status >= 400) break;

            const location = upstream.headers.get('location');
            if (!location || ++hops > MAX_REDIRECTS) {
                return res.status(502).json({ error: 'Invalid redirect chain' });
            }

            let next = null;
            try { next = validateDownloadUrl(new URL(location, url).toString()); } catch { next = null; }
            if (!next) return res.status(403).json({ error: 'Redirect to disallowed address' });
            url = next;
        }

        if (!upstream.ok || !upstream.body) {
            return res.status(502).json({ error: `Source returned ${upstream.status}` });
        }

        const name = String(req.query.name || url.pathname.split('/').pop() || 'download')
            .replace(/[^\w.-]+/g, '_')
            .slice(0, 120) || 'download';

        const inline = req.query.inline === '1' || req.query.inline === 'true';
        if (!inline) {
            res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        }
        const contentType = upstream.headers.get('content-type');
        if (contentType) res.setHeader('Content-Type', contentType);
        const contentLength = upstream.headers.get('content-length');
        if (contentLength) res.setHeader('Content-Length', contentLength);

        const reader = upstream.body.getReader();
        res.on('close', () => { reader.cancel().catch(() => {}); });

        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.write(Buffer.from(value))) {
                await new Promise(resolve => res.once('drain', resolve));
            }
        }

        return res.end();
    } catch (error) {
        logError('Download proxy error', error);
        if (!res.headersSent) return res.status(500).json({ error: 'Internal server error' });
        try { return res.end(); } catch { return undefined; }
    } finally {
        clearTimeout(timer);
    }
});

export default router;
