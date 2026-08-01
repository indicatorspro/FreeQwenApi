# Architecture

Three layers, dependencies point only inward: `server → services → core`.
The core knows nothing about Express or the OpenAI format, so it can be
tested and reused from the CLI or another transport.

```text
index.js
└── src/server/start.js         startup: menu, browser, listen, graceful shutdown
    └── src/server/app.js       Express app assembly
        ├── middleware/         authorization (timing-safe), CORS (origin policy), localOnly
        ├── openai.js           response format: JSON and SSE
        └── routes/
            ├── completions.js  POST /api/(v1/)chat/completions
            ├── legacy.js       POST /api/chat, chat management
            ├── media.js        images, video, task statuses
            ├── files.js        file uploads
            ├── accounts.js     account management (localhost only)
            └── system.js       health, status, models, download

src/services/                   scenarios shared across any transport
├── completions.js              dialog + tools + call repair
└── media.js                    image and video generation

src/core/                       domain, transport-agnostic
├── qwen/                       Qwen Chat client
│   ├── client.js               sendMessage: account → chat → request → retries
│   ├── transport.js            node fetch + browser fetch, fallback on WAF
│   ├── antibot.js              Aliyun WAF detection (TMD, rgv587, PureCaptcha)
│   ├── baxia.js                Baxia/AWSC runtime preparation (proactive anti-bot)
│   ├── sse.js                  stream parsing (single implementation for both paths)
│   ├── payload.js              request body for /api/v2/chat/completions
│   ├── chats.js, tasks.js      chat creation, long-running task polling
│   ├── pagePool.js             browser tab pool
│   ├── tokens.js, authState.js account selection and current token
│   ├── files.js                upload to OSS
│   └── media.js                media link extraction from responses
├── tools/                      tool calling
│   ├── registry.js             tools/functions normalization, name resolution
│   ├── prompt.js               tool descriptions for the model
│   ├── parser.js               model response parsing
│   ├── stream.js               stream filter
│   ├── validate.js             argument validation and coercion
│   └── transcript.js           history folding with tool results
├── conversations/              client id ↔ Qwen chat mapping
├── accounts/store.js           account pool, rotation, limits
├── models/                     model list and aliases
├── history/store.js            local history copy
├── dashscope/images.js         generation via official API
└── apiKeys.js                  proxy access keys

src/browser/                    Puppeteer: launch, session, stealth, verification
src/shared/                     logger, errors, identifiers, paths, security, originPolicy
src/config/                     configuration with validation (frozen, typed)
src/cli/                        interactive console scenarios
```

## Anti-Bot Protection (Aliyun WAF / Baxia)

Two levels of defense against the Aliyun anti-bot system:

### Proactive: Baxia Runtime (`core/qwen/baxia.js`)

Before each request, loads AWSC scripts and waits for `uidToken` generation:

```text
preparePageForApi(page, { token })
├── localStorage.setItem('token', ...)    token synchronization
└── ensureBaxiaReady(page)
    ├── loadScript(awsc.js)               Anti-bot Web Security Component
    ├── loadScript(baxiaCommon.js)        Baxia entry point
    └── poll __baxia__.getFYModule().getUidToken()  (up to 12s)
```

Without `uidToken`, the WAF may block a request even with perfect stealth patches.

### Reactive: Detection (`core/qwen/antibot.js`)

Recognizes signatures of blocked responses:

| Signature | Meaning |
|---|---|
| `/_____tmd_____/punish` | TMD punish page (Aliyun anti-bot) |
| `rgv587` | Aliyun WAF challenge page |
| `fail_sys_user_validate` | System validation error |
| `purecaptcha` | PureCaptcha challenge |
| `aliyun_waf`, `_waf_` | Direct WAF markers |
| `window._config_` + `captcha` | Combined signature |

On detection: `antiBot: true` flag in `TransportResult`, status 403,
automatic browser restart in visible mode for verification.

## Two Paths to Qwen

A request goes either directly from Node or via `fetch` inside a browser
page. The strategy is controlled by `QWEN_NODE_FETCH_FIRST`:

```text
executeChatRequest
├── nodeFetchFirst=true:
│   ├── requestViaNode        fast (30s timeout); WAF may spoof the response
│   └── requestViaBrowser     fallback on WAF/timeout/5xx
└── nodeFetchFirst=false (default):
    └── requestViaBrowser     browser immediately (carries session + Baxia, more reliable)
```

Stream parsing is shared between both paths (`core/qwen/sse.js`). Previously it was
duplicated, and the browser copy couldn't emit chunks — when WAF triggered,
streaming turned into prolonged silence.

## Request Lifecycle with Tools

```text
POST /api/v1/chat/completions
  ↓ routes/completions.js      body parsing, client key, stream mode
  ↓ services/completions.js
      registry     ← client's tools[]
      resolver     ← chatId / conversation_id / session
      transcript   ← history folding if tool results are present
      prompt       → system message with tool descriptions
  ↓ core/qwen/client.js        account, chat, Baxia prep, request, retries
  ↓ core/tools/stream.js       filter: internal JSON not sent to client
  ↓ core/tools/parser.js        <tool_call> / fence / {"tool_calls":…}
  ↓ core/tools/validate.js     name from registry, argument types, required fields
  ↓ (on failure) clarification request to the model, TOOL_CALL_MAX_REPAIRS times
  ↑ server/openai.js           chat.completion or SSE with tool_calls
```

## Security

| Mechanism | Where | What it does |
|---|---|---|
| Timing-safe auth | `shared/security.js` | API key comparison without timing leakage |
| Origin policy | `shared/originPolicy.js` | CORS: loopback + ALLOWED_ORIGINS, blocks foreign origins |
| Stealth patches | `browser/stealth.js` | Canvas noise, mouse delay, navigator spoofing |
| LocalOnly | `middleware/index.js` | Account management only from 127.0.0.1 |

## Process State

| What | Where | Why |
|---|---|---|
| Current Qwen token | `core/qwen/authState.js` | single token for chat creation and sending |
| Tab pool | `core/qwen/pagePool.js` | browser page reuse |
| Dialog sessions | `core/conversations/store.js` | chat continuation across requests |
| Chat aliases | same location | internal `chat_…` ↔ real Qwen id |
| Accounts | `session/tokens.json` | pool, limits, statuses |

The account pool rotates in a round-robin fashion. On 401, the account is marked
invalid; on 429, it is blocked for the duration from Qwen's response (or
`QWEN_RATELIMIT_HOURS`), and the request is retried with a new account. The
`chatId` is reset on account switch: the chat belongs to the previous token and
does not exist under the new one.
