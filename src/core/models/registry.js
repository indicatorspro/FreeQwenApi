// List of models available to the account. Source — src/AvailableModels.txt,
// which is updated by the models:sync script.

import fs from 'fs';

import { config } from '../../config/index.js';
import { logError, logInfo } from '../../shared/logger.js';
import { MODELS_FILE } from '../../shared/paths.js';

let cache = null;

function readModelsFile() {
    try {
        if (!fs.existsSync(MODELS_FILE)) {
            logError(`Models list file not found: ${MODELS_FILE}`);
            return [config.server.defaultModel];
        }
        const models = fs.readFileSync(MODELS_FILE, 'utf8')
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#'));

        return models.length > 0 ? models : [config.server.defaultModel];
    } catch (error) {
        logError('Error reading models list', error);
        return [config.server.defaultModel];
    }
}

/** @returns {string[]} */
export function getAvailableModels() {
    if (!cache) cache = readModelsFile();
    return cache;
}

/** Resets the cache (after models:sync). */
export function reloadModels() {
    cache = null;
    return getAvailableModels();
}

export function isValidModel(model) {
    return getAvailableModels().includes(model);
}

/** Model list in OpenAI `GET /v1/models` format. */
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
    logInfo(`Available models: ${models.length}`);
    return models;
}
