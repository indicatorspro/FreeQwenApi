// Sending messages to Qwen Chat: account selection, chat creation, request,
// limit handling and rotation on failures.

import { config } from '../../config/index.js';
import { logDebug, logError, logInfo, logRaw, logWarn } from '../../shared/logger.js';
import { unixSeconds } from '../../shared/ids.js';
import { getBrowserContext, initBrowser, setAuthenticationStatus, shutdownBrowser } from '../../browser/browser.js';
import { checkVerification } from '../../browser/auth.js';
import { hasAvailableAccounts, markInvalid, markRateLimited, getAccountById } from '../accounts/store.js';
import { clearAuthToken, getAuthToken, setAuthToken, setBrowserTokenRateLimited } from './authState.js';
import { createChat } from './chats.js';
import { extractTaskId, extractMediaUrl } from './media.js';
import { CHAT_TYPES, buildChatPayload, buildStatelessPayload, validateMessageContent } from './payload.js';
import { pagePool, withPage } from './pagePool.js';
import { pollTaskStatus } from './tasks.js';
import { executeChatRequest } from './transport.js';
import { resolveAccount } from './tokens.js';
import { isValidModel } from '../models/registry.js';
import { preparePageForApi } from './baxia.js';
import { isAntiBotChallenge } from './antibot.js';
import { snapshotAccountToken, resolveFileAccountId, bindResourceToAccount, getResourceAccountId, buildResourceKey } from '../accounts/affinity.js';
import { affinityRegistry } from '../accounts/affinityRegistry.js';

/**
 * @typedef {object} SendMessageOptions
 * @property {string|Array} message
 * @property {string} [model]
 * @property {string|null} [chatId]
 * @property {string|null} [parentId]
 * @property {Array} [files]
 * @property {string|null} [systemMessage]
 * @property {'t2t'|'t2i'|'t2v'} [chatType]
 * @property {string|null} [size]
 * @property {boolean} [waitForCompletion] — wait for long task result
 * @property {(chunk: string) => void} [onChunk]
 * @property {number} [retryCount]
 * @property {string|null} [clientScope] — client scope for file/task affinity keys
 */

function resolveModel(model) {
    if (!model || !String(model).trim()) return config.server.defaultModel;
    if (!isValidModel(model)) {
        logWarn(`Model "${model}" not in available list, using ${config.server.defaultModel}`);
        return config.server.defaultModel;
    }
    return model;
}

