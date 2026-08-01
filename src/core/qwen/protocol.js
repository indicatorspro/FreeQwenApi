// Qwen web protocol constants.
//
// These values must match what the Qwen Chat web app sends to its backend.
// If Qwen changes its web protocol, fix them in this single file instead of
// hunting through payload.js / transport.js. The API version is configurable
// via QWEN_WEB_VERSION (overriding the default "2.1").

import { config } from '../../config/index.js';

/** Qwen web API version used in the chat payload. */
export const QWEN_WEB_VERSION = config.qwen.webVersion;

/** Feature-config field the web app uses for generation tasks. */
export const OUTPUT_SCHEMA = 'phase';

/** Chat mode used for normal conversations. */
export const CHAT_MODE = 'normal';

/** Client-side source marker sent with web requests. */
export const SOURCE_HEADER = 'web';

/** Enables incremental (streaming) output. */
export const INCREMENTAL_OUTPUT = true;
