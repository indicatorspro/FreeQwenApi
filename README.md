# FreeQwenApi

> **Local OpenAI-compatible proxy for Qwen Chat**
> Text, Qwen 3.7 models, files, Open WebUI, Hermes/LiteLLM, and now image and video generation through Qwen Chat.

![API](https://img.shields.io/badge/API-OpenAI--compatible-green)
![Qwen](https://img.shields.io/badge/Qwen-Chat-purple)

## What this is

FreeQwenApi turns a Qwen Chat web account into a local API endpoint:

```text
http://localhost:3264/api
```

This is **not a local model running on your GPU** and **not the official Alibaba/Qwen API**. It is a practical browser-based proxy: you authenticate in Qwen Chat, the project saves the session and provides a local OpenAI-compatible API for your tools.

## Fork features

- **Chat Completions API**: `POST /api/chat/completions`, compatible with OpenAI SDK, Open WebUI, LiteLLM and agents.
- **Tool calling for coding agents**: the `tools` field from the request is turned into real `tool_calls` — Codex, OpenCode, Cline, Continue and tools from MCP servers connected to them work ([docs/TOOL_CALLING.md](docs/TOOL_CALLING.md)).
- **Current Qwen Chat models**: `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus` and other models from `src/AvailableModels.txt`.
- **Image generation through Qwen Chat**: `POST /api/images/generations` without `DASHSCOPE_API_KEY`.
- **Video generation through Qwen Chat**: `POST /api/videos/generations` + task polling via `GET /api/tasks/status/:taskId`.
- **Multi-account**: adding, re-login, removal, statuses `OK` / `WAIT` / `INVALID`, automatic round-robin rotation on limits.
- **File upload**: upload endpoint for files and Qwen attachments.
- **Open WebUI**: can be connected as an OpenAI-compatible backend.
- **Hermes Agent / LiteLLM / Claude Code**: ready-made config examples for local AI agents.
- **Health/smoke tooling**: `/api/health`, `/api/status`, `/api/models`, `npm run smoke`, `npm run models:sync`.

## Quick start

```bash
git clone https://github.com/heymoma/FreeQwenApi
cd FreeQwenApi
npm install
npm run auth
npm run models:sync
SKIP_ACCOUNT_MENU=true npm start
```

In another terminal:

```bash
npm run smoke
```

If everything is fine, the API is available here:

```text
http://localhost:3264/api
```

## Configuration

All settings are defined by environment variables. The full list with defaults and comments is in [`.env.example`](.env.example): port, default model, timeouts, limits, paths, logging, Chrome path, etc.

Variables are read from the process environment. Set the required ones in a convenient way:

```bash
export PORT=3264 DEFAULT_MODEL=qwen3.7-max   # bash
$env:PORT=3264; npm start                    # PowerShell
```

or through the `environment:` block in `docker-compose.yml` / `-e` flags for `docker run`.

## Qwen Chat authentication

Add an account:

```bash
npm run auth
```

Or immediately a specific action:

```bash
npm run auth -- --add
npm run auth -- --list
npm run auth -- --relogin
npm run auth -- --remove
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
  "models": 28
}
```

### Model list

```bash
curl http://localhost:3264/api/models
```

Update the model list from Qwen Chat metadata:

```bash
npm run models:sync
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

Claude Code speaks the Anthropic format, so a bridge is needed — LiteLLM:

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

## Docker

First add an account locally, because inside the container there is no GUI for login:

```bash
npm run auth
```

Then:

```bash
docker compose up --build -d
```

In `docker-compose.yml` it is important to mount `session/`:

```yaml
services:
  qwen-proxy:
    build: .
    environment:
      - SKIP_ACCOUNT_MENU=true
      - PORT=3264
    ports:
      - "3264:3264"
    volumes:
      - ./session:/app/session
      - ./logs:/app/logs
      - ./uploads:/app/uploads
```

## Recommended models

- **Regular chat / agents**: `qwen3.7-max`
- **Faster and lighter**: `qwen3.7-plus`
- **Coding**: `qwen3-coder-plus`
- **Images/video through Qwen Chat**: `qwen3-vl-plus`
- **Open WebUI default**: `qwen3.7-max`

## Useful commands

```bash
npm run auth                  # account management
npm run models:sync           # update model list
npm run smoke                 # quick API check
SKIP_ACCOUNT_MENU=true npm start
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
npm test          # vitest
npm run lint      # eslint
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
- [docs/FORK_DEMO_QUICKSTART.md](docs/FORK_DEMO_QUICKSTART.md) — quick scenario for demo/video.
- [docs/QWEN_CHAT_MODELS.md](docs/QWEN_CHAT_MODELS.md) — Qwen Chat model synchronization report.
- [IMAGE_VIDEO_GENERATION_GUIDE.md](IMAGE_VIDEO_GENERATION_GUIDE.md) — image and video generation via `chatType`.
- [docs/IMAGE_GENERATION.md](docs/IMAGE_GENERATION.md) — DashScope/Qwen Image endpoints.
- [docs/OPENWEBUI_SETUP.md](docs/OPENWEBUI_SETUP.md) — connecting Open WebUI.
- [examples/hermes/config-snippet.yaml](examples/hermes/config-snippet.yaml) — Hermes Agent provider.
- [examples/litellm/qwen_litellm.yaml](examples/litellm/qwen_litellm.yaml) — LiteLLM bridge.

## Limitations

- This is an unofficial browser-based proxy; Qwen may change the internal API.
- Qwen Chat accounts may hit limits; use multiple accounts for round-robin.
- Tokens expire — use `npm run auth -- --relogin`.
- Photo/video generation depends on the availability of Qwen Chat features on a particular account.
- Generated media URLs may be temporary.
- Use cautiously in production: this is a tool for experiments, demos and local workflows.
