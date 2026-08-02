# FreeQwenApi

> **Local OpenAI/Anthropic-compatible proxy for Qwen Chat**
> Text, Qwen 3.7 models, files, Open WebUI, Claude Code, and image/video generation through Qwen Chat.

![API](https://img.shields.io/badge/API-OpenAI--compatible-green)
![Qwen](https://img.shields.io/badge/Qwen-Chat-purple)

## What this is

FreeQwenApi turns a Qwen Chat web account into a local API endpoint:

```text
http://localhost:3264/api
```

This is **not a local model running on your GPU** and **not the official Alibaba/Qwen API**. It is a practical browser-based proxy: you authenticate in Qwen Chat, the project saves the session and provides a local OpenAI-compatible API for your tools.

## Fork features

- **Chat Completions API**: `POST /api/chat/completions` (and `/api/v1/chat/completions`), compatible with OpenAI SDK, Open WebUI, LiteLLM and agents.
- **Anthropic Messages shim**: `POST /api/messages` (and `/api/v1/messages`) — Claude Code can point `ANTHROPIC_BASE_URL` directly at the proxy, no LiteLLM bridge needed. Streaming SSE with real `tool_use` blocks.
- **Tool calling for coding agents**: the `tools` field from the request is turned into real `tool_calls` — Codex, OpenCode, Cline, Continue and tools from MCP servers connected to them work ([docs/TOOL_CALLING.md](docs/TOOL_CALLING.md)).
- **Current Qwen Chat models**: `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus` and other models from `src/AvailableModels.txt`.
- **Image generation through Qwen Chat**: `POST /api/images/generations` without `DASHSCOPE_API_KEY`.
- **Video generation through Qwen Chat**: `POST /api/videos/generations` + task polling via `GET /api/tasks/status/:taskId`.
- **Multi-account**: adding, re-login, removal, statuses `OK` / `WAIT` / `INVALID`, automatic round-robin rotation on limits.
- **Client isolation**: each client (IP + User-Agent + API-key fingerprint) gets deterministic, isolated chat aliases — no cross-client collisions.
- **Resource affinity**: chats, file uploads and generation tasks stay bound to the account that owns them; bindings survive restarts (`session/affinity.json`).
- **File upload**: upload endpoint for files and Qwen attachments.
- **Open WebUI**: can be connected as an OpenAI-compatible backend.
- **Hermes Agent / LiteLLM / Claude Code**: ready-made config examples for local AI agents.
- **Health/smoke tooling**: `/api/health`, `/api/status`, `/api/models`, `pnpm run smoke`, `pnpm run smoke:media`, `pnpm run models:sync`.

## Quick start

```bash
git clone https://github.com/indicatorspro/FreeQwenApi
cd FreeQwenApi
pnpm install
pnpm start
```

The API will be available at:

```text
http://localhost:3264/api
```

## Configuration

All settings are defined by environment variables. The full list with defaults and comments is in [`.env.example`](.env.example): port, default model, timeouts, limits, paths, logging, Chrome path, etc.

Variables are read from the process environment. Set the required ones in a convenient way:

```bash
export PORT=3264 DEFAULT_MODEL=qwen3.7-max   # bash
$env:PORT=3264; pnpm start                   # PowerShell
```

**Recommended:** set `QWEN_NODE_FETCH_FIRST=true` (default in `.env.example`). This routes API requests through Node.js `fetch` first, falling back to the browser only if blocked by WAF. Without it, every request goes through the browser path which is slower and less reliable.

## Qwen Chat authentication

Add an account:

```bash
pnpm run auth
```

Or immediately a specific action:

```bash
pnpm run auth -- --add
pnpm run auth -- --list
pnpm run auth -- --relogin
pnpm run auth -- --remove
```

When adding an account, Chromium will open. Log in to Qwen Chat, then return to the terminal — the token will be saved in `session/`.

**Do not commit or publish secrets:**

- `session/`
- `session/tokens.json`
- `session/accounts/**/token.txt`
- `.env`
- `Authorization.txt`
- cookies / browser profile / real tokens

## Main endpoints

### Health

```bash
curl http://localhost:3264/api/health
```

The response contains the number of models and accounts:

```json
{
  "ok": true,
  "service": "FreeQwenApi",
  "baseUrl": "/api",
  "models": 29
}
```

### Model list

```bash
curl http://localhost:3264/api/models
```

Update the model list from Qwen Chat metadata:

```bash
pnpm run models:sync
```

Detailed report: [docs/QWEN_CHAT_MODELS.md](docs/QWEN_CHAT_MODELS.md)

### Chat Completions

```bash
curl http://localhost:3264/api/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.7-max",
    "messages": [
      {"role": "user", "content": "Answer briefly: what is FreeQwenApi?"}
    ],
    "stream": false
  }'
```

OpenAI SDK:

```js
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://localhost:3264/api',
  apiKey: 'dummy-key'
});

const response = await openai.chat.completions.create({
  model: 'qwen3.7-max',
  messages: [{ role: 'user', content: 'Hello!' }]
});

console.log(response.choices[0].message.content);
```

## Claude Code (Anthropic Messages)

Claude Code speaks the Anthropic format natively. Point `ANTHROPIC_BASE_URL`
at the proxy — the built-in shim (`/api/v1/messages`) translates to Qwen and
back, including streaming and `tool_use` blocks:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:3264/api
export ANTHROPIC_AUTH_TOKEN=dummy
export ANTHROPIC_MODEL=qwen3.7-max
claude
```

The same endpoint works for any Anthropic SDK client. Tool calling through the
shim is covered in [docs/TOOL_CALLING.md](docs/TOOL_CALLING.md).

## Image generation through Qwen Chat

By default `/api/images/generations` uses **Qwen Chat**, not DashScope. That means a separate `DASHSCOPE_API_KEY` is not required — an active Qwen Chat account is required.

```bash
curl http://localhost:3264/api/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Cinematic robot in neon Tokyo, sci-fi poster style",
    "model": "qwen3-vl-plus",
    "size": "16:9"
  }'
```

Example response:

```json
{
  "created": 1770000000,
  "provider": "qwen-chat",
  "model": "qwen3-vl-plus",
  "data": [
    { "url": "https://cdn.qwenlm.ai/.../image.png", "revised_prompt": "..." }
  ]
}
```

Supported `size` formats for Qwen Chat:

- `16:9`
- `9:16`
- `1:1`
- `4:3`
- you can also pass OpenAI-style `1024x1024`, `1792x1024`, `1024x1792` — they will be converted to aspect ratio.

The old DashScope mode is also kept:

```json
{
  "provider": "dashscope",
  "model": "qwen-image-plus",
  "prompt": "..."
}
```

Details: [IMAGE_VIDEO_GENERATION_GUIDE.md](IMAGE_VIDEO_GENERATION_GUIDE.md) and [docs/IMAGE_GENERATION.md](docs/IMAGE_GENERATION.md)

## Video generation through Qwen Chat

Create a video and wait for the result on the server:

```bash
curl http://localhost:3264/api/videos/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Camera slowly approaches a futuristic city at night, cinematic, 5 seconds",
    "model": "qwen3-vl-plus",
    "size": "16:9",
    "wait": true
  }'
