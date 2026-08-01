# Tool Calling: Connecting Agents (Codex, Claude Code, OpenCode)

FreeQwenApi accepts the `tools` field from OpenAI requests and returns proper
`tool_calls`. This is exactly what coding agents need: they pass their built-in
tools and connected MCP server tools this way.

```text
Agent ──tools[]──▶ FreeQwenApi ──prompt──▶ Qwen Chat
Agent ◀─tool_calls── FreeQwenApi ◀─<tool_call>── Qwen Chat
```

## How It Works

The Qwen Chat web API does not accept JSON Schema tool definitions — there is no
`tools` field. So the proxy describes tools in the system message using Qwen's
native format (`<tools>` + `<tool_call>`), and parses the model's response back
into the OpenAI structure.

| Step | What the proxy does |
|---|---|
| Ingestion | normalizes `tools` and legacy `functions`, removes duplicates |
| Prompt | describes tools in Qwen's native format, respects `tool_choice` |
| Response | parses `<tool_call>`, markdown fences, `{"tool_calls":[…]}`, bare object |
| Repair | fixes broken JSON, re-queries on unknown name/arguments |
| Validation | coerces arguments to JSON Schema types, checks required fields |
| Streaming | holds back internal JSON, emits `tool_calls` as deltas |

### MCP-Prefixed Names

Claude Code and other clients pass MCP tools as
`mcp__github__create_pull_request`. The model often responds with the short name
(`create_pull_request`). The proxy restores the full name — the client receives
exactly what it declared. If the short name is ambiguous (two MCP servers exposed
the same `search`), the proxy does not guess and requests clarification from the model.

### Many Tools

Agents send dozens of tools. The description block is limited by a budget
(`TOOL_PROMPT_MAX_CHARS`, default 24000 characters) and is compressed in stages
when exceeded: first descriptions, then schema nesting depth, then signature
format. Tool names are trimmed last — a tool absent from the prompt does not
exist for the model.

### Tool Results

A turn where the agent sends `role: "tool"` cannot be continued in Qwen's server
history — that role does not exist there. Such a request is folded into a single
message using `<tool_call>` / `<tool_response>` notation; long results are
truncated (`TOOL_RESULT_MAX_CHARS`).

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `TOOL_PROMPT_MAX_CHARS` | `24000` | character budget for tool descriptions |
| `TOOL_CALL_MAX_REPAIRS` | `1` | clarification requests on invalid calls |
| `TOOL_RESULT_MAX_CHARS` | `8000` | tool result truncation in history |
| `TOOL_COERCE_ARGUMENTS` | `true` | coerce arguments to schema types |

## Agent Configuration

In all examples the proxy runs locally: `http://127.0.0.1:3264/api/v1`.
If keys are set in `src/Authorization.txt`, use yours in the API key field;
if the file is empty, authorization is disabled and any string will work.

### Codex CLI

`~/.codex/config.toml`:

```toml
model = "qwen3.7-max"
model_provider = "freeqwen"

[model_providers.freeqwen]
name = "FreeQwenApi"
base_url = "http://127.0.0.1:3264/api/v1"
wire_api = "chat"
env_key = "FREEQWEN_API_KEY"
```

```bash
export FREEQWEN_API_KEY=dummy   # or the key from src/Authorization.txt
codex
```

`wire_api = "chat"` is required: the proxy implements Chat Completions, not the
Responses API.

### OpenCode

`opencode.json` in the project root or `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "freeqwen": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "FreeQwenApi",
      "options": {
        "baseURL": "http://127.0.0.1:3264/api/v1",
        "apiKey": "dummy"
      },
      "models": {
        "qwen3.7-max": { "name": "Qwen 3.7 Max", "tools": true }
      }
    }
  }
}
```

### Claude Code

Claude Code speaks the Anthropic Messages API format, while the proxy speaks
OpenAI. A bridge is needed, for example LiteLLM:

```yaml
# litellm.yaml
model_list:
  - model_name: qwen3.7-max
    litellm_params:
      model: openai/qwen3.7-max
      api_base: http://127.0.0.1:3264/api/v1
      api_key: dummy
```

```bash
litellm --config litellm.yaml --port 4000

export ANTHROPIC_BASE_URL=http://127.0.0.1:4000
export ANTHROPIC_AUTH_TOKEN=dummy
export ANTHROPIC_MODEL=qwen3.7-max
claude
```

LiteLLM serves an Anthropic-compatible `/v1/messages` and translates tool calls
between formats itself. An alternative is `claude-code-router` with the same
`base_url`.

### Other Clients

| Client | What to specify |
|---|---|
| OpenAI SDK (Python/JS) | `base_url="http://127.0.0.1:3264/api/v1"` |
| Cline / Roo Code | provider "OpenAI Compatible", same base URL |
| Continue | `provider: openai`, same `apiBase` |
| Aider | `--openai-api-base http://127.0.0.1:3264/api/v1` |
| Open WebUI | see [OPENWEBUI_SETUP.md](OPENWEBUI_SETUP.md) |

## Verification

```bash
curl -s http://127.0.0.1:3264/api/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "qwen3.7-max",
    "messages": [{"role": "user", "content": "Read the file src/index.js"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "Reads a project file",
        "parameters": {
          "type": "object",
          "properties": {"path": {"type": "string"}},
          "required": ["path"]
        }
      }
    }]
  }' | jq '.choices[0]'
```

Expected response:

```json
{
  "index": 0,
  "message": {
    "role": "assistant",
    "content": null,
    "tool_calls": [{
      "id": "call_…",
      "type": "function",
      "function": { "name": "read_file", "arguments": "{\"path\":\"src/index.js\"}" }
    }]
  },
  "finish_reason": "tool_calls"
}
```

## Limitations

- Non-function tool types (`web_search`, `code_interpreter`, and similar
  server-side tools) cannot be executed by the proxy and are silently skipped.
- Parallel calls are supported, but quality depends on the model: `qwen3.7-max`
  and `qwen3-coder-plus` maintain discipline noticeably better than smaller models.
- Strict schema (`strict: true`) is accepted, but enforcement is guaranteed not
  by the model's response format but by proxy-side validation.
- Arguments are coerced to schema types; if required fields are missing, the
  proxy re-queries the model rather than returning a known-broken call to the client.
