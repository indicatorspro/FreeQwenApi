// Список моделей, доступных аккаунту. Источник — src/AvailableModels.txt,
// который обновляется скриптом models:sync.

import fs from 'fs';

import { config } from '../../config/index.js';
import { logError, logInfo } from '../../shared/logger.js';
import { MODELS_FILE } from '../../shared/paths.js';

let cache = null;

function readModelsFile() {
    try {
        if (!fs.existsSync(MODELS_FILE)) {
            logError(`Файл со списком моделей не найден: ${MODELS_FILE}`);
            return [config.server.defaultModel];
        }
        const models = fs.readFileSync(MODELS_FILE, 'utf8')
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#'));

        return models.length > 0 ? models : [config.server.defaultModel];
    } catch (error) {
        logError('Ошибка чтения списка моделей', error);
        return [config.server.defaultModel];
    }
}

/** @returns {string[]} */
export function getAvailableModels() {
    if (!cache) cache = readModelsFile();
    return cache;
}

/** Сбрасывает кеш (после models:sync). */
export function reloadModels() {
    cache = null;
    return getAvailableModels();
}

export function isValidModel(model) {
    return getAvailableModels().includes(model);
}

/** Список моделей в формате OpenAI `GET /v1/models`. */
export function listModelsOpenAI() {
    return {
        object: 'list',
        data: getAvailableModels().map(model => ({
            id: model,
            object: 'model',
            created: 0,
            owned_by: 'qwen',
            permission: []
        }))
    };
}

export function logAvailableModels() {
    const models = getAvailableModels();
    logInfo(`Доступно моделей: ${models.length}`);
    return models;
}