/** Handle Qwen failure: anti-bot, verification, expired token, rate limit. */
export async function handleFailure(response, account, options) {
    logRaw(JSON.stringify(response));
    logError(`Qwen response error: ${response.error || response.statusText || response.status}`);
    if (response.errorBody) logDebug(`Error body: ${response.errorBody}`);

    // Partial stream guard: if chunks were already emitted to the client, we
    // must NOT rotate accounts / retry — the client would receive a duplicated
    // or inconsistent stream. Surface the error and let the client decide.
    if (response.streamed === true) {
        logWarn(`Stream already started (${response.error || 'error'}), not rotating accounts`);
        return {
            error: response.error || response.statusText || `HTTP ${response.status}`,
            details: response.errorBody || 'No additional details',
            chatId: options.chatId,
            streamed: true
        };
    }

    const errorBody = String(response.errorBody || '');

    // Aliyun WAF anti-bot challenge: captcha, TMD punish, rgv587.
    // The token is still valid — do NOT mark the account invalid or clear the
    // token. Reopen the browser visible mode with the account's session
    // restored so the user only has to solve the captcha. Skip the headless
    // restart: keeping the visible browser open preserves the WAF fingerprint
    // and x5sec cookies, otherwise every next request gets challenged again.
    if (response.antiBot || isAntiBotChallenge(errorBody)) {
        logWarn('Aliyun WAF anti-bot challenge detected, restarting browser in visible mode');
        setAuthenticationStatus(false);
        await pagePool.clear();
        const restoreAccountId = account?.id && account.id !== 'browser' ? account.id : null;
        await shutdownBrowser();
        await initBrowser(true, true, restoreAccountId);
        return {
            error: 'Qwen anti-bot protection (captcha/WAF). Browser started in visible mode for verification.',
            antiBot: true,
            chatId: options.chatId
        };
    }

    if (response.html?.includes('Verification')) {
        setAuthenticationStatus(false);
        logInfo('Verification required, restarting browser in visible mode');
        await pagePool.clear();
        const restoreAccountId = account?.id && account.id !== 'browser' ? account.id : null;
        await shutdownBrowser();
        await initBrowser(true, true, restoreAccountId);
        return {
            error: 'Verification required. Browser started in visible mode.',
            verification: true,
            chatId: options.chatId
        };
    }

    const isUnauthorized = response.status === 401
        || errorBody.includes('Unauthorized')
        || errorBody.includes('Token has expired');

    if (isUnauthorized) {
        logWarn(`Account ${account?.id} token invalid (401), trying next`);
        clearAuthToken();
        setBrowserTokenRateLimited(false);
        if (account?.id && account.id !== 'browser') markInvalid(account.id);

        // Clear affinity: chat no longer bound to available account.
        if (options.chatId) affinityRegistry.forget(options.chatId);

        if (hasAvailableAccounts() && options.retryCount < config.limits.maxRetryCount) {
            // Reset chatId/parentId: chat belongs to previous account and
            // "doesn't exist" under new token.
            return sendMessage({ ...options, chatId: null, parentId: null, retryCount: options.retryCount + 1 });
        }
        return { error: 'All accounts invalid (401). Re-authorization required.', chatId: options.chatId };
    }

    // Qwen internal error (Bad_Request / Internal error) — transient server-side
    // rejection on this account. Rotate to another account instead of failing.
    const isBadRequest = response.status === 500 && (errorBody.includes('Bad_Request') || errorBody.includes('Internal error'));
    if (isBadRequest) {
        logWarn(`Qwen internal error (${response.status}) on account ${account?.id}, trying next`);
        if (options.chatId) affinityRegistry.forget(options.chatId);
        clearAuthToken();
        if (hasAvailableAccounts() && options.retryCount < config.limits.maxRetryCount) {
            return sendMessage({ ...options, chatId: null, parentId: null, retryCount: options.retryCount + 1 });
        }
        return { error: `Qwen internal error on all accounts (${response.status})`, chatId: options.chatId };
    }

    const isRateLimited = response.status === 429 || errorBody.includes('RateLimited');
    if (isRateLimited) {
        let hours = config.limits.rateLimitHours;
        try {
            hours = Number(JSON.parse(errorBody).num) || hours;
        } catch { /* body not JSON — use default value */ }

        if (account?.id === 'browser') {
            setBrowserTokenRateLimited(true);
            logWarn(`Browser token exhausted limit, blocked for ${hours}h`);
        } else if (account?.id) {
            markRateLimited(account.id, hours);
            logWarn(`Account ${account.id} exhausted limit, blocked for ${hours}h, trying next`);
        }

        // Clear affinity: account temporarily unavailable.
        if (options.chatId) affinityRegistry.forget(options.chatId);

        clearAuthToken();
        if (hasAvailableAccounts() && options.retryCount < config.limits.maxRetryCount) {
            return sendMessage({ ...options, chatId: null, parentId: null, retryCount: options.retryCount + 1 });
        }
        return { error: `All accounts rate-limited (${hours}h)`, chatId: options.chatId };
    }

    return {
        error: response.error || response.statusText || `HTTP ${response.status}`,
        details: response.errorBody || 'No additional details',
        chatId: options.chatId
    };
}

