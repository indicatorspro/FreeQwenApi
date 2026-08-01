// Single source of configuration. All values come from process environment,
// validated at module load time and then used only via the exported `config` —
// no direct process.env access in the code.
//
// A .env file at the project root (if present) is loaded first and takes
// precedence over values already in process.env — editing .env is the primary
// way to configure the proxy.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { ConfigError } from '../shared/errors.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Loads KEY=VALUE lines from a .env file into process.env (overrides existing). */
function loadDotEnv(filePath) {
    let content;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch {
        return;
    }
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const body = line.startsWith('export ') ? line.slice(7).trim() : line;
        const eq = body.indexOf('=');
        if (eq <= 0) continue;
        const key = body.slice(0, eq).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
        let value = body.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        process.env[key] = value;
    }
}

loadDotEnv(path.join(PROJECT_ROOT, '.env'));

function toBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function toInt(value, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, name } = {}) {
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    const parsed = Number.parseInt(String(value).trim(), 10);
    if (Number.isNaN(parsed)) {
        throw new ConfigError(`Variable ${name} must be a number, got: ${value}`);
    }
    if (parsed < min || parsed > max) {
        throw new ConfigError(`Variable ${name} must be in range ${min}..${max}, got: ${parsed}`);
    }
    return parsed;
}

