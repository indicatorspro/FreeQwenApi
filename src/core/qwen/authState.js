// Текущий токен Qwen в памяти процесса.
//
// Раньше это была переменная `authToken` внутри chat.js, которую правили из
// пяти модулей через побочные эффекты импорта. Теперь состояние явное.

let authToken = null;
let browserTokenRateLimited = false;

export function getAuthToken() {
    return authToken;
}

export function setAuthToken(token) {
    authToken = token || null;
    return authToken;
}

export function clearAuthToken() {
    authToken = null;
}

/** Токен, извлечённый из браузера, исчерпал лимит — фолбэк на него бессмыслен. */
export function isBrowserTokenRateLimited() {
    return browserTokenRateLimited;
}

export function setBrowserTokenRateLimited(value) {
    browserTokenRateLimited = Boolean(value);
}
