# Implementation Plan — missing features & improvements

Ordered by impact. Each item: goal, approach, files touched, verification,
and whether it comes from a source or is our own hardening.

Legend: 🟢 easy · 🟡 medium · 🔴 complex

---

## Phase 1 — Correctness (do first)

### P1.1 — Verify legacy `/api/chat` streaming ignores `chatType`  🟡
**Source:** heymoma bug (`legacy.js:78-88`), may have been inherited.
- **Problem:** in the streaming branch of `POST /api/chat`, `sendMessage` may be
  called without `chatType`, so `t2i`/`t2v` never work through that route.
- **Action:** read `src/server/routes/legacy.js`, confirm whether `chatType` is
  forwarded in both stream and non-stream branches. If missing, pass it through.
- **Files:** `src/server/routes/legacy.js`, maybe `src/services/completions.js`.
- **Verify:** unit test + manual `POST /api/chat` with `chatType: t2i`.

### P1.2 — Video `feature_config`  🟢
**Source:** all three sources build a richer video payload.
- **Problem:** our `buildChatPayload` always sends
  `{ thinking_enabled, output_schema: 'phase' }` (`payload.js:119-122`); sources
  add for `t2v`: `research_mode: 'normal'`, `auto_thinking: true`,
  `thinking_format: 'summary'`, `auto_search: true`.
- **Action:** when `chatType === VIDEO`, add those fields to `feature_config`.
  Keep `thinking_enabled` as the `isThinkingLocked(model)` fix.
- **Files:** `src/core/qwen/payload.js`.
- **Verify:** existing payload tests + a real video generation request.

### P1.3 — Failover "never retry after partial stream"  🔴
**Source:** ForgetMeAI `chat.js:1107-1153`.
- **Problem:** if a node-fetch stream fails mid-response and we rotate accounts,
  the client may receive a duplicated or inconsistent stream.
- **Action:** add a guard in `sendMessage`/`executeChatRequest` so that once
  chunks have been emitted (`onChunk` called), no account rotation/retry happens;
  surface an error instead.
- **Files:** `src/core/qwen/client.js`, `src/core/qwen/transport.js`.
- **Verify:** unit test simulating stream failure after first chunk.

---

## Phase 2 — Integrations (high user value)

### P2.1 — Anthropic shim `POST /api/messages`  🟡
**Source:** ForgetMeAI `routes.js:857,1320` (ready-made).
- **Goal:** let Claude Code point `ANTHROPIC_BASE_URL` at our proxy.
- **Action:** add `/api/messages` and `/api/v1/messages` routes that translate
  Anthropic messages (`content` blocks, `system`) to our `runCompletion` input,
  and translate the reply back to Anthropic SSE (`message_start`,
  `content_block_delta`, `message_stop`) or JSON.
- **Files:** new `src/server/routes/messages.js`, register in
  `src/server/routes/index.js`.
- **Verify:** curl with an Anthropic-shaped request; compare with ForgetMeAI
  implementation for exact field names.

### P2.2 — Client scoping (isolate clients)  🟡
**Source:** ForgetMeAI `keyedQueue.js` (port the registry, skip the queue if unneeded).
- **Goal:** each client (IP+UA+API-key fingerprint) gets deterministic
  `chat_<sha256>` aliases; prevents cross-client chat collisions and maps cleanly
  to upstream chat ids.
- **Action:** port `createClientScope` + conversation identity registry with CAS
  (anti-stale), reusing our `scopedHash`/`timingSafeCompare` in `security.js`.
- **Files:** new `src/core/conversations/identity.js` (or extend `resolver.js`),
  unit tests.
- **Verify:** two clients with same first message get different aliases.

### P2.3 — Multi-resource affinity (chat + file + task)  🟡
**Source:** ForgetMeAI `chat.js:531-621`.
- **Goal:** bind file uploads and generation tasks to the same account as their chat.
- **Action:** extend `affinity.js` registry to key on resource type, and bind
  in `files.js` / `media.js` when a `chatId` is present.
- **Files:** `src/core/accounts/affinity.js`, `src/core/qwen/files.js`,
  `src/services/media.js`.
- **Verify:** unit tests for mixed chat+file+task bindings.

---

## Phase 3 — Hardening (our own improvements)

### P3.1 — Proxy-side rate limiting  🟡
**Problem:** no source protects the proxy itself; any client can abuse it.
- **Action:** add `express-rate-limit` (or a lightweight in-memory limiter) keyed
  by IP+API key, with configurable window via env (`PROXY_RATE_LIMIT_WINDOW_MS`,
  `PROXY_RATE_LIMIT_MAX`). Keep it off by default or generous to not break
  OpenWebUI.
- **Files:** `src/server/middleware/index.js`, `src/config/index.js`,
  `.env.example`.
- **Verify:** burst test hits 429; normal traffic unaffected.

### P3.2 — Move hardcoded Qwen protocol constants to config  🟢
**Problem:** `version: '2.1'`, `output_schema: 'phase'`, `X-Request-Id` header
are scattered across `payload.js`/`transport.js`.
- **Action:** centralize in `src/core/qwen/protocol.js` (or config) so a Qwen
  web-protocol change is a one-file fix. Wire `QWEN_WEB_VERSION` env like
  ForgetMeAI does.
- **Files:** new `src/core/qwen/protocol.js`, update `payload.js`,
  `transport.js`, `config/index.js`, `.env.example`.
- **Verify:** all payload tests still pass; runtime uses env override.

### P3.3 — Persist affinity/session state  🟡
**Problem:** affinity and session maps are in-memory; restart breaks continuity.
- **Action:** persist chat→account bindings to `session/` JSON (versioned, like
  `tokens.json`), restore on boot. Keep sessions as-is or optionally persist too.
- **Files:** `src/core/accounts/affinity.js`, `src/core/conversations/store.js`.
- **Verify:** restart keeps an in-flight chat bound to the same account.

### P3.4 — Smoke test for image/video generation  🟢
**Problem:** we test chat thoroughly (121 tests) but media paths are manual.
- **Action:** add `scripts/smoke_media_test.js` (t2i + t2v polling) and wire an npm
  script. Fail loudly with clear errors.
- **Files:** new `scripts/smoke_media_test.js`, `package.json`.
- **Verify:** script runs against a live account and reports URLs.

---

## Not planned (explicitly deferred)

- **Codex Responses API / OpenClaw integration** — only documented in ForgetMeAI,
  no real implementation to copy; add only if a client needs it.
- **ForgetMeAI tool-prompt modes** (`compact/minimal/names`) — our heymoma
  4-level compression covers the same need; revisit only if tool prompts grow.
- **Python parity** — we are Node-only by design; do not chase the Python fork.
- **Full ForgetMeAI keyed-queue with striped locks** — port only the registry,
  not the queue machinery.

---

## Suggested order & estimate

1. P1.1 verify → quick win (read + small fix)
2. P1.2 video feature_config → ~15 min
3. P1.3 partial-stream guard → the trickiest correctness item
4. P2.1 Anthropic shim → highest user value
5. P2.2 + P2.3 scoping/affinity → medium
6. Phase 3 → ongoing hardening, can be scheduled after

After each item: run `pnpm lint` + `pnpm test` (121 tests) and commit.
