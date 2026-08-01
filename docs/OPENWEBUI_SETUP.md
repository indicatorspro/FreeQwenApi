# Setting Up Open WebUI with FreeQwenApi

## 1. Connecting to the API

### Step 1: Administration
1. Open Open WebUI
2. Log in as an administrator
3. Go to **Settings** → **Connections**

### Step 2: Adding the API Endpoint
- **Base URL**: `http://host.docker.internal:3264/api` (for Docker)
  - Or: `http://localhost:3264/api` (for local runs)
- **API Key**: any value (if the `Authorization.txt` file is empty)

## 2. Configuring Image Generation

### Step 1: Enable Generation
1. Go to **Settings** → **Images**
2. Enable **Enable Image Generation**

### Step 2: Configure Parameters
- **Engine**: OpenAI Compatible
- **Base URL**: `http://host.docker.internal:3264/api`
- **API Key**: any value (if authorization is disabled)
- **Model**: `qwen-image-plus`

### Step 3: Test Connection
Click **Test Connection** — it should show success.

## 3. Using Image Generation

### In Chat:
1. Open any chat
2. Click the 🎨 icon (Image Generation)
3. Enter a prompt: *"Space station orbiting Mars, realistic"*
4. Click **Generate**

### Via Command:
```
/imagine cyberpunk-style spaceship
```

## 4. Available Chat Models

The following models will be available in Open WebUI:

### Qwen 3.5 (new):
- `qwen3.5-plus` — Flagship model
- `qwen3.5-flash` — Fast lightweight
- `qwen3.5-397b-a17b` — Largest MoE
- `qwen3.5-122b-a10b` — Mid-size MoE
- `qwen3.5-27b` — 27B parameters
- `qwen3.5-35b-a3b` — 35B MoE

### Qwen 3:
- `qwen3-max` — Flagship
- `qwen3-plus` — Mid-range
- `qwen3-235b-a22b` — 235B parameters
- `qwen3-30b-a3b` — 30B MoE

### Coder:
- `qwen3-coder-plus` — For programming
- `qwen2.5-coder-32b-instruct` — 32B for code

### Vision:
- `qwen3-vl-plus` — For image analysis
- `qvq-72b-preview-0310` — Visual understanding

## 5. Docker Configuration

If Open WebUI runs in Docker, use:

```yaml
# docker-compose.yml for Open WebUI
services:
  open-webui:
    image: ghcr.io/open-webui/open-webui:main
    ports:
      - "3000:8080"
    environment:
      - OPENAI_API_BASE_URLS=http://host.docker.internal:3264/api
      - OPENAI_API_KEYS=dummy-key
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

## 6. Verifying Operation

### Chat Test:
```
1. Select model: qwen3.5-flash
2. Message: "Hello! Tell me about yourself"
3. You should receive a response from Qwen
```

### Image Generation Test:
```
1. Go to the Images section
2. Prompt: "Beautiful sunset over the mountains"
3. Model: qwen-image-plus
4. Click Generate
5. An image should be generated
```

## 7. Troubleshooting

### "Connection refused"
- Make sure FreeQwenApi is running
- Check the port (default 3264)

### "API key required"
- Add any API key in Open WebUI settings
- Or leave the `Authorization.txt` file empty

### "Model not found"
- Refresh the model list in Open WebUI
- Verify the model exists in `AvaibleModels.txt`

### Image generation not working
- Check: `GET http://localhost:3264/api/images/status`
- Set `DASHSCOPE_API_KEY` if not already set

## 8. Open WebUI Commands

| Command | Description |
|---------|-------------|
| `/imagine <prompt>` | Generate an image |
| `/model <name>` | Select a model |
| `/chat` | New chat |
| `/settings` | Settings |