/** Response to long task (video generation). */
async function handleTaskResponse({ page, response, model, chatId, token, account, waitForCompletion }) {
    logInfo('Received generation task response');
    logRaw(JSON.stringify(response.data));

    const taskId = extractTaskId(response.data);
    if (!taskId) {
        logError('Task ID not found in response');
        return { error: 'Task ID not found in response', chatId, rawResponse: response.data };
    }

    logInfo(`Task ID: ${taskId}`);

    // Bind task → account so getTaskStatus resolves the same account.
    if (account?.id) {
        bindResourceToAccount(affinityRegistry, 'task', taskId, account.id);
        logDebug(`Affinity bind: task ${taskId} → account ${account.id}`);
    }

    if (!waitForCompletion) {
        return {
            id: taskId,
            object: 'chat.completion.task',
            created: unixSeconds(),
            model,
            task_id: taskId,
            chatId,
            parentId: response.data.data?.parent_id || taskId,
            status: 'processing',
            message: 'Task created. Progress: GET /api/tasks/status/:taskId'
        };
    }

    const result = await pollTaskStatus({ page, taskId, token });

    if (result.success && result.status === 'completed') {
        const videoUrl = extractMediaUrl(result.data, 'video');
        logInfo('Task completed successfully');
        return {
            id: taskId,
            object: 'chat.completion',
            created: unixSeconds(),
            model,
            choices: [{
                index: 0,
                message: { role: 'assistant', content: videoUrl || JSON.stringify(result.data) },
                finish_reason: 'stop'
            }],
            usage: result.data.usage || { prompt_tokens: 0, output_tokens: 0, total_tokens: 0 },
            response_id: taskId,
            chatId,
            parentId: taskId,
            task_id: taskId,
            video_url: videoUrl
        };
    }

    logError(`Task not completed: ${result.error}`);
    return { error: result.error || 'Generation failed', status: result.status, chatId, task_id: taskId };
}

/**
 * Stateless request to Qwen without creating chat.
 * Used for simple one-shot requests (no chatId, files, tools).
 *
 * @param {object} params
 * @param {unknown} params.context — browser context
 * @param {{id: string, token: string}} params.account
 * @param {string} params.content — message text
 * @param {string} params.model
 * @param {string|null} params.systemMessage
 * @param {(chunk: string) => void} [params.onChunk]
 * @returns {Promise<object>}
 */
async function tryStatelessCompletion({ context, account, content, model, systemMessage, onChunk }) {
    let page = null;
    try {
        logDebug(`tryStatelessCompletion: acquiring page from pool`);
        page = await pagePool.acquire(context);
        logDebug(`tryStatelessCompletion: page acquired`);

        if (await checkVerification(page)) {
            logDebug(`tryStatelessCompletion: verification check passed, reloading page`);
            await page.reload({ waitUntil: 'domcontentloaded', timeout: config.timeouts.page });
        }

        // Token synchronization and Baxia preparation.
        logDebug(`tryStatelessCompletion: preparing page for API (Baxia)`);
        await preparePageForApi(page, { token: account.token });
        logDebug(`tryStatelessCompletion: page prepared`);

        const payload = buildStatelessPayload({
            content,
            model,
            systemMessage,
            stream: true
        });

        logInfo('Stateless Qwen API v2 request (without chat creation)…');
        logRaw(`Stateless payload: ${JSON.stringify(payload)}`);

        logDebug(`tryStatelessCompletion: executing chat request`);
        const response = await executeChatRequest({
            page,
            url: config.qwen.chatApiUrl,
            payload,
            token: account.token,
            onChunk
        });
        logDebug(`tryStatelessCompletion: request completed, ok=${response.ok}`);

        if (response.ok) {
            logInfo('Stateless response received');
            const data = response.data;
            data.chatId = null;
            data.parentId = data.response_id || data.id || null;
            data.id = data.id || `chatcmpl-${Date.now()}`;
            data.streamed = response.streamed === true;
            data.stateless = true;
            return data;
        }

        return {
            error: response.error || response.statusText || `HTTP ${response.status}`,
            status: response.status,
            errorBody: response.errorBody,
            antiBot: response.antiBot,
            timedOut: response.timedOut
        };
    } catch (error) {
        const isProtocolTimeout = String(error).includes('protocol') || String(error).includes('timeout');
        if (isProtocolTimeout && page) {
            await pagePool.discard(page, 'CDP protocol timeout during stateless completion');
            page = null;
        }
        return {
            error: String(error),
            timedOut: isProtocolTimeout,
            networkError: isProtocolTimeout
        };
    } finally {
        if (page) pagePool.release(page);
    }
}

