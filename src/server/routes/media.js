// Image and video generation + long task status.

import express from 'express';

import { logInfo } from '../../shared/logger.js';
import { accountsSummary } from '../../core/accounts/store.js';
import { checkImageApiAvailability, getAvailableImageModels } from '../../core/dashscope/images.js';
import { config } from '../../config/index.js';
import { getTaskStatus } from '../../core/qwen/client.js';
import { CHAT_MEDIA_MODEL, generateImage, generateVideo } from '../../services/media.js';
import { sendApiResultError } from '../apiErrors.js';

const router = express.Router();

/** POST /api/images/generations — by default via Qwen Chat, no API keys. */
router.post('/images/generations', async (req, res, next) => {
    try {
        const { prompt, model, n, size, provider, aspect_ratio: aspectRatio } = req.body || {};

        if (!prompt) {
            return sendApiResultError(res, { error: 'Parameter "prompt" is required', invalidRequest: true });
        }
        logInfo('Image generation request');

        if (provider === 'dashscope' && !config.qwen.dashscopeApiKey) {
            return sendApiResultError(res, {
                error: 'DashScope API not configured',
                details: 'Set DASHSCOPE_API_KEY or use provider=qwen-chat',
                status: 503
            });
        }

        const result = await generateImage({ prompt, model, size, aspectRatio, provider, n });
        if (result.error) {
            return sendApiResultError(res, result);
        }
        return res.json(result);
    } catch (error) {
        next(error);
    }
});

/** POST /api/videos/generations — video generation via Qwen Chat. */
router.post('/videos/generations', async (req, res, next) => {
    try {
        const { prompt, model, size, wait, waitForCompletion, aspect_ratio: aspectRatio } = req.body || {};

        if (!prompt) {
            return sendApiResultError(res, { error: 'Parameter "prompt" is required', invalidRequest: true });
        }
        logInfo('Video generation request');

        const result = await generateVideo({
            prompt,
            model,
            size,
            aspectRatio,
            waitForCompletion: waitForCompletion ?? wait ?? true
        });

        if (result.error) return sendApiResultError(res, result);
        return res.json(result);
    } catch (error) {
        next(error);
    }
});

/** GET /api/tasks/status/:taskId — status of a long-running task. */
router.get('/tasks/status/:taskId', async (req, res, next) => {
    try {
        const { taskId } = req.params;
        if (!taskId) {
            return sendApiResultError(res, { error: 'taskId is required', invalidRequest: true });
        }

        const wait = ['1', 'true', 'yes'].includes(String(req.query.wait || '').toLowerCase());
        const result = await getTaskStatus(taskId, wait);

        if (result.error && !result.data) return sendApiResultError(res, result);
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
                    ? 'Image generation via Qwen Chat is available'
                    : 'No active Qwen Chat accounts'
            },
            dashscope: {
                available: dashScopeAvailable,
                apiKeyConfigured: Boolean(config.qwen.dashscopeApiKey),
                message: dashScopeAvailable
                    ? 'DashScope is available'
                    : config.qwen.dashscopeApiKey
                        ? 'DashScope is unavailable or the key is invalid'
                        : 'DASHSCOPE_API_KEY is not set'
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
            ? 'Video generation via Qwen Chat is available'
            : 'No active Qwen Chat accounts'
    });
});

export default router;
