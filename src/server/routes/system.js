// Служебные эндпоинты: здоровье, статус аккаунтов, модели, прокси скачивания.

import express from 'express';

import { config } from '../../config/index.js';
import { FORGETMEAI_WATERMARK } from '../../shared/branding.js';
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
            watermark: FORGETMEAI_WATERMARK,
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
        logInfo(`Возвращено моделей: ${models.data.length}`);
        res.json(models);
    } catch (error) {
        next(error);
    }
});

router.get('/status', async (req, res, next) => {
    try {
        logInfo('Запрос статуса авторизации');
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
            logWarn('Браузер не инициализирован');
            return res.json({ authenticated: false, message: 'Браузер не инициализирован', accounts });
        }

        if (getAuthenticationStatus()) return res.json({ authenticated: true, accounts });

        await checkAuthentication(context);
        const authenticated = getAuthenticationStatus();
        return res.json({
            authenticated,
            message: authenticated ? 'Авторизация активна' : 'Требуется авторизация',
            accounts
        });
    } catch (error) {
        next(error);
    }
});

// ─── Прокси скачивания медиа ────────────────────────────────────────────────
// Фронтенд не может забрать файл с CDN Qwen напрямую из-за CORS.
// Разрешены только https и домены Qwen/Aliyun; каждый редирект проверяется заново.

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
    // IP-литералы и localhost отсекаем — это классический вектор SSRF.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host === 'localhost') return null;
    if (!ALLOWED_DOWNLOAD_HOSTS.some(domain => host === domain || host.endsWith(`.${domain}`))) return null;

    return url;
}

router.get('/download', async (req, res) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeouts.download);

    try {
        if (!req.query.url) {
            return res.status(400).json({ error: 'Параметр url обязателен' });
        }

        let url = validateDownloadUrl(req.query.url);
        if (!url) {
            return res.status(403).json({ error: 'URL не разрешён (только https и домены Qwen/Aliyun CDN)' });
        }

        let upstream;
        let hops = 0;
        for (;;) {
            upstream = await fetch(url.toString(), { redirect: 'manual', signal: controller.signal });
            if (upstream.status < 300 || upstream.status >= 400) break;

            const location = upstream.headers.get('location');
            if (!location || ++hops > MAX_REDIRECTS) {
                return res.status(502).json({ error: 'Недопустимая цепочка редиректов' });
            }

            let next = null;
            try { next = validateDownloadUrl(new URL(location, url).toString()); } catch { next = null; }
            if (!next) return res.status(403).json({ error: 'Редирект на недопустимый адрес' });
            url = next;
        }

        if (!upstream.ok || !upstream.body) {
            return res.status(502).json({ error: `Источник вернул ${upstream.status}` });
        }

        const name = String(req.query.name || url.pathname.split('/').pop() || 'download')
            .replace(/[^\w.-]+/g, '_')
            .slice(0, 120) || 'download';

        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
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
        logError('Ошибка проксирования скачивания', error);
        if (!res.headersSent) return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        try { return res.end(); } catch { return undefined; }
    } finally {
        clearTimeout(timer);
    }
});

export default router;
