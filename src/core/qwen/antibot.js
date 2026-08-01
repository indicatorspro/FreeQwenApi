// Aliyun WAF anti-bot challenge detection in Qwen responses.
//
// Qwen uses Aliyun WAF (Baxia), which can replace normal response with an HTML
// captcha page. This module recognizes known signatures and classifies the
// response so the transport layer can decide: fallback to browser fetch,
// account rotation, or error to client.
//
// Signatures collected from FreeQwenApi_ForgetMeAI (isQwenAntiBotBody) and
// FreeQwenApi_Ivanqo (aliyun_waf detection).

/**
 * Known Aliyun/Qwen anti-bot challenge signatures.
 * Checked in lowercase response body.
 */
const ANTIBOT_SIGNATURES = [
    '/_____tmd_____/punish',       // TMD punish page (Aliyun anti-bot)
    'rgv587',                      // Aliyun WAF challenge page ID
    'fail_sys_user_validate',      // System user validation error
    'purecaptcha',                 // PureCaptcha challenge
    'aliyun_waf',                  // Direct Aliyun WAF marker
    '_waf_'                        // WAF marker in URL/body
];

/**
 * Combined signature: window._config_ + captcha on same page.
 * Requires checking two conditions simultaneously.
 */
function hasConfigCaptchaCombo(lower) {
    return lower.includes('window._config_') && lower.includes('captcha');
}

/**
 * Determines if response body is an anti-bot challenge.
 * @param {string|unknown} body — HTTP response body
 * @returns {boolean}
 */
export function isAntiBotChallenge(body) {
    if (typeof body !== 'string' || !body) return false;
    const lower = body.toLowerCase();

    if (ANTIBOT_SIGNATURES.some(signature => lower.includes(signature))) {
        return true;
    }

    return hasConfigCaptchaCombo(lower);
}

/**
 * Determines if response is an HTML page (not JSON/SSE).
 * WAF often returns HTML instead of expected API response.
 * @param {string|unknown} body
 * @returns {boolean}
 */
export function isHtmlResponse(body) {
    if (typeof body !== 'string' || !body) return false;
    const trimmed = body.trimStart().toLowerCase();
    return trimmed.startsWith('<!doctype') || trimmed.startsWith('<html');
}

/**
 * Classifies an unexpected non-SSE response.
 * @param {string|unknown} body
 * @returns {{ antiBot: boolean, html: boolean, waf: boolean }}
 */
export function classifyBlockedResponse(body) {
    const antiBot = isAntiBotChallenge(body);
    const html = isHtmlResponse(body);
    const waf = typeof body === 'string' && /aliyun_waf|_waf_|waf/i.test(body);

    return { antiBot, html, waf };
}

/**
 * Formats diagnostic string for logging.
 * @param {{ antiBot?: boolean, html?: boolean, waf?: boolean, status?: number }} info
 * @returns {string}
 */
export function formatDiagnostic(info) {
    const parts = [];
    if (info.status) parts.push(`status=${info.status}`);
    if (info.antiBot) parts.push('antibot=true');
    if (info.waf) parts.push('aliyun_waf=true');
    if (info.html) parts.push('html_response=true');
    return parts.join(', ');
}
