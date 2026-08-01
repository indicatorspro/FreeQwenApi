// Current Qwen token in process memory.
//
// Previously this was `authToken` variable inside chat.js, modified from
// five modules via import side effects. Now state is explicit.

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

/** Token extracted from browser exhausted limit — fallback to it is pointless. */
export function isBrowserTokenRateLimited() {
    return browserTokenRateLimited;
}

export function setBrowserTokenRateLimited(value) {
    browserTokenRateLimited = Boolean(value);
}
