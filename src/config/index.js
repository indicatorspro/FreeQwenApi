// Единый источник конфигурации. Все значения приходят из окружения процесса,
// проверяются на этапе загрузки модуля и дальше используются только через
// экспортированный `config` — никаких прямых обращений к process.env в коде.

import { ConfigError } from '../shared/errors.js';

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
        throw new ConfigError(`Переменная ${name} должна быть числом, получено: ${value}`);
    }
    if (parsed < min || parsed > max) {
        throw new ConfigError(`Переменная ${name} должна быть в диапазоне ${min}..${max}, получено: ${parsed}`);
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
        throw new ConfigError(`Переменная ${name} должна быть корректным URL, получено: ${raw}`);
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
        // Ключи API можно задать переменной (через запятую) или файлом Authorization.txt.
        apiKeys: toList(env.API_KEYS),
        // Legacy-режим: восстановление чата по IP+User-Agent, без conversation_id.
        allowUnscopedSessionRestore: toBoolean(env.ALLOW_UNSCOPED_SESSION_CHAT_RESTORE),
        skipAccountMenu: toBoolean(env.SKIP_ACCOUNT_MENU) || toBoolean(env.NON_INTERACTIVE),
        sessionTtlMs: toInt(env.SESSION_TTL_MS, 3_600_000, { min: 60_000, name: 'SESSION_TTL_MS' })
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
        dashscopeApiKey: env.DASHSCOPE_API_KEY || null
    }),

    timeouts: Object.freeze({
        page: toInt(env.PAGE_TIMEOUT, 120_000, { min: 1_000, name: 'PAGE_TIMEOUT' }),
        auth: toInt(env.AUTH_TIMEOUT, 120_000, { min: 1_000, name: 'AUTH_TIMEOUT' }),
        navigation: toInt(env.NAVIGATION_TIMEOUT, 60_000, { min: 1_000, name: 'NAVIGATION_TIMEOUT' }),
        retryDelay: toInt(env.RETRY_DELAY, 2_000, { min: 0, name: 'RETRY_DELAY' }),
        streamingChunkDelay: toInt(env.STREAMING_CHUNK_DELAY, 20, { min: 0, name: 'STREAMING_CHUNK_DELAY' }),
        download: toInt(env.DOWNLOAD_TIMEOUT, 60_000, { min: 1_000, name: 'DOWNLOAD_TIMEOUT' })
    }),

    limits: Object.freeze({
        pagePoolSize: toInt(env.PAGE_POOL_SIZE, 3, { min: 1, max: 50, name: 'PAGE_POOL_SIZE' }),
        maxFileSize: toInt(env.MAX_FILE_SIZE, 10 * 1024 * 1024, { min: 1024, name: 'MAX_FILE_SIZE' }),
        maxHistoryLength: toInt(env.MAX_HISTORY_LENGTH, 100, { min: 2, name: 'MAX_HISTORY_LENGTH' }),
        maxRetryCount: toInt(env.MAX_RETRY_COUNT, 3, { min: 0, max: 10, name: 'MAX_RETRY_COUNT' }),
        taskPollMaxAttempts: toInt(env.TASK_POLL_MAX_ATTEMPTS, 90, { min: 1, name: 'TASK_POLL_MAX_ATTEMPTS' }),
        taskPollInterval: toInt(env.TASK_POLL_INTERVAL, 2_000, { min: 100, name: 'TASK_POLL_INTERVAL' }),
        // Фолбэк-длительность блокировки аккаунта, когда Qwen не прислал точное значение.
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
        // Qwen блокирует headless-автоматизацию: headed-режим позволяет пройти верификацию вручную.
        visible: toBoolean(env.QWEN_VISIBLE),
        cdpUrl: (env.QWEN_CDP_URL || '').trim() || null
    }),

    logging: Object.freeze({
        level: env.LOG_LEVEL || 'info',
        maxSize: toInt(env.LOG_MAX_SIZE, 5_242_880, { min: 1024, name: 'LOG_MAX_SIZE' }),
        maxFiles: toInt(env.LOG_MAX_FILES, 5, { min: 1, name: 'LOG_MAX_FILES' }),
        // stdio-транспорт MCP занимает stdout под протокол — консольный лог туда писать нельзя.
        console: toBoolean(env.LOG_CONSOLE, true)
    }),

    tools: Object.freeze({
        // Бюджет символов на блок описания инструментов в системном промпте.
        // Агенты вроде Claude Code присылают десятки MCP-инструментов разом.
        promptMaxChars: toInt(env.TOOL_PROMPT_MAX_CHARS, 24_000, { min: 1_000, name: 'TOOL_PROMPT_MAX_CHARS' }),
        // Сколько раз переспросить модель при неизвестном имени/битых аргументах.
        maxRepairAttempts: toInt(env.TOOL_CALL_MAX_REPAIRS, 1, { min: 0, max: 3, name: 'TOOL_CALL_MAX_REPAIRS' }),
        // Обрезка результата инструмента при сворачивании истории в один запрос.
        resultMaxChars: toInt(env.TOOL_RESULT_MAX_CHARS, 8_000, { min: 500, name: 'TOOL_RESULT_MAX_CHARS' }),
        // Приводить аргументы к типам из JSON Schema ("5" -> 5, "true" -> true).
        coerceArguments: toBoolean(env.TOOL_COERCE_ARGUMENTS, true)
    }),

    mcp: Object.freeze({
        // Встроенный MCP-эндпоинт HTTP-сервера (streamable HTTP).
        httpEnabled: toBoolean(env.MCP_HTTP_ENABLED, true),
        httpPath: env.MCP_HTTP_PATH || '/mcp',
        // Для stdio-процесса: к какому серверу FreeQwenApi подключаться.
        baseUrl: env.FREEQWEN_BASE_URL || `http://127.0.0.1:${toInt(env.PORT, 3264, { min: 1, max: 65535, name: 'PORT' })}`,
        apiKey: env.FREEQWEN_API_KEY || null,
        requestTimeout: toInt(env.MCP_REQUEST_TIMEOUT, 300_000, { min: 1_000, name: 'MCP_REQUEST_TIMEOUT' })
    })
});

export default config;
