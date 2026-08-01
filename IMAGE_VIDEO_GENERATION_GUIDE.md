# Image and Video Generation Guide

## Overview

Qwen API Proxy supports three types of content generation via the `chatType` parameter:

- **Text chat (t2t)** — standard conversational AI, streaming response (default)
- **Image generation (t2i)** — text-to-image, streaming response (~10–30 sec.)
- **Video generation (t2v)** — text-to-video, task system with polling (~30–120 sec.)

## Key Differences

| Feature | Text (t2t) | Image (t2i) | Video (t2v) |
| -------------------- | ------------------- | ---------------------------- | ------------------------------- |
| **Request type** | `stream: true` | `stream: true` | `stream: false` |
| **Response method** | Streaming SSE | Streaming SSE | Task polling |
| **Execution time** | ~2–5 sec. | ~10–30 sec. | ~30–120 sec. |
| **Where the URL is** | N/A (text) | `choices[0].message.content` | `video_url` / `content` |
| **Server-side polling** | No | No | Yes (automatic) |
| **Task ID** | No | No | Yes |

---

## Image Generation (t2i)

### How It Works

1. Client sends a POST request with `chatType: "t2i"`
2. Server creates a chat with `stream: true`
3. Server receives a streaming SSE response with the image URL
4. The image URL arrives in the `content` field of stream chunks
5. Server returns the final URL to the client

### Request Format

```
POST /api/chat
Content-Type: application/json

{
  "message": "Description of the image to generate",
  "model": "qwen3-vl-plus",
  "chatType": "t2i",
  "size": "16:9"
}
```

### Parameters

| Parameter | Required | Description | Example Values |
| ---------- | -------- | ---------------------------------------- | --------------------------------------------- |
| `message` | Yes | Text description of the image | `"Sunset over the ocean with purple clouds"` |
| `model` | No | Model for generation (default qwen-max-latest) | `qwen-max-latest`, `qwen3-vl-plus` |
| `chatType` | Yes | Must be `"t2i"` | `"t2i"` |
| `size` | No | Aspect ratio | `"16:9"`, `"9:16"`, `"1:1"`, `"4:3"` |
| `chatId` | No | ID of an existing chat to continue context | UUID from a previous response |
| `parentId` | No | ID of the parent message | UUID from a previous response |

### Expected Response

```json
{
  "id": "response-uuid-here",
  "object": "chat.completion",
  "created": 1771318618,
  "model": "qwen3-vl-plus",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "https://cdn.qwenlm.ai/output/.../t2i/.../image.png?key=***"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "characters": 0,
    "width": 2688,
    "image_count": 1,
    "height": 1536
  },
  "response_id": "response-uuid-here",
  "chatId": "chat-uuid-here",
  "parentId": "parent-uuid-here"
}
```

The `content` field contains a direct URL to the generated image. These URLs are typically hosted on `cdn.qwenlm.ai`.

### Examples

**JavaScript (fetch):**

```javascript
const response = await fetch("http://localhost:3264/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    message: "Beautiful landscape: mountains and a lake at dawn",
    model: "qwen3-vl-plus",
    chatType: "t2i",
    size: "16:9"
  }),
});

const data = await response.json();
const imageUrl = data.choices[0].message.content;
console.log("Generated image:", imageUrl);
```

**cURL:**

```bash
curl -X POST http://localhost:3264/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Futuristic city at night with neon lights",
    "model": "qwen3-vl-plus",
    "chatType": "t2i",
    "size": "16:9"
  }'
```

**PowerShell:**

```powershell
$body = @{
    message = "Cute cat sitting on a bookshelf"
    model = "qwen3-vl-plus"
    chatType = "t2i"
    size = "1:1"
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "http://localhost:3264/api/chat" `
    -Method Post -Body $body -ContentType "application/json"

