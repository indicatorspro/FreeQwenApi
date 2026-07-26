// Генерация изображений и видео + статус долгих задач.

import express from 'express';

import { logInfo } from '../../shared/logger.js';
import { accountsSummary } from '../../core/accounts/store.js';
import { checkImageApiAvailability, getAvailableImageModels } from '../../core/dashscope/images.js';
import { config } from '../../config/index.js';
import { getTaskStatus } from '../../core/qwen/client.js';
import { CHAT_MEDIA_MODEL, generateImage, generateVideo } from '../../services/media.js';

const router = express.Router();

/** POST /api/images/generations — по умолчанию через Qwen Chat, без API-ключей. */
router.post('/images/generations', async (req, res, next) => {
    try {
        const { prompt, model, n, size, provider, aspect_ratio: aspectRatio } = req.body || {};

        if (!prompt) return res.status(400).json({ error: 'Параметр "prompt" обязателен' });
        logInfo('Запрос на генерацию изображения');

        if (provider === 'dashscope' && !config.qwen.dashscopeApiKey) {
            return res.status(503).json({
                error: 'DashScope API не настроен',
                message: 'Задайте DASHSCOPE_API_KEY или используйте provider=qwen-chat'
            });
        }

        const result = await generateImage({ prompt, model, size, aspectRatio, provider, n });
        if (result.error) {
            return res.status(result.status || 500).json(result);
        }
        return res.json(result);
    } catch (error) {
        next(error);
    }
});

/** POST /api/videos/generations — генерация видео через Qwen Chat. */
router.post('/videos/generations', async (req, res, next) => {
    try {
        const { prompt, model, size, wait, waitForCompletion, aspect_ratio: aspectRatio } = req.body || {};

        if (!prompt) return res.status(400).json({ error: 'Параметр "prompt" обязателен' });
        logInfo('Запрос на генерацию видео');

        const result = await generateVideo({
            prompt,
            model,
            size,
            aspectRatio,
            waitForCompletion: waitForCompletion ?? wait ?? true
        });

        if (result.error) return res.status(500).json(result);
        return res.json(result);
    } catch (error) {
        next(error);
    }
});

/** GET /api/tasks/status/:taskId — статус долгой задачи. */
router.get('/tasks/status/:taskId', async (req, res, next) => {
    try {
        const { taskId } = req.params;
        if (!taskId) return res.status(400).json({ error: 'taskId обязателен' });

        const wait = ['1', 'true', 'yes'].includes(String(req.query.wait || '').toLowerCase());
        const result = await getTaskStatus(taskId, wait);

        if (result.error && !result.data) return res.status(500).json(result);
        return res.json(result);
    } catch (error) {
        next(error);
    }
});

router.get('/images/models', (req, res, next) => {
    try {
        res.json({
            object: 'list',
            data: [
                {
                    id: CHAT_MEDIA_MODEL,
                    object: 'model',
                    created: Date.now(),
                    owned_by: 'qwen-chat',
                    permission: [],
                    capability: 'qwen_chat_image_generation',
                    provider: 'qwen-chat'
                },
                ...getAvailableImageModels().map(model => ({
                    id: model,
                    object: 'model',
                    created: Date.now(),
                    owned_by: 'qwen',
                    permission: [],
                    capability: 'image_generation',
                    provider: 'dashscope'
                }))
            ]
        });
    } catch (error) {
        next(error);
    }
});

router.get('/videos/models', (req, res) => {
    res.json({
        object: 'list',
        data: [{
            id: CHAT_MEDIA_MODEL,
            object: 'model',
            created: Date.now(),
            owned_by: 'qwen-chat',
            permission: [],
            capability: 'qwen_chat_video_generation',
            provider: 'qwen-chat'
        }]
    });
});

router.get('/images/status', async (req, res, next) => {
    try {
        const accounts = accountsSummary();
        const dashScopeAvailable = await checkImageApiAvailability();

        res.json({
            qwenChat: {
                available: accounts.available > 0,
                model: CHAT_MEDIA_MODEL,
                message: accounts.available > 0
                    ? 'Генерация изображений через Qwen Chat доступна'
                    : 'Нет активных аккаунтов Qwen Chat'
            },
            dashscope: {
                available: dashScopeAvailable,
                apiKeyConfigured: Boolean(config.qwen.dashscopeApiKey),
                message: dashScopeAvailable
                    ? 'DashScope доступен'
                    : config.qwen.dashscopeApiKey
                        ? 'DashScope недоступен или ключ неверен'
                        : 'DASHSCOPE_API_KEY не задан'
            }
        });
    } catch (error) {
        next(error);
    }
});

router.get('/videos/status', (req, res) => {
    const accounts = accountsSummary();
    res.json({
        available: accounts.available > 0,
        model: CHAT_MEDIA_MODEL,
        accounts,
        message: accounts.available > 0
            ? 'Генерация видео через Qwen Chat доступна'
            : 'Нет активных аккаунтов Qwen Chat'
    });
});

export default router;