```

If you do not want to keep the HTTP connection open:

```bash
curl http://localhost:3264/api/videos/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Robot walking in the rain in a neon city",
    "size": "16:9",
    "wait": false
  }'
```

The response will return `task_id`. Check status:

```bash
curl http://localhost:3264/api/tasks/status/TASK_ID
```

Or wait for completion directly in the status endpoint:

```bash
curl "http://localhost:3264/api/tasks/status/TASK_ID?wait=true"
```

## MCP Server for AI Agents (AionUI, Claude Desktop, etc.)

The project includes an MCP (Model Context Protocol) server that exposes image and video generation as tools for AI agents. This allows agents to generate media directly through tool calls.

### Architecture

```
User → AI Agent (AionUI, Claude Code, Codex, Hermes Agent, Claude Desktop) → MCP Server (mcp-media/server.js) → FreeQwenApi Proxy → Qwen Chat
```

The MCP server:
- Receives `generate_image` and `generate_video` tool calls from the agent
- Forwards requests to the FreeQwenApi proxy
- Downloads the generated media from the CDN
- Saves files locally to the conversation's working directory
- Returns the CDN URL + local path to the agent

### Setup

**1. Start the FreeQwenApi proxy** (required — the MCP server depends on it):

```bash
cd FreeQwenApi
pnpm start
```

**2. Configure the MCP server in your AI client:**

Add the MCP server to your client's configuration file. Works with AionUI, Claude Code, Codex, Hermes Agent, Claude Desktop, and any MCP-compatible client:

| Client | Config file |
|--------|-------------|
| **AionUI** | App settings → MCP Servers |
| **Claude Desktop** | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows) |
| **Claude Code** | `.mcp.json` in your project root |
| **Codex / Hermes Agent** | Project-level MCP config or `settings.json` |

```json
{
  "mcpServers": {
    "qwen-media-creator": {
      "command": "node",
      "args": ["C:\\VAULT-AI\\CUEN\\FreeQwenApi\\mcp-media\\server.js"],
      "env": {
        "FREEQWEN_API_URL": "http://127.0.0.1:3264/api"
      }
    }
  }
}
```

> **Tip:** adjust the `args` path to where you cloned the repository.

> ⚠️ **If you changed the proxy port** (via `PORT=4000` in `.env`), adjust `FREEQWEN_API_URL` in the MCP JSON to `http://127.0.0.1:4000/api`. The MCP does not auto-discover the proxy port — it uses exactly what is configured in this variable. The same applies if the proxy is running on a different host (e.g., `http://192.168.1.100:3264/api`).