$imageUrl = $response.choices[0].message.content
Write-Host "Image URL: $imageUrl"
```

---

## Video Generation (t2v)

### How It Works

Video generation supports two polling modes:

#### Mode 1: Server-Side Polling (Default)

Best for simple integrations and short videos (<2 min.).

1. Client sends a request with `chatType: "t2v"` and `waitForCompletion: true` (default)
2. Server creates a task — Qwen API returns a `task_id`
3. Server automatically checks status every 2 seconds (up to 90 attempts = 3 min.)
4. When the task completes, the server returns the video URL to the client

**Pros:** simple, single request, no client-side polling logic needed.
**Cons:** long HTTP connection, fixed 3-minute timeout.

#### Mode 2: Client-Side Polling (Manual)

Best for long videos (>2 min.), custom timeouts, and progress display in UI.

1. Client sends a request with `chatType: "t2v"` and `waitForCompletion: false`
2. Server immediately returns `task_id` (~1–2 sec.)
3. Client checks `GET /api/tasks/status/:taskId` every 2–5 seconds
4. When the task completes, the client receives the video URL

**Pros:** flexible timeout, progress tracking, better for long operations.
**Cons:** requires client-side polling logic.

### Request Format

```
POST /api/chat
Content-Type: application/json

{
  "message": "Description of the video to generate",
  "model": "qwen3-vl-plus",
  "chatType": "t2v",
  "size": "16:9"
}
```

### Parameters

| Parameter | Required | Description | Example Values |
| ------------------- | -------- | ----------------------------------------------------- | --------------------------------------------- |
| `message` | Yes | Text description of the video | `"Ocean waves on a sandy beach at sunset"` |
| `model` | Yes | Model for generation | `qwen3-vl-plus`, `qwen-max-latest` |
| `chatType` | Yes | Must be `"t2v"` | `"t2v"` |
| `size` | No | Aspect ratio (default `"16:9"`) | `"16:9"`, `"9:16"`, `"1:1"`, `"4:3"` |
| `waitForCompletion` | No | Server waits for task completion (default `true`) | `true` / `false` |
| `chatId` | No | ID of an existing chat | UUID from a previous response |
| `parentId` | No | ID of the parent message | UUID from a previous response |

**Important:** video size is specified as an aspect ratio (e.g., `"16:9"`), not as pixel resolution.

### Expected Response

```json
{
  "id": "task-uuid-here",
  "object": "chat.completion",
  "created": 1771318618,
  "model": "qwen3-vl-plus",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "https://cdn.qwenlm.ai/output/.../t2v/.../video.mp4?key=***"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "output_tokens": 0,
    "total_tokens": 0
  },
  "task_id": "task-uuid-here",
  "video_url": "https://cdn.qwenlm.ai/output/.../t2v/.../video.mp4?key=***",
  "chatId": "chat-uuid-here",
  "parentId": "task-uuid-here"
}
```

### Examples

**Server-Side Polling (Default):**

```javascript
const response = await fetch("http://localhost:3264/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    message: "Calm ocean with gentle waves at sunset",
    model: "qwen3-vl-plus",
    chatType: "t2v",
    size: "16:9"
  }),
});

const data = await response.json();
if (data.error) {
  console.error("Failed to generate video:", data.error);
} else {
  const videoUrl = data.video_url || data.choices[0].message.content;
  console.log("Generated video:", videoUrl);
}
```

**Client-Side Polling:**

```javascript
// Step 1: create the task (response arrives immediately)
const taskResponse = await fetch("http://localhost:3264/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    message: "Quiet forest, sunbeams passing through the trees",
    model: "qwen3-vl-plus",
    chatType: "t2v",
    size: "16:9",
    waitForCompletion: false
  }),
});

const taskData = await taskResponse.json();
console.log("Task created:", taskData.task_id);

// Step 2: poll status until completion
const taskId = taskData.task_id;
let videoUrl = null;
let attempts = 0;
const maxAttempts = 90; // maximum 3 minutes

