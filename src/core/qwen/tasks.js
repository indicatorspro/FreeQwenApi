// Polling status of long Qwen tasks (video generation and other async operations).

import { config } from '../../config/index.js';
import { delay } from '../../shared/async.js';
import { logDebug, logError, logInfo, logWarn } from '../../shared/logger.js';
import { getViaBrowser } from './transport.js';

const COMPLETED_STATUSES = new Set(['completed', 'success']);
const FAILED_STATUSES = new Set(['failed', 'error']);

/**
 * @param {object} options
 * @param {unknown} options.page — browser tab
 * @param {string} options.taskId
 * @param {string} options.token
 * @param {number} [options.maxAttempts]
 * @param {number} [options.interval]
 * @returns {Promise<{success: boolean, status: string, data?: object, error?: string}>}
 */
export async function pollTaskStatus({
    page,
    taskId,
    token,
    maxAttempts = config.limits.taskPollMaxAttempts,
    interval = config.limits.taskPollInterval
}) {
    logInfo(`Polling task status: ${taskId}`);
    const url = `${config.qwen.taskStatusUrl}/${taskId}`;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const result = await getViaBrowser({ page, url, token });

            if (!result.ok) {
                logWarn(`Task status unavailable (${attempt}/${maxAttempts}): ${result.error}`);
                if (attempt < maxAttempts) await delay(interval);
                continue;
            }

            const data = result.data;
            const status = data.task_status || data.status || 'unknown';
            logDebug(`Task status (${attempt}/${maxAttempts}): ${status}`);

            if (COMPLETED_STATUSES.has(status)) {
                logInfo('Task completed successfully');
                return { success: true, status: 'completed', data };
            }

            if (FAILED_STATUSES.has(status)) {
                logError('Task failed');
                return {
                    success: false,
                    status: 'failed',
                    error: data.error || data.message || 'Task failed',
                    data
                };
            }

            if (attempt < maxAttempts) await delay(interval);
        } catch (error) {
            logError(`Task polling error (${attempt}/${maxAttempts})`, error);
            if (attempt < maxAttempts) await delay(interval);
        }
    }

    logError(`Attempt limit (${maxAttempts}) exceeded for task ${taskId}`);
    return { success: false, status: 'timeout', error: 'Task polling timed out' };
}