**3. Install the Skill (recommended):**

> ⚠️ **The skill ensures correct operation.** Without it, the agent will not pass the `save_dir` parameter and files will be saved to a global fallback directory instead of the conversation's working directory.

Import the skill from `skills/qwen-media-creator/SKILL.md` into your AI client (AionUI, Claude Code, etc.). The skill instructs the agent to:
- Always pass `save_dir` with the current conversation's working directory
- Include the generated image inline using markdown
- Provide the CDN download link and local file path

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FREEQWEN_API_URL` | `http://127.0.0.1:3264/api` | FreeQwenApi proxy URL |
| `FREEQWEN_MEDIA_DIR` | (auto-detected) | Override the default save directory |
| `QWEN_MEDIA_MODEL` | `qwen3-vl-plus` | Default generation model |

### Save Directory Priority

Files are saved in this order of priority:

1. **`save_dir` parameter** — passed by the agent (set by the skill to the conversation's temp directory)
2. **`FREEQWEN_MEDIA_DIR` env var** — explicit override in MCP config
3. **`process.cwd()/generated`** — auto-detected from the MCP process working directory
4. **`C:\qwen-media-generated`** — global fallback

### Available Tools

**`generate_image`**
- `prompt` (required) — text description of the image
- `size` (optional) — `16:9`, `9:16`, `1:1`, `4:3`
- `model` (optional) — `qwen-image-max`, `qwen-image-plus`, `wan2.6-t2i`, etc.
- `save_dir` (required via skill) — conversation working directory
- `filename` (optional) — custom filename without extension

**`generate_video`**
- `prompt` (required) — text description of the video
- `size` (optional) — `16:9`, `9:16`, `1:1`
- `model` (optional) — `wan2.6-t2v`, `wan2.5-t2v-preview`, `wan2.2-t2v-flash`
- `save_dir` (required via skill) — conversation working directory
- `filename` (optional) — custom filename without extension

### Error Handling

The MCP server includes automatic retry logic:
- **Rate limits (429)**: fails immediately with a clear message
- **Server errors (5xx)**: retries up to 3 times with 2s delay
- **Network errors**: retries up to 3 times with 2s delay
- **Download failures**: returns the CDN URL without local save (graceful degradation)

## Open WebUI

For local Open WebUI:

```text
Base URL: http://localhost:3264/api
API Key: dummy-key
Model: qwen3.7-max
```

If Open WebUI is in Docker:

```text
Base URL: http://host.docker.internal:3264/api
API Key: dummy-key
```

Full guide: [docs/OPENWEBUI_SETUP.md](docs/OPENWEBUI_SETUP.md)

## Agents and tool calling

The proxy accepts `tools` (and deprecated `functions`) and returns real
`tool_calls` — in both streaming and normal mode. Tools from MCP servers
connected to the agent arrive as ordinary functions and work the same way.

Codex CLI (`~/.codex/config.toml`):

```toml
model = "qwen3.7-max"
model_provider = "freeqwen"

[model_providers.freeqwen]
name = "FreeQwenApi"
base_url = "http://127.0.0.1:3264/api/v1"
wire_api = "chat"
env_key = "FREEQWEN_API_KEY"
```

OpenCode (`opencode.json`):

```json
{
  "provider": {
    "freeqwen": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "FreeQwenApi",
      "options": { "baseURL": "http://127.0.0.1:3264/api/v1", "apiKey": "dummy" },
      "models": { "qwen3.7-max": { "name": "Qwen 3.7 Max", "tools": true } }
    }
  }
}
```

Claude Code speaks the Anthropic format — the proxy's built-in `/api/v1/messages`
shim translates directly, no bridge needed:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:3264/api
export ANTHROPIC_AUTH_TOKEN=dummy
export ANTHROPIC_MODEL=qwen3.7-max
claude
```

If you prefer a bridge (LiteLLM), it still works:

```yaml
model_list:
  - model_name: qwen3.7-max
    litellm_params:
      model: openai/qwen3.7-max
      api_base: http://127.0.0.1:3264/api/v1
      api_key: dummy
```

```bash
litellm --config litellm.yaml --port 4000
ANTHROPIC_BASE_URL=http://127.0.0.1:4000 ANTHROPIC_MODEL=qwen3.7-max claude
```

Full guide with all clients, variables and verification:
[docs/TOOL_CALLING.md](docs/TOOL_CALLING.md).
Ready examples: [examples/hermes/config-snippet.yaml](examples/hermes/config-snippet.yaml),
[examples/litellm/qwen_litellm.yaml](examples/litellm/qwen_litellm.yaml).

## Recommended models

- **Regular chat / agents**: `qwen3.7-max`
- **Faster and lighter**: `qwen3.7-plus`
- **Coding**: `qwen3-coder-plus`
- **Images/video through Qwen Chat**: `qwen3-vl-plus`
- **Open WebUI default**: `qwen3.7-max`

## Useful commands

```bash
pnpm run auth                  # account management
pnpm run models:sync           # update model list
pnpm run smoke                 # quick API check
pnpm run smoke:media           # image/video generation check
SKIP_ACCOUNT_MENU=true pnpm start
```

Manual checks:

```bash
curl http://localhost:3264/api/health
curl http://localhost:3264/api/status
curl http://localhost:3264/api/models
curl http://localhost:3264/api/images/status
curl http://localhost:3264/api/videos/status
```

## Development

```bash
pnpm test          # vitest
pnpm run lint      # eslint
```

Project structure — three layers, dependencies point inward:

```text
src/server/    HTTP: application, middleware, routes, OpenAI format
src/services/  scenarios shared by any transport
src/core/      domain: Qwen client, tools, accounts, models, conversations
src/browser/   Puppeteer: launch, session, stealth
src/shared/    logger, errors, identifiers, paths
src/config/    configuration with validation
```

More details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Documentation

- [docs/TOOL_CALLING.md](docs/TOOL_CALLING.md) — tool calling and agent setup.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — project structure.
- [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) — planned and implemented improvements.
- [docs/FORK_DEMO_QUICKSTART.md](docs/FORK_DEMO_QUICKSTART.md) — quick scenario for demo/video.
- [docs/QWEN_CHAT_MODELS.md](docs/QWEN_CHAT_MODELS.md) — Qwen Chat model synchronization report.
- [IMAGE_VIDEO_GENERATION_GUIDE.md](IMAGE_VIDEO_GENERATION_GUIDE.md) — image and video generation via `chatType`.
- [docs/IMAGE_GENERATION.md](docs/IMAGE_GENERATION.md) — DashScope/Qwen Image endpoints.
- [docs/OPENWEBUI_SETUP.md](docs/OPENWEBUI_SETUP.md) — connecting Open WebUI.
- [examples/hermes/config-snippet.yaml](examples/hermes/config-snippet.yaml) — Hermes Agent provider.
- [examples/litellm/qwen_litellm.yaml](examples/litellm/qwen_litellm.yaml) — LiteLLM bridge.

## Troubleshooting

**WAF blocks / intermittent `Bad_Request`:**
Qwen's Aliyun WAF may intermittently block Node.js requests (returns an HTML challenge page instead of JSON). With `QWEN_NODE_FETCH_FIRST=true`, the proxy automatically falls back to the browser path. If you see frequent WAF blocks, try:
- Restarting the server (resets browser session state)
- Re-authenticating: `pnpm run auth -- --relogin`
- Using multiple accounts for rotation

**Image generation returns empty content:**
Image URLs arrive in trailing SSE chunks after the main response finishes. The proxy handles this automatically via raw chunk preservation. If it fails, check `logs/raw-responses1.log` for the full SSE stream.

**Video generation "Task not found":**
Video uses `stream: false` + task polling (not SSE). If polling fails, ensure your account has video generation enabled on Qwen Chat.

**Browser page shows "Log in / Sign up":**
The browser session lost authentication. Run `pnpm run auth -- --relogin` to refresh tokens.

## Limitations

- This is an unofficial browser-based proxy; Qwen may change the internal API.
- Qwen Chat accounts may hit limits; use multiple accounts for round-robin.
- Tokens expire — use `pnpm run auth -- --relogin`.
- Photo/video generation depends on the availability of Qwen Chat features on a particular account.
- Generated media URLs may be temporary.
- Use cautiously in production: this is a tool for experiments, demos and local workflows.
