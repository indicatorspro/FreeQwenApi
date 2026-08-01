# Source Audit — What came from where, and what we still lack

Reference document mapping every feature of the three source projects against
our server (`FreeQwenApi`). Use this when deciding what to copy, fix, or drop.

- Our project: `C:\VAULT-AI\CUEN\FreeQwenApi`
- Sources:
  - `C:\VAULT-AI\CUEN\FreeQwenApi_heymoma` (layered refactor, best tool calling)
  - `C:\VAULT-AI\CUEN\FreeQwenApi_Ivanqo` (payload v2.1, dual transport, stateless)
  - `C:\VAULT-AI\CUEN\FreeQwenApi_ForgetMeAI` (robustness: scoping, affinity, failover)

None of the three sources delivered a working Qwen reply on its own. Our merge
did. Each source held one piece of the puzzle:

- **heymoma** — great tool-calling pipeline, but broken transport and incomplete payload.
- **Ivanqo** — correct payload, but fake streaming on `/api/chat`, history stubs, broken scripts.
- **ForgetMeAI** — excellent robustness, but *simulated* streaming (waits for the full
  response, then re-emits in 16-char chunks) — the main reason it "never replies".

---

## 1. What we already have, and where it came from

| Feature | Origin | Location (ours) | Status |
|---|---|---|---|
| Payload v2.1 with dual key `chat_id` + `chatId` + `headers.X-Request-Id` | Ivanqo | `src/core/qwen/payload.js:131-139` | ✅ |
| `feature_config.output_schema: 'phase'` | Ivanqo / ForgetMeAI | `src/core/qwen/payload.js:121` | ✅ |
| `thinking_enabled` fix for `qwen3.8-max-preview` | ours | `src/core/qwen/payload.js:25-32` | ✅ |
| Dual transport node→browser with WAF fallback | Ivanqo | `src/core/qwen/transport.js` | ✅ |
| Baxia/AWSC injection (`getFYModule`) | Ivanqo | `src/core/qwen/baxia.js` | ✅ |
| Anti-bot body detection (`rgv587`, `tmd`, `purecaptcha`) | ForgetMeAI | `src/core/qwen/antibot.js` | ✅ |
| Tool calling via prompt `<tools>`/`<tool_call>` | heymoma (most robust) | `src/core/tools/*` | ✅ |
| Stream filter + tolerant parser + validate + repair | heymoma | `src/core/tools/*` | ✅ |
| Transcript fold (`<tool_response>`) | Ivanqo / heymoma | `src/core/tools/transcript.js` | ✅ |
| Account pool round-robin + rate-limit + 401 rotation | all | `src/core/accounts/store.js` | ✅ |
| Affinity chat→account | ForgetMeAI | `src/core/accounts/affinity.js` | ✅ |
| Stateless direct (`QWEN_STATELESS_DIRECT`) | Ivanqo | `src/core/qwen/client.js:224` | ✅ |
| OSS upload inside the browser | Ivanqo / heymoma | `src/core/qwen/files.js` | ✅ |
| Image/Video via t2i/t2v + task polling | all | `src/services/media.js` | ✅ |
| Download proxy anti-SSRF | heymoma | `src/server/routes/system.js:119` | ✅ |
| Sessions with TTL + cleanup | all | `src/core/conversations/store.js` | ✅ |
| Real `testToken` (status/accounts) | Ivanqo | `src/core/qwen/tokens.js` | ✅ |
| Node/browser fetch timeouts (AbortController) | Ivanqo | `src/core/qwen/transport.js:155` | ✅ |
| Hand-crafted stealth + canvas noise | all | `src/browser/stealth.js` | ✅ |
| Single-file dashboard | all | `src/dashboard/index.html` | ✅ |
| Rotating winston logging + morgan | all | `src/shared/logger.js` | ✅ |
| CDP attach + headed mode | Ivanqo | `src/browser/browser.js` | ✅ |
| Clean lint (probes excluded, dead code removed) | ours | `eslint.config.js` | ✅ |
| Puppeteer `taskkill` stderr silenced (patch) | ours | `patches/@puppeteer__browsers@2.13.2.patch` | ✅ |
| Payload dumps → `logRaw` only (clean debug logs) | ours | `src/core/qwen/client.js` | ✅ |

