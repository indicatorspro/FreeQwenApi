// Локальная копия истории чатов (session/history/<chatId>.json).
// Основная история живёт на серверах Qwen; эта нужна для дашборда и отладки.

import fs from 'fs';
import path from 'path';

import { config } from '../../config/index.js';
import { logDebug, logError, logInfo } from '../../shared/logger.js';

import { HISTORY_DIR, ensureDir } from '../../shared/paths.js';

/**
 * chatId попадает в путь файла, поэтому допускаются только безопасные символы.
 * @returns {string|null}
 */
function sanitizeChatId(chatId) {
    if (typeof chatId !== 'string' || !chatId) return null;
    if (chatId.includes('/') || chatId.includes('\\') || chatId.includes('..')) return null;
    if (!/^[a-zA-Z0-9_-]+$/.test(chatId)) return null;
    return chatId;
}

function historyFilePath(chatId) {
    const safeId = sanitizeChatId(chatId);
    if (!safeId) throw new Error(`Некорректный chatId: ${String(chatId).slice(0, 50)}`);

    const filePath = path.join(HISTORY_DIR, `${safeId}.json`);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(HISTORY_DIR) + path.sep)) {
        throw new Error(`Путь вне директории истории: ${String(chatId).slice(0, 50)}`);
    }
    return filePath;
}

function emptyChat(chatId) {
    return {
        id: chatId,
        name: `Новый чат ${new Date().toLocaleString()}`,
        created: Date.now(),
        messages: []
    };
}

export function initHistoryDirectory() {
    ensureDir(HISTORY_DIR);
}

export function saveHistory(chatId, data) {
    try {
        initHistoryDirectory();
        fs.writeFileSync(historyFilePath(chatId), JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (error) {
        logError(`Не удалось сохранить историю чата ${chatId}`, error);
        return false;
    }
}

export function loadHistory(chatId) {
    try {
        const filePath = historyFilePath(chatId);
        if (!fs.existsSync(filePath)) return emptyChat(chatId);

        const raw = fs.readFileSync(filePath, 'utf8');
        let data;
        try {
            data = JSON.parse(raw);
        } catch (error) {
            logError(`Не удалось разобрать историю чата ${chatId}`, error);
            return emptyChat(chatId);
        }

        // Совместимость со старым форматом, где файл был просто массивом.
        if (Array.isArray(data)) {
            return { ...emptyChat(chatId), messages: data, wasConverted: true };
        }

        return {
            id: data.id || chatId,
            name: data.name || `Чат ${chatId.slice(0, 6)}`,
            created: data.created || Date.now(),
            messages: Array.isArray(data.messages) ? data.messages : []
        };
    } catch (error) {
        logError(`Не удалось загрузить историю чата ${chatId}`, error);
        return emptyChat(chatId);
    }
}

/** Дописывает пару сообщений, обрезая историю по лимиту. */
export function appendMessages(chatId, messages) {
    if (!chatId || !Array.isArray(messages) || messages.length === 0) return false;

    try {
        const chat = loadHistory(chatId);
        const combined = [...chat.messages, ...messages];
        const limit = config.limits.maxHistoryLength;

        chat.messages = combined.length > limit
            ? [combined[0], ...combined.slice(combined.length - limit + 1)]
            : combined;

        return saveHistory(chatId, chat);
    } catch (error) {
        logDebug(`Не удалось дописать историю чата ${chatId}: ${error.message}`);
        return false;
    }
}

export function chatExists(chatId) {
    try {
        return fs.existsSync(historyFilePath(chatId));
    } catch {
        return false;
    }
}

export function deleteChat(chatId) {
    try {
        const filePath = historyFilePath(chatId);
        if (!fs.existsSync(filePath)) return false;
        fs.unlinkSync(filePath);
        logInfo(`Чат ${chatId} удалён`);
        return true;
    } catch (error) {
        logError(`Не удалось удалить чат ${chatId}`, error);
        return false;
    }
}

export function listChats() {
    try {
        initHistoryDirectory();
        return fs.readdirSync(HISTORY_DIR)
            .filter(file => file.endsWith('.json'))
            .map(file => {
                const chatId = file.replace('.json', '');
                const chat = loadHistory(chatId);
                return {
                    id: chatId,
                    name: chat.name,
                    created: chat.created,
                    messageCount: chat.messages.length,
                    userMessageCount: chat.messages.filter(message => message.role === 'user').length
                };
            })
            .sort((a, b) => b.created - a.created);
    } catch (error) {
        logError('Не удалось получить список чатов', error);
        return [];
    }
}
