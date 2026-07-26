// Опрос статуса долгих задач Qwen (генерация видео и прочая асинхронщина).

import { config } from '../../config/index.js';
import { delay } from '../../shared/async.js';
import { logDebug, logError, logInfo, logWarn } from '../../shared/logger.js';
import { getViaBrowser } from './transport.js';

const COMPLETED_STATUSES = new Set(['completed', 'success']);
const FAILED_STATUSES = new Set(['failed', 'error']);

/**
 * @param {object} options
 * @param {unknown} options.page — вкладка браузера
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
    logInfo(`Опрос статуса задачи: ${taskId}`);
    const url = `${config.qwen.taskStatusUrl}/${taskId}`;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const result = await getViaBrowser({ page, url, token });

            if (!result.ok) {
                logWarn(`Статус задачи недоступен (${attempt}/${maxAttempts}): ${result.error}`);
                if (attempt < maxAttempts) await delay(interval);
                continue;
            }

            const data = result.data;
            const status = data.task_status || data.status || 'unknown';
            logDebug(`Статус задачи (${attempt}/${maxAttempts}): ${status}`);

            if (COMPLETED_STATUSES.has(status)) {
                logInfo('Задача завершена успешно');
                return { success: true, status: 'completed', data };
            }

            if (FAILED_STATUSES.has(status)) {
                logError('Задача завершилась с ошибкой');
                return {
                    success: false,
                    status: 'failed',
                    error: data.error || data.message || 'Задача завершилась ошибкой',
                    data
                };
            }

            if (attempt < maxAttempts) await delay(interval);
        } catch (error) {
            logError(`Ошибка опроса задачи (${attempt}/${maxAttempts})`, error);
            if (attempt < maxAttempts) await delay(interval);
        }
    }

    logError(`Превышен лимит попыток (${maxAttempts}) для задачи ${taskId}`);
    return { success: false, status: 'timeout', error: 'Превышен таймаут опроса задачи' };
}
