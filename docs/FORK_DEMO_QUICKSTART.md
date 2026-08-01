# Quick Start for the Updated FreeQwenApi Fork Demo

This fork is prepared for a practical video and demonstration scenario:

- synchronization of the current Qwen Chat model list (`qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus`);
- a local OpenAI-compatible endpoint for SDKs, Hermes Agent, Open WebUI, and LiteLLM;
- a quick smoke test so you don't have to guess whether the proxy is alive before recording.

## 1. Authenticate Once

```bash
npm install
npm run auth
```

Do not publish `session/`, cookies, or token files.

## 2. Sync Current Qwen Chat Models

```bash
npm run models:sync
```

The command reads public prerendered model metadata from `https://chat.qwen.ai/`, merges it with `src/AvailableModels.txt`, and writes the report here:

```text
docs/QWEN_CHAT_MODELS.md
```

## 3. Start the Endpoint

```bash
SKIP_ACCOUNT_MENU=true npm start
```

Endpoint:

```text
http://localhost:3264/api
```

## 4. Run the Smoke Test

In another terminal:

```bash
npm run smoke
```

Default model for the test:

```text
qwen3.7-max
```

You can override it:

```bash
QWEN_PROXY_SMOKE_MODEL=qwen3.7-plus npm run smoke
```

## 5. Verification via OpenAI SDK / curl

```bash
curl http://localhost:3264/api/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.7-max",
    "messages": [
      {"role": "user", "content": "Answer in one sentence: what is a local endpoint?"}
    ],
    "stream": false
  }'
```

## 6. Hermes Agent Provider Example

```yaml
custom_providers:
  - name: qwen-free
    base_url: http://localhost:3264/api
    model: qwen3.7-max
    api_key: dummy-key
```

Launch:

```bash
hermes chat --provider custom:qwen-free --model qwen3.7-max
```

## 7. Claude Code via LiteLLM Bridge

Claude Code expects the Anthropic Messages API, while this proxy serves OpenAI Chat Completions. Use LiteLLM as a bridge:

```yaml
model_list:
  - model_name: qwen3.7-max
    litellm_params:
      model: openai/qwen3.7-max
      api_base: http://localhost:3264/api
      api_key: dummy-key

general_settings:
  master_key: ***
```

Start LiteLLM:

```bash
litellm --config qwen_litellm.yaml --host 127.0.0.1 --port 4000
```

Start Claude Code:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:4000"
export ANTHROPIC_AUTH_TOKEN="***"
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude --model qwen3.7-max
```

## Important Note

You can describe it like this:

> This is not a local model running on your GPU. It is a local OpenAI-compatible proxy to Qwen Chat — convenient for experimenting with AI agents and local tools.

Do not promise production stability: Qwen Chat rate limits, token lifetimes, account state, and API compatibility may change.
