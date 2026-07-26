// Типизированные ошибки домена. HTTP- и MCP-слои переводят их в свои форматы,
// поэтому ядро не должно знать ни про статус-коды Express, ни про JSON-RPC.

export class AppError extends Error {
    /**
     * @param {string} message — сообщение для пользователя
     * @param {object} [options]
     * @param {string} [options.code] — машиночитаемый код ошибки
     * @param {number} [options.status] — рекомендуемый HTTP-статус
     * @param {unknown} [options.details] — дополнительные данные
     * @param {Error} [options.cause] — исходная ошибка
     */
    constructor(message, { code = 'internal_error', status = 500, details = null, cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = this.constructor.name;
        this.code = code;
        this.status = status;
        this.details = details;
    }

    toJSON() {
        return {
            error: {
                message: this.message,
                type: this.code,
                ...(this.details ? { details: this.details } : {})
            }
        };
    }
}

/** Некорректный запрос клиента (400). */
export class ValidationError extends AppError {
    constructor(message, details = null) {
        super(message, { code: 'invalid_request_error', status: 400, details });
    }
}

/** Требуется или не прошла авторизация клиента прокси (401). */
export class AuthError extends AppError {
    constructor(message, details = null) {
        super(message, { code: 'authentication_error', status: 401, details });
    }
}

/** Доступ запрещён (403). */
export class ForbiddenError extends AppError {
    constructor(message, details = null) {
        super(message, { code: 'permission_error', status: 403, details });
    }
}

/** Ресурс не найден (404). */
export class NotFoundError extends AppError {
    constructor(message, details = null) {
        super(message, { code: 'not_found_error', status: 404, details });
    }
}

/** Ошибка на стороне Qwen или невозможность получить ответ (502). */
export class UpstreamError extends AppError {
    constructor(message, details = null) {
        super(message, { code: 'upstream_error', status: 502, details });
    }
}

/** Все аккаунты исчерпали лимит (429). */
export class RateLimitError extends AppError {
    constructor(message, details = null) {
        super(message, { code: 'rate_limit_error', status: 429, details });
    }
}

/** Ни одного пригодного аккаунта Qwen (503). */
export class NoAccountsError extends AppError {
    constructor(message, details = null) {
        super(message, { code: 'no_accounts_error', status: 503, details });
    }
}

/** Некорректная конфигурация окружения — фатальна на старте. */
export class ConfigError extends AppError {
    constructor(message) {
        super(message, { code: 'config_error', status: 500 });
    }
}

/**
 * Приводит произвольное значение к AppError, сохраняя причину.
 * @param {unknown} error
 * @param {string} [fallbackMessage]
 * @returns {AppError}
 */
export function toAppError(error, fallbackMessage = 'Внутренняя ошибка сервера') {
    if (error instanceof AppError) return error;
    if (error instanceof Error) {
        return new AppError(error.message || fallbackMessage, { cause: error });
    }
    return new AppError(typeof error === 'string' && error ? error : fallbackMessage);
}