while (attempts < maxAttempts && !videoUrl) {
  attempts++;
  await new Promise(resolve => setTimeout(resolve, 2000));

  const statusResponse = await fetch(`http://localhost:3264/api/tasks/status/${taskId}`);
  const statusData = await statusResponse.json();
  const status = statusData.task_status || statusData.status;

  console.log(`Attempt ${attempts}: ${status}`);

  if (status === 'completed' || status === 'succeeded') {
    videoUrl = statusData.content || statusData.data?.content;
    console.log("Video ready:", videoUrl);
  } else if (status === 'failed' || status === 'error') {
    console.error("Task ended with an error");
    break;
  }
}
```

**cURL (Server-Side Polling):**

```bash
curl -X POST http://localhost:3264/api/chat \
  --max-time 200 \
  -H "Content-Type: application/json" \
  -d '{
    "message": "A bird flying over the forest",
    "model": "qwen3-vl-plus",
    "chatType": "t2v",
    "size": "16:9"
  }'
```

**cURL (Client-Side Polling):**

```bash
# Step 1: create the task
TASK_ID=$(curl -s -X POST http://localhost:3264/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Ocean waves at sunset",
    "model": "qwen3-vl-plus",
    "chatType": "t2v",
    "size": "16:9",
    "waitForCompletion": false
  }' | jq -r '.task_id')

echo "Task ID: $TASK_ID"

# Step 2: poll status
while true; do
  STATUS=$(curl -s "http://localhost:3264/api/tasks/status/$TASK_ID" | jq -r '.task_status')
  echo "Status: $STATUS"
  [ "$STATUS" = "completed" ] && break
  sleep 2
done
```

---

## Comparison: Images vs. Video

| Feature | Image (t2i) | Video (t2v) |
| ------------------- | ---------------------------- | ----------------------------------- |
| **Chat type** | `"t2i"` | `"t2v"` |
| **Response method** | Streaming | Task polling |
| **Typical duration** | 10–30 seconds | 30–120 seconds |
| **Response field** | `choices[0].message.content` | `video_url` or `content` |
| **File format** | `.jpg` / `.png` | `.mp4` |
| **Stream** | `true` (automatic) | `false` (automatic) |
| **Polling** | N/A | 90 attempts × 2 sec. = max 3 min. |
| **Client timeout** | 30–60 seconds | 120–200 seconds |

---

## Recommendations

### Image Generation

1. **Detailed prompts** — specify style, colors, mood, and composition
2. **Recommended models** — `qwen3-vl-plus` (fast, good quality), `qwen-max-latest`
3. **Aspect ratios** — `"1:1"`, `"16:9"`, `"9:16"`, `"4:3"`, `"3:4"`
4. **Client timeout** — at least 60 seconds

### Video Generation

1. **Describe motion** — write about movement and changes, not just a static scene
2. **Keep it simple** — focus on one main action/movement
3. **Aspect ratios** — `"16:9"` (default), `"9:16"`, `"1:1"`, `"4:3"`
4. **Client timeout** — at least 200 seconds
5. **Be patient** — generation typically takes 1–2 minutes

---

## Error Handling

### Timeout

```json
{ "error": "Task polling timeout exceeded", "status": "timeout", "task_id": "..." }
```

Retry the request or switch to client-side polling with a higher attempt count.

### Task ID Not Found

```json
{ "error": "Task ID not found in response" }
```

Check the Qwen API status — this may be a temporary issue.

### Rate Limit

```json
{ "error": "RateLimited", "detail": "You've reached the upper limit for today's usage." }
```

Wait for the daily limit to reset or add more accounts.

---

## Testing

Run the built-in test scripts:

```bash
# Test all three generation types (chat, image, video)
npm run test:features

# Compare server-side and client-side polling for video
npm run test:video-polling
```

---

## Notes

1. Generated URLs are temporary — download files if you need them long-term
2. Higher resolutions take longer to generate
3. Multiple parallel requests work through the multi-account system
4. Use `chatId` and `parentId` to generate related images/videos in context

## Related Endpoints

- `POST /api/chat` — text chat (`chatType: "t2t"`, default), image (`"t2i"`), video (`"t2v"`)
- `GET /api/tasks/status/:taskId` — check video generation task status
- `GET /api/models` — get the list of available models
- `POST /api/files/upload` — upload files for analysis