function toList(value, fallback = []) {
    if (!value) return fallback;
    return String(value)
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function toUrl(value, fallback, name) {
    const raw = value || fallback;
    try {
        new URL(raw);
    } catch {
        throw new ConfigError(`Variable ${name} must be a valid URL, got: ${raw}`);
    }
    return raw.replace(/\/+$/, '') === '' ? raw : raw;
}

const env = process.env;

const qwenBaseUrl = toUrl(env.QWEN_BASE_URL, 'https://chat.qwen.ai', 'QWEN_BASE_URL');

export const config = Object.freeze({
    server: Object.freeze({
        port: toInt(env.PORT, 3264, { min: 1, max: 65535, name: 'PORT' }),
        host: env.HOST || '0.0.0.0',
        bodyLimit: env.BODY_LIMIT || '150mb',
        defaultModel: env.DEFAULT_MODEL || 'qwen3.7-max',
        // API keys can be set via variable (comma-separated) or Authorization.txt file.
        apiKeys: toList(env.API_KEYS),
        // Allowed origins for CORS (in addition to loopback, which is always allowed).
        allowedOrigins: env.ALLOWED_ORIGINS || '',
        // Legacy mode: restore chat by IP+User-Agent, without conversation_id.
        allowUnscopedSessionRestore: toBoolean(env.ALLOW_UNSCOPED_SESSION_CHAT_RESTORE),
        skipAccountMenu: toBoolean(env.SKIP_ACCOUNT_MENU) || toBoolean(env.NON_INTERACTIVE),
        sessionTtlMs: toInt(env.SESSION_TTL_MS, 3_600_000, { min: 60_000, name: 'SESSION_TTL_MS' }),
        // Proxy-side rate limiting. Off by default: OpenWebUI may fire many
        // parallel requests (title gen, message send), so keep it generous.
        rateLimitEnabled: toBoolean(env.PROXY_RATE_LIMIT_ENABLED, false),
        rateLimitWindowMs: toInt(env.PROXY_RATE_LIMIT_WINDOW_MS, 60_000, { min: 1_000, name: 'PROXY_RATE_LIMIT_WINDOW_MS' }),
        rateLimitMax: toInt(env.PROXY_RATE_LIMIT_MAX, 60, { min: 1, name: 'PROXY_RATE_LIMIT_MAX' })
    }),

    qwen: Object.freeze({
        baseUrl: qwenBaseUrl,
        chatApiUrl: env.CHAT_API_URL || `${qwenBaseUrl}/api/v2/chat/completions`,
        createChatUrl: env.CREATE_CHAT_URL || `${qwenBaseUrl}/api/v2/chats/new`,
        chatPageUrl: env.CHAT_PAGE_URL || `${qwenBaseUrl}/`,
        taskStatusUrl: env.TASK_STATUS_URL || `${qwenBaseUrl}/api/v1/tasks/status`,
        stsTokenUrl: env.STS_TOKEN_API_URL || `${qwenBaseUrl}/api/v1/files/getstsToken`,
        authSigninUrl: env.AUTH_SIGNIN_URL || `${qwenBaseUrl}/auth?action=signin`,
        ossSdkUrl: env.OSS_SDK_URL || 'https://gosspublic.alicdn.com/aliyun-oss-sdk-6.20.0.min.js',
        // Qwen web protocol version used in chat payloads.
        webVersion: env.QWEN_WEB_VERSION || '2.1',
        dashscopeApiKey: env.DASHSCOPE_API_KEY || null
    }),

    timeouts: Object.freeze({
        page: toInt(env.PAGE_TIMEOUT, 120_000, { min: 1_000, name: 'PAGE_TIMEOUT' }),
        auth: toInt(env.AUTH_TIMEOUT, 120_000, { min: 1_000, name: 'AUTH_TIMEOUT' }),
        navigation: toInt(env.NAVIGATION_TIMEOUT, 60_000, { min: 1_000, name: 'NAVIGATION_TIMEOUT' }),
        retryDelay: toInt(env.RETRY_DELAY, 2_000, { min: 0, name: 'RETRY_DELAY' }),
        streamingChunkDelay: toInt(env.STREAMING_CHUNK_DELAY, 20, { min: 0, name: 'STREAMING_CHUNK_DELAY' }),
        download: toInt(env.DOWNLOAD_TIMEOUT, 60_000, { min: 1_000, name: 'DOWNLOAD_TIMEOUT' }),
        // Fetch timeouts to Qwen: node path is fast, browser path may live longer (WAF/captcha).
        nodeFetch: toInt(env.QWEN_NODE_FETCH_TIMEOUT, 30_000, { min: 5_000, name: 'QWEN_NODE_FETCH_TIMEOUT' }),
        browserFetch: toInt(env.QWEN_BROWSER_FETCH_TIMEOUT, 240_000, { min: 10_000, name: 'QWEN_BROWSER_FETCH_TIMEOUT' }),
        // CDP protocol timeout must be higher than browser fetch, otherwise Puppeteer will abort earlier.
        protocol: Math.max(
            toInt(env.PUPPETEER_PROTOCOL_TIMEOUT, 210_000, { min: 30_000, name: 'PUPPETEER_PROTOCOL_TIMEOUT' }),
            toInt(env.QWEN_BROWSER_FETCH_TIMEOUT, 150_000, { min: 10_000, name: 'QWEN_BROWSER_FETCH_TIMEOUT' }) + 30_000
        ),
        // Time to prepare Baxia runtime (Aliyun anti-bot) before request.
        baxiaReady: toInt(env.BAXIA_READY_TIMEOUT, 12_000, { min: 3_000, name: 'BAXIA_READY_TIMEOUT' })
    }),

    limits: Object.freeze({
        pagePoolSize: toInt(env.PAGE_POOL_SIZE, 3, { min: 1, max: 50, name: 'PAGE_POOL_SIZE' }),
        maxFileSize: toInt(env.MAX_FILE_SIZE, 10 * 1024 * 1024, { min: 1024, name: 'MAX_FILE_SIZE' }),
        maxHistoryLength: toInt(env.MAX_HISTORY_LENGTH, 100, { min: 2, name: 'MAX_HISTORY_LENGTH' }),
        maxRetryCount: toInt(env.MAX_RETRY_COUNT, 3, { min: 0, max: 10, name: 'MAX_RETRY_COUNT' }),
        taskPollMaxAttempts: toInt(env.TASK_POLL_MAX_ATTEMPTS, 90, { min: 1, name: 'TASK_POLL_MAX_ATTEMPTS' }),
        taskPollInterval: toInt(env.TASK_POLL_INTERVAL, 2_000, { min: 100, name: 'TASK_POLL_INTERVAL' }),
        // Fallback duration for account lockout when Qwen doesn't send exact value.
        rateLimitHours: toInt(env.QWEN_RATELIMIT_HOURS, 24, { min: 1, name: 'QWEN_RATELIMIT_HOURS' })
    }),

    paths: Object.freeze({
        session: env.SESSION_DIR || 'session',
        accounts: 'accounts',
        uploads: env.UPLOADS_DIR || 'uploads',
        logs: env.LOGS_DIR || 'logs'
    }),

    browser: Object.freeze({
        viewportWidth: toInt(env.VIEWPORT_WIDTH, 1920, { min: 320, name: 'VIEWPORT_WIDTH' }),
        viewportHeight: toInt(env.VIEWPORT_HEIGHT, 1080, { min: 240, name: 'VIEWPORT_HEIGHT' }),
        userAgent: env.USER_AGENT
            || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        chromePath: env.CHROME_PATH || undefined,
        // Optional persistent browser profile. Off by default: each launch uses a
        // fresh temp profile and sessions are kept per account in
        // session/accounts/<id>/cookies.json. Enable only if you want a single
        // shared login kept across restarts (note: this blocks switching accounts).
        userDataDir: (env.BROWSER_USER_DATA_DIR || '').trim() || undefined,
        // Qwen blocks headless automation: headed mode allows manual verification.
        visible: toBoolean(env.QWEN_VISIBLE),
        cdpUrl: (env.QWEN_CDP_URL || '').trim() || null,
        // Proxy: explicit proxy-server is useful when VPN provides local HTTP/SOCKS.
        proxyServer: (env.QWEN_PROXY_SERVER || '').trim() || null,
        proxyBypassList: (env.QWEN_PROXY_BYPASS_LIST || '<-loopback>').trim(),
        disableSystemProxy: toBoolean(env.QWEN_DISABLE_SYSTEM_PROXY)
    }),

    network: Object.freeze({
        // Try node fetch first (faster, but WAF may block).
        // false = always start with browser fetch (more reliable, slower).
        nodeFetchFirst: toBoolean(env.QWEN_NODE_FETCH_FIRST, false),
        // Stateless mode: don't create/save chats, each request is isolated.
        statelessDirect: toBoolean(env.QWEN_STATELESS_DIRECT, false)
    }),

    logging: Object.freeze({
        level: env.LOG_LEVEL || 'info',
        maxSize: toInt(env.LOG_MAX_SIZE, 5_242_880, { min: 1024, name: 'LOG_MAX_SIZE' }),
        maxFiles: toInt(env.LOG_MAX_FILES, 5, { min: 1, name: 'LOG_MAX_FILES' }),
        // MCP stdio transport occupies stdout for protocol — console log can't write there.
        console: toBoolean(env.LOG_CONSOLE, true)
    }),

    tools: Object.freeze({
        // Character budget for tool description block in system prompt.
        // Agents like Claude Code send dozens of MCP tools at once.
        promptMaxChars: toInt(env.TOOL_PROMPT_MAX_CHARS, 24_000, { min: 1_000, name: 'TOOL_PROMPT_MAX_CHARS' }),
        // How many times to re-ask model on unknown name/broken arguments.
        maxRepairAttempts: toInt(env.TOOL_CALL_MAX_REPAIRS, 1, { min: 0, max: 3, name: 'TOOL_CALL_MAX_REPAIRS' }),
        // Truncate tool result when collapsing history into single request.
        resultMaxChars: toInt(env.TOOL_RESULT_MAX_CHARS, 8_000, { min: 500, name: 'TOOL_RESULT_MAX_CHARS' }),
        // Coerce arguments to types from JSON Schema ("5" -> 5, "true" -> true).
        coerceArguments: toBoolean(env.TOOL_COERCE_ARGUMENTS, true)
    }),

    mcp: Object.freeze({
        // Built-in MCP endpoint of HTTP server (streamable HTTP).
        httpEnabled: toBoolean(env.MCP_HTTP_ENABLED, true),
        httpPath: env.MCP_HTTP_PATH || '/mcp',
        // For stdio process: which server FreeQwenApi connects to.
        baseUrl: env.FREEQWEN_BASE_URL || `http://127.0.0.1:${toInt(env.PORT, 3264, { min: 1, max: 65535, name: 'PORT' })}`,
        apiKey: env.FREEQWEN_API_KEY || null,
        requestTimeout: toInt(env.MCP_REQUEST_TIMEOUT, 300_000, { min: 1_000, name: 'MCP_REQUEST_TIMEOUT' })
    })
});

export default config;
