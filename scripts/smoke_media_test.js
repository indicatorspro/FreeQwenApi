// Smoke test for image and video generation through the proxy.
//
// Checks that a live account can generate an image (t2i) and start a video
// task (t2v), reporting the resulting URLs or a clear failure. Media
// generation is slow, so this script is not part of the default `npm test`
// suite — run it against a running proxy:
//
//   npm run smoke:media
//
// Optional env vars:
//   QWEN_PROXY_BASE_URL    proxy base (default http://127.0.0.1:3264/api)
//   QWEN_PROXY_API_KEY     client API key
//   QWEN_SMOKE_IMAGE_PROMPT
//   QWEN_SMOKE_VIDEO_PROMPT

const BASE_URL = process.env.QWEN_PROXY_BASE_URL || 'http://127.0.0.1:3264/api';
const IMAGE_PROMPT = process.env.QWEN_SMOKE_IMAGE_PROMPT || 'A tiny red cube on a white table, studio lighting, minimal style';
const VIDEO_PROMPT = process.env.QWEN_SMOKE_VIDEO_PROMPT || 'A tiny red cube spinning slowly on a white table';

async function requestJson(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.QWEN_PROXY_API_KEY ? { Authorization: `Bearer ${process.env.QWEN_PROXY_API_KEY}` } : {}),
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path}: HTTP error ${response.status} ${text.slice(0, 500)}`);
  }

  return data;
}

/** True when the media status endpoint reports a usable image/video path. */
async function checkMediaAvailable() {
  const imageStatus = await requestJson('/images/status');
  if (imageStatus?.qwenChat?.available) return true;

  const videoStatus = await requestJson('/videos/status');
  if (videoStatus?.available) return true;

  const details = {
    image: imageStatus?.qwenChat?.message || 'unavailable',
    video: videoStatus?.message || 'unavailable',
    dashscope: imageStatus?.dashscope?.message || 'not configured'
  };
  console.warn(`Media availability check:\n${JSON.stringify(details, null, 2)}`);
  return false;
}

/** Polls a task status endpoint until it completes or the timeout elapses. */
async function waitForTask(taskId, timeoutMs = 5 * 60_000, intervalMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await requestJson(`/tasks/status/${encodeURIComponent(taskId)}?wait=true`);

    if (result?.data?.video_url) return result.data;
    if (result?.error && !result?.data) throw new Error(`Task ${taskId} failed: ${JSON.stringify(result)}`);

    if (Date.now() >= deadline) {
      throw new Error(`Task ${taskId} did not complete within ${timeoutMs} ms`);
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

async function checkImageGeneration() {
  console.log(`Image prompt: ${IMAGE_PROMPT}`);
  const result = await requestJson('/images/generations', {
    method: 'POST',
    body: JSON.stringify({ prompt: IMAGE_PROMPT })
  });

  const url = result?.data?.[0]?.url;
  if (!url) {
    throw new Error(`Image generation returned no URL: ${JSON.stringify(result).slice(0, 500)}`);
  }

  console.log(`Image generation OK: ${url}`);
}

async function checkVideoGeneration() {
  console.log(`Video prompt: ${VIDEO_PROMPT}`);
  const result = await requestJson('/videos/generations', {
    method: 'POST',
    body: JSON.stringify({ prompt: VIDEO_PROMPT, waitForCompletion: true })
  });

  if (result?.video_url) {
    console.log(`Video generation OK: ${result.video_url}`);
    return;
  }

  const taskId = result?.task_id;
  if (!taskId) {
    throw new Error(`Video generation returned neither URL nor task id: ${JSON.stringify(result).slice(0, 500)}`);
  }

  console.log(`Video task created: ${taskId} — polling…`);
  const data = await waitForTask(taskId);
  if (!data?.video_url) {
    throw new Error(`Video task ${taskId} completed without a URL: ${JSON.stringify(data).slice(0, 500)}`);
  }
  console.log(`Video generation OK: ${data.video_url}`);
}

async function main() {
  const status = await requestJson('/status');
  console.log(`Accounts in status: ${status.accounts?.length ?? 0}`);

  if (!(await checkMediaAvailable())) {
    console.warn('No media-capable backend detected — image/video may fail below.');
  }

  await checkImageGeneration();
  await checkVideoGeneration();

  console.log('Media smoke check OK');
}

main().catch(error => {
  console.error(`Media smoke check failed: ${error.message}`);
  process.exit(1);
});
