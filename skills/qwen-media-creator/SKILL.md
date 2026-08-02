---
name: qwen-media-creator
description: >-
  Generate images and videos using the Qwen Media Creator MCP tools.
  Use when the user asks to create, generate, or produce an image, picture,
  photo, illustration, video, clip, or animation from a text prompt. Triggers
  on requests like "generate an image of...", "create a video of...",
  "make me a picture of...", "draw...", "render...", "create a photo of...".
  Do NOT use for text chat, code generation, or analysis tasks.
---

# Qwen Media Creator

Use the MCP tools `generate_image` and `generate_video` to create media from text prompts.

## Tools

- **generate_image** — returns an image URL. Fast (10–40s).
- **generate_video** — returns a video URL. Slow (30s–3min), polls internally.

Both accept:
- `prompt` (required) — text description.
- `size` (optional) — `16:9`, `9:16`, `1:1`; image also supports `4:3`.
- `model` (optional) — generation model. Default: `qwen3-vl-plus`.
- `save_dir` (optional) — directory to save the file locally. Default: `C:\VAULT-AI\CUEN\generated` (or `FREEQWEN_MEDIA_DIR` env var).
- `filename` (optional) — custom filename without extension. Default: auto-generated timestamp name.

## MANDATORY: Always Pass `save_dir`

You MUST always pass the `save_dir` parameter when calling `generate_image` or `generate_video` to ensure files are saved in the current conversation's working directory, not in a shared global location.

**How to determine `save_dir`:**
1. Use the working directory of the current conversation (the directory the agent is operating in). This is typically shown in the system prompt as "Working directory".
2. If a temporary directory was created for this conversation, use it.
3. If no specific directory is available, fall back to `C:\VAULT-AI\CUEN\generated`.

**Example:**
```json
{
  "prompt": "A sunset over the ocean",
  "save_dir": "C:\\Users\\user\\AppData\\Roaming\\AionUi\\aionui\\conversations\\users\\system_default_user\\2026\\08\\01\\aionrs-temp-888ea523"
}
```

This ensures each conversation's generated files are isolated and automatically cleaned up when the conversation is deleted.

## Image Models

| Model | Best for | Speed |
|---|---|---|
| `qwen-image-max` | Complex scenes, text in images, high fidelity | Slow |
| `qwen-image-plus` | General purpose, versatile (good default) | Medium |
| `qwen-image` | Simple images, quick drafts | Fast |
| `wan2.6-t2i` | Realistic photography, natural scenes | Medium |
| `wan2.5-t2i-preview` | Fast realistic generation | Fast |
| `wan2.2-t2i-flash` | Fastest generation, custom resolutions | Fastest |

## Video Models

| Model | Best for | Speed |
|---|---|---|
| `wan2.6-t2v` | High quality video, complex motion | Slow |
| `wan2.5-t2v-preview` | Balanced quality and speed | Medium |
| `wan2.2-t2v-flash` | Quick video drafts | Fast |

## Model Selection Guide

- If the user does not specify a model, use the default (`qwen3-vl-plus`).
- If the user asks for "realistic" or "photo-like" images, prefer `wan2.6-t2i`.
- If the user needs text rendered inside the image, use `qwen-image-max`.
- If the user wants speed or says "quick"/"fast", use `wan2.2-t2i-flash` (image) or `wan2.2-t2v-flash` (video).
- If the user names a specific model, use it exactly as requested.
- The model parameter is independent of the conversation model — changing it does not affect the chat LLM.

## Guidelines

1. Enhance sparse prompts with style/detail keywords (e.g., "cinematic lighting, high detail, 4K") while preserving the user's original intent.
2. Inform the user that URLs are temporary CDN links — they should download if they need to keep the file.
3. If a tool returns an error mentioning "proxy" or "connection refused", tell the user the FreeQwenApi server needs to be running (`cd C:\vault-ai\cuen\FreeQwenApi && node index.js`).
4. For video, warn the user it may take up to 3 minutes before showing progress.

## CRITICAL: Response Format

After receiving the tool result, you MUST present it to the user using the following format:

### For Images

**You MUST include the image inline using markdown:**

```
![Generated image](URL_FROM_TOOL_RESULT)
```

**Example response:**

```
Image generated with qwen-image-max:

![Generated image](https://cdn.qwenlm.ai/output/.../image.png?key=...)

⚠️ This is a temporary CDN link — download it if you need to keep it.
```

**DO NOT** just say "Image generated" or describe the image without including the markdown.

### For Videos

**Include as a clickable link:**

```
[Generated video](URL_FROM_TOOL_RESULT)
```

**Example response:**

```
Video generated with wan2.6-t2v:

[Generated video](https://cdn.qwenlm.ai/output/.../video.mp4?key=...)

⚠️ This is a temporary CDN link — download it if you need to keep it. Generation took ~45 seconds.
```

**IMPORTANT:** The user asked for visual content. Your response MUST include the markdown image or video link so they can see the result. Never return just a description or confirmation without the actual media reference.