/**
 * Sends message to Qwen Chat.
 * @param {SendMessageOptions} options
 * @returns {Promise<object>} — response in chat.completion format or { error }
 */
export async function sendMessage(options) {
    const {
        message,
        model: requestedModel = config.server.defaultModel,
        chatId: requestedChatId = null,
        parentId = null,
        files = null,
        systemMessage = null,
        chatType = CHAT_TYPES.TEXT,
        size = null,
        waitForCompletion = true,
        onChunk = null,
        retryCount = 0,
        generationModel = null
    } = options;

    const context = getBrowserContext();
    if (!context) return { error: 'Browser not initialized', chatId: requestedChatId };

    const validated = validateMessageContent(message);
    if (validated.error) {
        logError(validated.error);
        return { error: validated.error, chatId: requestedChatId };
    }

    const model = resolveModel(requestedModel);

    // ─── File Affinity preflight ──────────────────────────────────────────────
    // Files attached to a chat must belong to the same account as the chat,
    // otherwise Qwen loses them ("file is not exist"). A chat bound to account A
    // plus files owned by account B → reject before any request is made.
    const fileAffinity = files && files.length > 0
        ? resolveFileAccountId(affinityRegistry, files, options.clientScope)
        : null;

    if (fileAffinity?.error) {
        return { error: fileAffinity.error, status: 409, chatId: requestedChatId, reuploadRequired: true };
    }
    if (fileAffinity?.hasFiles && !fileAffinity.hasKnownOwner) {
        return {
            error: 'Could not determine the Qwen account of the attached files. Re-upload them before sending.',
            status: 409,
            chatId: requestedChatId,
            reuploadRequired: true
        };
    }

    // ─── Account Affinity ─────────────────────────────────────────────────────
    // If chatId already bound to account — use it.
    // Otherwise select new account and reset chatId (chat doesn't exist
    // under different token).
    let account = null;
    let chatId = requestedChatId;
    let affinityResetReason = null;

    if (requestedChatId) {
        const boundAccountId = affinityRegistry.get(requestedChatId);
        if (boundAccountId) {
            const boundAccount = getAccountById(boundAccountId);
            if (boundAccount && !boundAccount.invalid) {
                account = snapshotAccountToken(boundAccount);
                logDebug(`Affinity hit: chat ${requestedChatId} → account ${boundAccountId}`);
            } else {
                affinityRegistry.forget(requestedChatId);
                affinityResetReason = 'bound_account_unavailable';
                logDebug(`Affinity miss: account ${boundAccountId} unavailable`);
            }
        } else {
            affinityResetReason = 'unknown_chat_affinity';
        }
    }

    // Chat bound to A, files owned by B → conflict.
    if (fileAffinity?.accountId && account?.id && account.id !== fileAffinity.accountId) {
        return {
            error: 'Chat and attached files belong to different Qwen accounts. Create a new chat or re-upload the files.',
            status: 409,
            chatId: requestedChatId,
            reuploadRequired: true
        };
    }

    // If affinity didn't work — select account normally, preferring the
    // account that owns the attached files.
    if (!account) {
        if (fileAffinity?.accountId) {
            const fileAccount = getAccountById(fileAffinity.accountId);
            if (fileAccount && !fileAccount.invalid) {
                account = snapshotAccountToken(fileAccount);
                logDebug(`Affinity hit (files): → account ${fileAccount.id}`);
            }
        }
        if (!account) account = await resolveAccount(context);
        if (!account) return { error: 'Authorization error: failed to get token', chatId: requestedChatId };

        // Reset chatId if it existed but affinity didn't work.
        if (requestedChatId && affinityResetReason) {
            logWarn(`Chat ${requestedChatId} reset: ${affinityResetReason}`);
            chatId = null;
        }
    }

    // ─── Stateless Direct ─────────────────────────────────────────────────────
    // For simple requests without chatId, files, tools — don't create chat.
    const canUseStatelessDirect =
        config.network.statelessDirect &&
        !requestedChatId &&
        chatType === CHAT_TYPES.TEXT &&
        (!files || files.length === 0);

    if (canUseStatelessDirect) {
        const statelessResult = await tryStatelessCompletion({
            context,
            account,
            content: validated.content,
            model,
            systemMessage,
            onChunk
        });

        if (statelessResult && !statelessResult.error) {
            logInfo('Stateless Qwen completion executed without chat creation');
            return statelessResult;
        }

        // On network error don't fallback to createChat (would double hanging requests).
        if (statelessResult?.timedOut || statelessResult?.networkError) {
            logWarn(`Stateless completion stopped: ${statelessResult.error}. createChat not started.`);
            return {
                error: `Qwen unavailable or responding too slowly: ${statelessResult.error}`,
                chatId: null
            };
        }

        logWarn(`Stateless completion not working (${statelessResult?.error}), fallback to createChat.`);
    }

    // ─── Chat creation + Affinity binding ─────────────────────────────────────
    if (!chatId) {
        logDebug(`sendMessage: creating new chat for model=${model}, chatType=${chatType}`);
        const created = await createChat({ context, token: account.token, model, chatType });
        if (created.error) {
            logError(`sendMessage: createChat failed: ${created.error}`);
            return { error: `Failed to create chat: ${created.error}` };
        }
        chatId = created.chatId;
        logInfo(`Created new chat: ${chatId}`);

        // Bind chatId → accountId for future requests.
        if (account.id) {
            affinityRegistry.bind(chatId, account.id);
            logDebug(`Affinity bind: chat ${chatId} → account ${account.id}`);
        }
    }

    // Bind attached files → accountId so later requests using the same files
    // resolve to the account that owns them.
    if (account.id && fileAffinity?.resourceIds?.length > 0) {
        for (const fileId of fileAffinity.resourceIds) {
            bindResourceToAccount(affinityRegistry, 'file', fileId, account.id, options.clientScope);
        }
    }

    if (chatType !== CHAT_TYPES.TEXT) {
        const labels = { [CHAT_TYPES.IMAGE]: 'image', [CHAT_TYPES.VIDEO]: 'video' };
        logInfo(`Generation type: ${chatType} (${labels[chatType] || chatType})${size ? `, size: ${size}` : ''}`);
    }

    const normalizedOptions = {
        ...options,
        model,
        chatId,
        chatType,
        retryCount
    };

    let page = null;
    try {
        logDebug(`sendMessage: acquiring page from pool for chat ${chatId}`);
        page = await pagePool.acquire(context);
        logDebug(`sendMessage: page acquired`);

        if (await checkVerification(page)) {
            logDebug(`sendMessage: verification check passed, reloading page`);
            await page.reload({ waitUntil: 'domcontentloaded', timeout: config.timeouts.page });
        }

        let token = getAuthToken();
        if (!token) {
            logWarn('Token missing before sending request, reading from browser');
            token = await page.evaluate(() => localStorage.getItem('token'));
            if (!token) {
                return { error: 'Authorization token not found. Re-authentication required.', chatId };
            }
            setAuthToken(token);
        }

        // Prepare Baxia runtime (Aliyun anti-bot) before the request.
        // Loads AWSC scripts and waits for uidToken generation.
        logDebug(`sendMessage: preparing page for API (Baxia)`);
        await preparePageForApi(page, { token });
        logDebug(`sendMessage: page prepared, building payload`);

        const payload = buildChatPayload({
            content: validated.content,
            model,
            chatId,
            parentId,
            files,
            systemMessage,
            chatType,
            size,
            generationModel
        });

        logInfo('Sending request to Qwen API v2…');
        logRaw(`Payload: ${JSON.stringify(payload)}`);

        logDebug(`sendMessage: executing chat request to ${config.qwen.chatApiUrl}?chat_id=${chatId}`);
        const response = await executeChatRequest({
            page,
            url: `${config.qwen.chatApiUrl}?chat_id=${chatId}`,
            payload,
            token,
            onChunk
        });
        logDebug(`sendMessage: request completed, ok=${response.ok}, kind=${response.kind}`);

        if (response.ok && response.kind === 'task') {
            return await handleTaskResponse({
                page,
                response,
                model,
                chatId,
                token,
                account,
                waitForCompletion
            });
        }

        if (response.ok) {
            logRaw(JSON.stringify(response.data));
            logInfo('Response received');

            const data = response.data;
            data.chatId = chatId;
            data.parentId = data.response_id;
            data.id = data.id || `chatcmpl-${Date.now()}`;
            data.streamed = response.streamed === true;

            // Image/video generation: the SSE stream completes with empty content
            // while usage signals media was produced (image_count, video_count).
            // The actual URL arrives in trailing SSE chunks the accumulator
            // normally discards — search the preserved rawChunks for it.
            if (chatType === CHAT_TYPES.IMAGE || chatType === CHAT_TYPES.VIDEO) {
                const content = data.choices?.[0]?.message?.content;
                if (!content || !content.trim()) {
                    const mediaType = chatType === CHAT_TYPES.IMAGE ? 'image' : 'video';
                    const rawChunks = data.rawChunks || [];
                    logDebug(`sendMessage: media generation with empty content — searching ${rawChunks.length} raw SSE chunks for ${mediaType} URL`);
                    logRaw(`Raw SSE chunks: ${JSON.stringify(rawChunks).slice(0, 8000)}`);
                    const mediaUrl = extractMediaUrl(rawChunks, mediaType);
                    if (mediaUrl) {
                        if (data.choices?.[0]?.message) {
                            data.choices[0].message.content = mediaUrl;
                        }
                        data.media_url = mediaUrl;
                        logInfo(`Media URL extracted from raw SSE chunks: ${mediaUrl}`);
                    } else {
                        logWarn(`Media URL not found in ${rawChunks.length} raw SSE chunks`);
                    }
                }
            }

            // Strip internal rawChunks before returning to the caller.
            delete data.rawChunks;

            return data;
        }

        return await handleFailure(response, account, normalizedOptions);
    } catch (error) {
        logError('Error sending message', error);
        return { error: String(error), chatId };
    } finally {
        pagePool.release(page);
    }
}

