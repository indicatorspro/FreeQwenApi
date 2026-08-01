// Helpers for standardized HTTP error responses.
//
// Provides functions for:
// 1. Determining appropriate HTTP status from result objects
// 2. Sending errors in standard or OpenAI-compatible format
//
// Source: FreeQwenApi_ForgetMeAI (apiErrors.js).

import { AppError } from '../shared/errors.js';

/**
 * Determines appropriate HTTP status for an operation result.
 *
 * Priority:
 * 1. Explicit result.status (400-599)
 * 2. Semantic flags (invalidRequest → 400, reuploadRequired → 409)
 * 3. fallbackStatus (default 500)
 *
 * @param {object} result — operation result from core
 * @param {number} [fallbackStatus=500]
 * @returns {number}
 */
export function getApiResultStatus(result, fallbackStatus = 500) {
    const explicitStatus = Number(result?.status);
    if (Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus <= 599) {
        return explicitStatus;
    }
    if (result?.invalidRequest) return 400;
    if (result?.reuploadRequired) return 409;
    if (result?.antiBot) return 403;
    if (result?.verification) return 401;
    if (result?.timedOut) return 504;
    if (result?.networkError) return 502;
    return fallbackStatus;
}

/**
 * Cleans streaming/cache headers before sending error.
 * Avoids conflicts when headers were partially sent.
 *
 * @param {import('express').Response} res
 */
function cleanResponseHeaders(res) {
    if (!res.headersSent && typeof res.removeHeader === 'function') {
        for (const header of [
            'Transfer-Encoding',
            'Cache-Control',
            'Pragma',
            'Expires',
            'Connection',
            'X-Accel-Buffering'
        ]) {
            res.removeHeader(header);
        }
    }
    if (!res.headersSent && typeof res.setHeader === 'function') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
}

/**
 * Sends standardized error response.
 *
 * @param {import('express').Response} res
 * @param {object|AppError} result — result with .error/.status or AppError
 * @param {object} [options]
 * @param {boolean} [options.openAI=false] — OpenAI-compatible format
 * @returns {import('express').Response}
 */
export function sendApiResultError(res, result, { openAI = false } = {}) {
    const status = result instanceof AppError
        ? result.status
        : getApiResultStatus(result);

    const message = result?.error || result?.message || 'Internal server error';

    cleanResponseHeaders(res);

    if (openAI) {
        return res.status(status).json({
            error: {
                message,
                type: status < 500 ? 'invalid_request_error' : 'server_error',
                ...(result?.details ? { details: result.details } : {})
            }
        });
    }

    return res.status(status).json({
        error: message,
        ...(result?.details ? { details: result.details } : {})
    });
}

/**
 * Sends OpenAI-compatible error directly.
 * Shortcut for sendApiResultError(res, result, { openAI: true }).
 *
 * @param {import('express').Response} res
 * @param {object|AppError} result
 * @returns {import('express').Response}
 */
export function sendOpenAIError(res, result) {
    return sendApiResultError(res, result, { openAI: true });
}

/**
 * Converts core result to OpenAI error format.
 * Useful when caller wants to build response manually.
 *
 * @param {object} result
 * @returns {{ error: { message: string, type: string, details?: unknown } }}
 */
export function toOpenAIErrorFormat(result) {
    const status = getApiResultStatus(result);
    return {
        error: {
            message: result?.error || 'Internal server error',
            type: status < 500 ? 'invalid_request_error' : 'server_error',
            ...(result?.details ? { details: result.details } : {})
        }
    };
}
