// Conversation state: link between client identifiers and Qwen chats.
//
// Previously these two Maps lived directly in router along with setInterval,
// which made service impossible to test or reuse outside Express.

import { config } from '../../config/index.js';
import { logDebug } from '../../shared/logger.js';

/** session-key -> { chatId, parentId, scope, timestamp } */
const sessions = new Map();

/** generated chat_xxx -> real Qwen chatId */
const chatIdAliases = new Map();

const CLEANUP_INTERVAL_MS = 600_000;

/** Returns saved session context if it hasn't expired yet. */
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
    logDebug(`Session ${String(key).slice(0, 8)} → chat ${chatId}${scope ? ` (scope=${scope})` : ''}`);
}

export function mapChatId(alias, qwenChatId) {
    if (!alias || !qwenChatId) return;
    chatIdAliases.set(alias, qwenChatId);
    logDebug(`Chat alias: ${alias} → ${qwenChatId}`);
}

export function resolveChatIdAlias(alias) {
    return alias ? chatIdAliases.get(alias) || null : null;
}

/** Removes expired sessions. Returns count of removed. */
export function cleanupSessions(now = Date.now()) {
    let removed = 0;
    for (const [key, entry] of sessions.entries()) {
        if (now - entry.timestamp > config.server.sessionTtlMs) {
            sessions.delete(key);
            removed++;
        }
    }
    if (removed > 0) logDebug(`Sessions cleaned up: ${removed}`);
    return removed;
}

let cleanupTimer = null;

/** Starts periodic cleanup (called from the server entry point). */
export function startSessionCleanup(intervalMs = CLEANUP_INTERVAL_MS) {
    if (cleanupTimer) return cleanupTimer;
    cleanupTimer = setInterval(() => cleanupSessions(), intervalMs);
    // The timer must not keep the process alive: CLI and tests exit on their own.
    cleanupTimer.unref?.();
    return cleanupTimer;
}

export function stopSessionCleanup() {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }
}

/** Tests only: completely clears the state. */
export function resetConversationState() {
    sessions.clear();
    chatIdAliases.clear();
}
