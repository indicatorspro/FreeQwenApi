// Image generation via the official DashScope API (requires DASHSCOPE_API_KEY).
// Alternative path to Qwen Chat: that one works without a key but is slower.

import axios from 'axios';

import { config } from '../../config/index.js';
import { delay } from '../../shared/async.js';
import { logDebug, logError, logInfo } from '../../shared/logger.js';

const API_BASE = 'https://dashscope-intl.aliyuncs.com/api/v1';
const POLL_MAX_ATTEMPTS = 60;
const POLL_INTERVAL = 2_000;

export const IMAGE_MODELS = Object.freeze([
    'qwen-image-max',
    'qwen-image-plus',
    'qwen-image',
    'wan2.6-t2i',
    'wan2.5-t2i-preview',
    'wan2.2-t2i-flash'
]);

export function getAvailableImageModels() {
    return [...IMAGE_MODELS];
}

/** Polls an asynchronous DashScope task. */
async function pollTask(taskId, apiKey) {
    for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
        try {
            const response = await axios.get(`${API_BASE}/tasks/${taskId}`, {
                headers: { Authorization: `Bearer ${apiKey}` }
            });

            const status = response.data.output?.task_status;
            logDebug(`Task ${taskId} status: ${status} (${attempt}/${POLL_MAX_ATTEMPTS})`);

            if (status === 'SUCCEEDED') {
                const imageUrl = response.data.output?.results?.[0]?.url;
                if (!imageUrl) return { error: 'Image not found in result' };
                logInfo(`Image generated: ${imageUrl}`);
                return { success: true, imageUrl, taskId, model: response.data.input?.model || 'unknown' };
            }

            if (status === 'FAILED' || status === 'CANCELLED') {
                return {
                    error: `Task finished with status ${status}`,
                    message: response.data.output?.message || 'Unknown error'
                };
            }

            await delay(POLL_INTERVAL);
        } catch (error) {
            logError(`Error polling task ${taskId}`, error);
            if (attempt === POLL_MAX_ATTEMPTS) return { error: `Polling error: ${error.message}` };
            await delay(POLL_INTERVAL);
        }
    }

    return { error: 'Image generation timed out' };
}

/**
 * @param {string} prompt
 * @param {string} [model]
 * @param {object} [options]
 * @returns {Promise<{success: true, imageUrl: string}|{error: string}>}
 */
export async function generateImage(prompt, model = 'qwen-image-plus', options = {}) {
    const apiKey = config.qwen.dashscopeApiKey;
    if (!apiKey) {
        return { error: 'DASHSCOPE_API_KEY is not set' };
    }

    try {
        logInfo(`Generating image via DashScope (${model})…`);

        const isWanModel = model.startsWith('wan');
        const response = await axios.post(
            `${API_BASE}/services/aigc/text2image/image-synthesis`,
            {
                model,
                input: { prompt, negative_prompt: options.negativePrompt || ' ' },
                parameters: {
                    size: options.size || '1024*1024',
                    n: options.n || 1,
                    prompt_extend: options.promptExtend !== false,
                    watermark: options.watermark || false
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    // Wan models only work in asynchronous mode.
                    'X-DashScope-Async': isWanModel ? 'enable' : undefined
                },
                timeout: 120_000
            }
        );

        const data = response.data;

        if (data.output?.task_id) {
            logInfo(`Task created: ${data.output.task_id}`);
            return pollTask(data.output.task_id, apiKey);
        }

        const imageUrl = data.output?.results?.[0]?.url;
        if (imageUrl) {
            logInfo(`Image generated: ${imageUrl}`);
            return { success: true, imageUrl, taskId: data.output?.task_id, model, prompt };
        }

        return { error: 'Unexpected DashScope response format', rawData: data };
    } catch (error) {
        logError('Error generating image', error);
        return { error: error.response?.data?.message || error.message || 'Unknown error' };
    }
}

/** Whether DashScope is available with the current key. */
export async function checkImageApiAvailability() {
    const apiKey = config.qwen.dashscopeApiKey;
    if (!apiKey) return false;

    try {
        await axios.get(`${API_BASE}/models`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            timeout: 5_000
        });
        return true;
    } catch (error) {
        logDebug(`DashScope unavailable: ${error.message}`);
        return false;
    }
}
