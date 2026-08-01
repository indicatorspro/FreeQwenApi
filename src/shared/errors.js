// Typed domain errors. HTTP and MCP layers translate them to their formats,
// so core should not know about Express status codes or JSON-RPC.

export class AppError extends Error {
    /**
     * @param {string} message — user-facing message
     * @param {object} [options]
     * @param {string} [options.code] — machine-readable error code
     * @param {number} [options.status] — recommended HTTP status
     * @param {unknown} [options.details] — additional data
     * @param {Error} [options.cause] — original error
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

/** Invalid client request (400). */
export class ValidationError extends AppError {
    constructor(message, details = null) {
        super(message, { code: 'invalid_request_error', status: 400, details });
    }
}

/** Proxy client authorization required or failed (401). */
export class AuthError extends AppError {
    constructor(message, details = null) {
        super(message, { code: 'authentication_error', status: 401, details });
    }
}

/** Access forbidden (403). */
export class ForbiddenError extends AppError {
    constructor(message, details = null) {
        super(message, { code: 'permission_error', status: 403, details });
    }
}

/** Resource not found (404). */
export class NotFoundError extends AppError {
    constructor(message, details = null) {
        super(message, { code: 'not_found_error', status: 404, details });
    }
}

/** Error on Qwen side or unable to get response (502). */
export class UpstreamError extends AppError {
    constructor(message, details = null) {
        super(message, { code: 'upstream_error', status: 502, details });
    }
}

/** All accounts exhausted their limit (429). */
export class RateLimitError extends AppError {
    constructor(message, details = null) {
        super(message, { code: 'rate_limit_error', status: 429, details });
    }
}

/** No suitable Qwen accounts available (503). */
export class NoAccountsError extends AppError {
    constructor(message, details = null) {
        super(message, { code: 'no_accounts_error', status: 503, details });
    }
}

/** Invalid environment configuration — fatal at startup. */
export class ConfigError extends AppError {
    constructor(message) {
        super(message, { code: 'config_error', status: 500 });
    }
}

/**
 * Converts arbitrary value to AppError, preserving cause.
 * @param {unknown} error
 * @param {string} [fallbackMessage]
 * @returns {AppError}
 */
export function toAppError(error, fallbackMessage = 'Internal server error') {
    if (error instanceof AppError) return error;
    if (error instanceof Error) {
        return new AppError(error.message || fallbackMessage, { cause: error });
    }
    return new AppError(typeof error === 'string' && error ? error : fallbackMessage);
}