## 2. Features in the sources we do NOT have (or unverified)

| Feature | Where it lives in the source | Gap in ours | Priority |
|---|---|---|---|
| Anthropic shim `POST /api/messages` (Claude Code integration) | ForgetMeAI `routes.js:857,1320` | ❌ not present | high |
| Client scoping (IP+UA+key fingerprint → `chat_<sha256>`, isolates clients) | ForgetMeAI `keyedQueue.js` | ⚠️ only `scopedHash` in `security.js`, no CAS registry | medium |
| Multi-resource affinity (chat + file + task → same account) | ForgetMeAI `chat.js:531-621` | ⚠️ we only bind chat | medium |
| Failover "never retry after partial stream" | ForgetMeAI `chat.js:1107-1153` | ⚠️ unverified in our fallback | high |
| Video-specific `feature_config` (`auto_thinking`, `research_mode`, `thinking_format`) | all sources | ❌ missing in `payload.js` — video sends only `output_schema: phase` | high |
| Tool prompt modes compact/minimal/names + `QWEN_MAX_SYSTEM_CHARS` | ForgetMeAI | ⚠️ we have heymoma 4-level compression, not ForgetMeAI modes | low |
| Codex (Responses API) / OpenClaw integration | ForgetMeAI (documented) | ⚠️ only documented, not implemented anywhere | low |

## 3. Problems the sources have — and whether we inherited them

1. **No timeout on Qwen calls** — ❌ **no longer true**: we added `nodeFetch`/`browserFetch`
   timeouts with `AbortController` (`transport.js:155`). **Gap fixed.**
2. **`output_schema: 'phase'` hardcoded** — all depend on it; if Qwen migrates the
   output schema, everything breaks. Risk, shared.
3. **Affinity in memory** — restart loses bindings. Known limitation, shared.
4. **Legacy `/api/chat` streaming ignores `chatType`** — bug in heymoma; **needs
   verification** whether our `legacy.js` inherited it (stream of t2i/t2v via that route).

## 4. Per-source weaknesses worth remembering

### heymoma
- Dead config block `mcp` (`MCP_HTTP_ENABLED`, `MCP_HTTP_PATH`, `FREEQWEN_BASE_URL`, ...) — never used.
- `toUrl` is a tautology (`config/index.js:41`) — trailing-slash strip never happens.
- Legacy `POST /chats` can break chat→account affinity (uses `nextAvailableAccount`).
- `NON_INTERACTIVE` still blocks on stdin in headless/Docker.
- No timeout on Qwen calls (fixed in ours).

### Ivanqo
- `scripts/test_direct_qwen.js` broken (imports that don't exist).
- History endpoints are stubs (always return `[]`).
- `/api/chat` streaming is fake (waits, re-emits 16-char chunks).
- Massive duplication between `/chat/completions` and `/v1/chat/completions`.
- `chatIdMap`/sessions in memory — lost on restart.
- Python (`main.py`) is a minimal subset: no image/video/dashboard/relogin/upload.

### ForgetMeAI
- Full dependency on Qwen web protocol (`Version: 0.2.63`, `chat_id` in query, `output_schema: phase`).
- Tokens in plaintext at `session/tokens.json` / `session/auth_token.txt`.
- Streaming SSE is simulated in Node (`routes.js:974-1027`).
- Node/Python logic duplication — drifts over time (Python lacks `Version` header).
- Python rejects files with 409 `requires_file_reupload`.
- `output_schema: 'phase'` hardcoded everywhere.

---

## 5. What made only OUR version work

- Payload from **Ivanqo** (dual key + `X-Request-Id` header) ✓
- Tool calling from **heymoma** (prompt-based, most robust) ✓
- Robustness ideas from **ForgetMeAI** (scoping/affinity/failover) ✓
- Real streaming from node fetch (not the simulated 16-char chunks) ✓
- `thinking_enabled` fix for `qwen3.8-max-preview` (ours) ✓
- Timeouts + clean debug logging + silenced taskkill (ours) ✓