/**
 * Status of a long-running task by its identifier.
 * @param {string} taskId
 * @param {boolean} [waitForCompletion]
 */
export async function getTaskStatus(taskId, waitForCompletion = false) {
    const context = getBrowserContext();
    if (!context) return { error: 'Browser not initialized', task_id: taskId };

    const account = await resolveTaskAccount(context, taskId);
    if (!account?.token) return { error: 'Authorization error: failed to obtain token', task_id: taskId };

    return withPage(context, async (page) => {
        const result = waitForCompletion
            ? await pollTaskStatus({ page, taskId, token: account.token })
            : await pollTaskStatus({ page, taskId, token: account.token, maxAttempts: 5, interval: 2000 });

        const payload = result.data || result;
        const videoUrl = extractMediaUrl(payload, 'video');
        const imageUrl = extractMediaUrl(payload, 'image');

        return {
            task_id: taskId,
            success: result.success,
            status: result.status,
            error: result.error,
            video_url: videoUrl,
            image_url: imageUrl,
            media_url: videoUrl || imageUrl,
            data: result.data
        };
    });
}

/**
 * Resolves the account for a task: uses task affinity if present, otherwise
 * falls back to normal account selection.
 */
async function resolveTaskAccount(context, taskId) {
    const boundAccountId = getResourceAccountId(affinityRegistry, 'task', taskId);
    if (boundAccountId) {
        const boundAccount = getAccountById(boundAccountId);
        if (boundAccount && !boundAccount.invalid) {
            const token = snapshotAccountToken(boundAccount);
            if (token) {
                logDebug(`Task affinity hit: ${taskId} → account ${boundAccountId}`);
                return token;
            }
        }
        affinityRegistry.forget(buildResourceKey('task', taskId));
    }
    return resolveAccount(context);
}

export async function clearPagePool() {
    await pagePool.clear();
}
