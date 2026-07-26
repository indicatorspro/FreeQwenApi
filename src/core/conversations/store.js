// Состояние разговоров: связь между идентификаторами клиента и чатами Qwen.
//
// Раньше эти две Map жили прямо в роутере вместе с setInterval, из-за чего
// сервис нельзя было ни протестировать, ни переиспользовать вне Express.

import { config } from '../../config/index.js';
import { logDebug } from '../../shared/logger.js';

/** session-ключ -> { chatId, parentId, scope, timestamp } */
const sessions = new Map();

/** сгенерированный chat_xxx -> реальный chatId Qwen */
const chatIdAliases = new Map();

const CLEANUP_INTERVAL_MS = 600_000;

/** Возвращает сохранённый контекст сессии, если он ещё не протух. */
export function getSession(key) {
    if (!key) return null;
    const entry = sessions.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > config.server.sessionTtlMs) {
        sessions.delete(key);
        return null;
    }
    return entry;
}

export function saveSession(key, { chatId, parentId, scope = null }) {
    if (!key || !chatId) return;
    sessions.set(key, { chatId, parentId: parentId ?? null, scope, timestamp: Date.now() });
    logDebug(`Сессия ${String(key).slice(0, 8)} → чат ${chatId}${scope ? ` (scope=${scope})` : ''}`);
}

export function mapChatId(alias, qwenChatId) {
    if (!alias || !qwenChatId) return;
    chatIdAliases.set(alias, qwenChatId);
    logDebug(`Алиас чата: ${alias} → ${qwenChatId}`);
}

export function resolveChatIdAlias(alias) {
    return alias ? chatIdAliases.get(alias) || null : null;
}

/** Удаляет протухшие сессии. Возвращает количество удалённых. */
export function cleanupSessions(now = Date.now()) {
    let removed = 0;
    for (const [key, entry] of sessions.entries()) {
        if (now - entry.timestamp > config.server.sessionTtlMs) {
            sessions.delete(key);
            removed++;
        }
    }
    if (removed > 0) logDebug(`Очищено сессий: ${removed}`);
    return removed;
}

let cleanupTimer = null;

/** Запускает периодическую очистку (вызывается из точки входа сервера). */
export function startSessionCleanup(intervalMs = CLEANUP_INTERVAL_MS) {
    if (cleanupTimer) return cleanupTimer;
    cleanupTimer = setInterval(() => cleanupSessions(), intervalMs);
    // Таймер не должен удерживать процесс: CLI и тесты завершаются сами.
    cleanupTimer.unref?.();
    return cleanupTimer;
}

export function stopSessionCleanup() {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }
}

/** Только для тестов: полностью очищает состояние. */
export function resetConversationState() {
    sessions.clear();
    chatIdAliases.clear();
}
