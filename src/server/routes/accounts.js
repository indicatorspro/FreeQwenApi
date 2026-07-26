// Управление аккаунтами Qwen из дашборда.
// Все эндпоинты доступны только с localhost и только с совпадающим Origin:
// здесь ходят токены аккаунтов.

import express from 'express';

import { logInfo } from '../../shared/logger.js';
import {
    accountStatus,
    addAccountFromToken,
    decodeTokenInfo,
    deleteAccount,
    listAccounts,
    markInvalid,
    markRateLimited,
    markValid,
    setAccountLabel,
    updateAccountToken
} from '../../core/accounts/store.js';
import { getBrowserContext } from '../../browser/browser.js';
import { testToken } from '../../core/qwen/tokens.js';
import { localOnly, sameOriginOnly } from '../middleware/index.js';

const router = express.Router();

router.use('/accounts', localOnly, sameOriginOnly);

router.get('/accounts', (req, res, next) => {
    try {
        const accounts = listAccounts().map(account => {
            const info = decodeTokenInfo(account.token);
            return {
                id: account.id,
                label: account.label || '',
                status: accountStatus(account),
                exp: info.exp,
                resetAt: account.resetAt || null,
                // Показываем только края токена — целиком он в ответе не нужен.
                preview: `${String(account.token).slice(0, 10)}…${String(account.token).slice(-4)}`
            };
        });
        res.json({ accounts });
    } catch (error) {
        next(error);
    }
});

router.post('/accounts', (req, res, next) => {
    try {
        const token = req.body?.token;
        if (!token) return res.status(400).json({ error: 'Не передан token' });

        const result = addAccountFromToken(token, req.body?.label);
        if (result.error) return res.status(400).json(result);

        logInfo(`Добавлен аккаунт: ${result.id}`);
        return res.json({ ok: true, id: result.id });
    } catch (error) {
        next(error);
    }
});

router.delete('/accounts/:id', (req, res, next) => {
    try {
        const result = deleteAccount(req.params.id);
        if (result.error) return res.status(400).json(result);

        logInfo(`Удалён аккаунт: ${req.params.id}`);
        return res.json({ ok: true });
    } catch (error) {
        next(error);
    }
});

/** POST, а не GET: проверка меняет состояние аккаунта (mark*). */
router.post('/accounts/:id/check', async (req, res, next) => {
    try {
        const account = listAccounts().find(item => item.id === req.params.id);
        if (!account) return res.status(404).json({ error: 'Аккаунт не найден' });

        const context = getBrowserContext();
        if (!context) return res.status(503).json({ error: 'Браузер не инициализирован' });

        const result = await testToken(context, account.token);
        let status = 'ERROR';

        if (result === 'OK') {
            status = 'OK';
            if (account.invalid || account.resetAt) markValid(account.id);
        } else if (result === 'RATELIMIT') {
            status = 'WAIT';
            markRateLimited(account.id);
        } else if (result === 'UNAUTHORIZED') {
            status = 'INVALID';
            if (!account.invalid) markInvalid(account.id);
        }

        const resetAt = status === 'WAIT'
            ? new Date(Date.now() + 24 * 3600 * 1000).toISOString()
            : (account.resetAt || null);

        return res.json({ id: account.id, status, exp: decodeTokenInfo(account.token).exp, resetAt });
    } catch (error) {
        next(error);
    }
});

router.post('/accounts/:id/update', (req, res, next) => {
    try {
        const result = updateAccountToken(req.params.id, req.body?.token);
        if (result.error) return res.status(400).json(result);

        logInfo(`Обновлён токен аккаунта: ${req.params.id}`);
        return res.json(result);
    } catch (error) {
        next(error);
    }
});

router.post('/accounts/:id/label', (req, res, next) => {
    try {
        const result = setAccountLabel(req.params.id, req.body?.label);
        if (result.error) return res.status(400).json(result);

        logInfo(`Изменён ярлык аккаунта: ${req.params.id}`);
        return res.json(result);
    } catch (error) {
        next(error);
    }
});

export default router;
