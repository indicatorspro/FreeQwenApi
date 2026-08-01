// Image and video generation.
// Main path — Qwen Chat (chatType t2i/t2v), alternative — DashScope.

import { unixSeconds } from '../shared/ids.js';
import { logError, logInfo } from '../shared/logger.js';
import { mapModel } from '../core/models/mapping.js';
import { sendMessage } from '../core/qwen/client.js';
import { CHAT_TYPES } from '../core/qwen/payload.js';
import { extractMediaUrl } from '../core/qwen/media.js';
import { generateImage as generateImageViaDashScope } from '../core/dashscope/images.js';

/** Qwen Chat model that handles media generation. */
export const CHAT_MEDIA_MODEL = 'qwen3-vl-plus';

const ASPECT_RATIO_BY_SIZE = {
    '1024x1024': '1:1',
    '512x512': '1:1',
    '768x768': '1:1',
    '960x960': '1:1',
    '1024x1792': '9:16',
    '1792x1024': '16:9',
    '1536x864': '16:9',
    '864x1536': '9:16'
};

const DASHSCOPE_SIZE = {
    '1024x1024': '1024*1024',
    '1024x1792': '1024*1792',
    '1792x1024': '1792*1024',
    '512x512': '512*512',
    '768x768': '768*768',
    '960x960': '960*960'
};

/** Normalizes size to an aspect ratio understood by Qwen Chat. */
export function normalizeAspectRatio(size, fallback = '16:9') {
    if (!size) return fallback;
    const value = String(size).trim();
    if (ASPECT_RATIO_BY_SIZE[value]) return ASPECT_RATIO_BY_SIZE[value];
    if (/^\d+:\d+$/.test(value)) return value;
    return fallback;
}

export function normalizeDashScopeSize(size) {
    return DASHSCOPE_SIZE[size] || '1024*1024';
}

/**
 * Image generation.
 * @param {object} options
 * @param {string} options.prompt
 * @param {string} [options.model]
 * @param {string} [options.size]
 * @param {string} [options.aspectRatio]
 * @param {'qwen-chat'|'dashscope'} [options.provider]
 * @param {number} [options.n]
 */
export async function generateImage({
    prompt,
    model,
    size = null,
    aspectRatio = null,
    provider = 'qwen-chat',
    n = 1
}) {
    if (provider === 'dashscope') {
        let imageModel = model || 'qwen-image-plus';
        // OpenAI SDK clients habitually send dall-e-*.
        if (imageModel === 'dall-e-3' || imageModel === 'dall-e-2') imageModel = 'qwen-image-plus';

        const result = await generateImageViaDashScope(prompt, imageModel, {
            n,
            size: normalizeDashScopeSize(size),
            promptExtend: true,
            watermark: false
        });

        if (result.error) {
            logError(`DashScope generation error: ${result.error}`);
            return { error: 'Image generation error', message: result.error };
        }

        return buildImageResponse({ imageUrl: result.imageUrl, prompt, model: imageModel, raw: result, provider: 'dashscope' });
    }

    const chatModel = mapModel(model || CHAT_MEDIA_MODEL);
    const result = await sendMessage({
        message: prompt,
        model: chatModel,
        chatType: CHAT_TYPES.IMAGE,
        size: normalizeAspectRatio(size, aspectRatio || '16:9'),
        waitForCompletion: true
    });

    if (result.error) {
        logError(`Image generation error via Qwen Chat: ${result.error}`);
        return { error: 'Image generation error via Qwen Chat', message: result.error, details: result.details };
    }

    const imageUrl = extractMediaUrl(result, 'image') || result.choices?.[0]?.message?.content || null;
    if (!imageUrl) {
        return { error: 'Qwen Chat did not return an image URL', raw: result, status: 502 };
    }

    logInfo(`Image generated: ${imageUrl}`);
    return buildImageResponse({ imageUrl, prompt, model: chatModel, raw: result });
}

function buildImageResponse({ imageUrl, prompt, model, raw, provider = 'qwen-chat' }) {
    return {
        created: unixSeconds(),
        provider,
        model,
        data: [{ url: imageUrl, revised_prompt: prompt }],
        raw
    };
}

/**
 * Video generation via Qwen Chat.
 * @param {object} options
 * @param {string} options.prompt
 * @param {string} [options.model]
 * @param {string} [options.size]
 * @param {string} [options.aspectRatio]
 * @param {boolean} [options.waitForCompletion]
 */
export async function generateVideo({ prompt, model, size = null, aspectRatio = null, waitForCompletion = true }) {
    const chatModel = mapModel(model || CHAT_MEDIA_MODEL);

    const result = await sendMessage({
        message: prompt,
        model: chatModel,
        chatType: CHAT_TYPES.VIDEO,
        size: normalizeAspectRatio(size, aspectRatio || '16:9'),
        waitForCompletion
    });

    if (result.error) {
        logError(`Video generation error: ${result.error}`);
        return { error: 'Video generation error via Qwen Chat', message: result.error, details: result.details, task_id: result.task_id };
    }

    const videoUrl = result.video_url || extractMediaUrl(result, 'video');
    logInfo(videoUrl ? `Video generated: ${videoUrl}` : `Video generation task created: ${result.task_id}`);

    return {
        id: result.id || result.task_id || `video-${Date.now()}`,
        object: videoUrl ? 'video.generation' : 'video.generation.task',
        created: unixSeconds(),
        provider: 'qwen-chat',
        model: chatModel,
        prompt,
        status: videoUrl ? 'completed' : (result.status || 'processing'),
        task_id: result.task_id || result.id || null,
        video_url: videoUrl || null,
        data: videoUrl ? [{ url: videoUrl }] : [],
        waitForCompletion,
        raw: result
    };
}
