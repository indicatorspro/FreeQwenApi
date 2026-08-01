# Image Generation Setup

## Obtaining a DashScope API Key

1. Register on the Alibaba Cloud DashScope platform:
   - International: https://dashscope.console.aliyun.com/
   - China: https://dashscope.console.aliyun.com/

2. Create an API key in the "API Keys" section

3. Set the environment variable:

### Windows (cmd):
```cmd
setx DASHSCOPE_API_KEY "your_api_key"
```

### Windows (PowerShell):
```powershell
[System.Environment]::SetEnvironmentVariable('DASHSCOPE_API_KEY', 'your_api_key', 'User')
```

### Linux/Mac:
```bash
export DASHSCOPE_API_KEY="your_api_key"
```

### In Docker Compose:
Add to `docker-compose.yml`:
```yaml
environment:
  - DASHSCOPE_API_KEY=your_api_key
```

## Available Models

| Model | Description |
|-------|-------------|
| `qwen-image-max` | Flagship model for complex scenes with text |
| `qwen-image-plus` | Versatile model (default) |
| `qwen-image` | Basic model |
| `wan2.6-t2i` | Realistic scenes and photography |
| `wan2.5-t2i-preview` | Fast realistic image generation |
| `wan2.2-t2i-flash` | Fastest model with custom resolution |

## Usage Examples

### Via cURL:
```bash
curl -X POST http://localhost:3264/api/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Beautiful sunset over the mountains in anime style",
    "model": "qwen-image-plus",
    "n": 1,
    "size": "1024x1024"
  }'
```

### Via OpenAI SDK:
```javascript
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://localhost:3264/api',
  apiKey: 'dummy-key'
});

const response = await openai.images.generate({
  model: 'qwen-image-plus',
  prompt: 'Space station orbiting Mars',
  n: 1,
  size: '1024x1024'
});

console.log(response.data[0].url);
```

### Via Open WebUI:
1. Open Open WebUI settings
2. Go to the "Images" section
3. Enable image generation
4. Specify:
   - Base URL: `http://localhost:3264/api`
   - API Key: any value (if authorization is disabled)
   - Model: `qwen-image-plus`

## Checking API Status

```bash
curl http://localhost:3264/api/images/status
```

Response:
```json
{
  "available": true,
  "apiKeyConfigured": true,
  "message": "Image generation API is available"
}
```

## Getting the Model List

```bash
curl http://localhost:3264/api/images/models
```

## Supported Sizes

- `512x512`
- `768x768`
- `960x960`
- `1024x1024` (default)
- `1024x1792` (portrait)
- `1792x1024` (landscape)

## Notes

- Wan models (`wan2.*`) use asynchronous mode only with status polling
- Qwen Image models support both synchronous and asynchronous modes
- Maximum generations per request: 4
- Generation time: typically 5–30 seconds depending on model and size
