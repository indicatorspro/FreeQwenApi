# FreeQwenApi usage examples

This directory contains examples of using the API proxy for Qwen AI.

## Installation and startup

Dependencies are installed in the project root directory:

```bash
# In the project root directory
npm install
```

Before running the examples, make sure the FreeQwenApi server is running and available at `http://localhost:3264`.

```bash
# Start the server
npm start

# In a separate terminal, run the examples
npm run example:simple
npm run example:stream
# etc.
```

## Examples using the OpenAI SDK

### 1. Simple request (non-streaming)

```bash
npm run example:simple
```

Demonstrates sending a simple request to Qwen AI using the OpenAI SDK.

### 2. Streaming request

```bash
npm run example:stream
```

Shows how to receive a response in streaming mode, where tokens arrive as they are generated.

### 3. Request with a system message

```bash
npm run example:system
```

Example of using a system message to set the role and instructions for the model.

### 4. Image analysis

```bash
npm run example:image
```

Demonstrates sending an image for analysis by the model (you need to replace the image URL in the example).

### 5. Multi-message conversation

```bash
npm run example:conversation
```

Example of maintaining a multi-message conversation while preserving context.

### 6. OpenAI API compatibility

```bash
npm run example:compatibility
```

Demonstrates full compatibility with the OpenAI API format.

## Direct API usage examples

### 1. Request using fetch

```bash
npm run example:direct
```

Example of sending a direct request to the API without using an SDK, using native fetch.

### 2. Request using axios

```bash
npm run example:axios
```

Example of using the axios library to send requests to the API.

## Content generation tests

### Test all generation types

```bash
npm run test:features
```

Tests all three modes: text chat (t2t), image generation (t2i) and video generation (t2v).

### Comparison of video polling modes

```bash
npm run test:video-polling
```

Compares server-side polling (the server waits itself) and client-side polling (the client polls manually).

> Detailed documentation on image and video generation: [IMAGE_VIDEO_GENERATION_GUIDE.md](../IMAGE_VIDEO_GENERATION_GUIDE.md)

## Modifying examples

You can modify the examples for your needs:

1. Change requests and parameters in the example files
2. Try different models (the list is available via `/api/models`)
3. Experiment with different request formats

## Python examples

Python clients work with the same Node server: start the proxy
(`npm start`) and point `base_url` to `http://localhost:3264/api/v1`.

### Python OpenAI SDK examples

Install dependencies:
```bash
pip install openai
```

Run:
```bash
python examples/python-sdk/simple.py
python examples/python-sdk/streaming.py
python examples/python-sdk/system_message.py
python examples/python-sdk/image_analysis.py
python examples/python-sdk/conversation.py
python examples/python-sdk/openai_compatibility.py
```

### Python direct API examples (httpx)

Install dependencies:
```bash
pip install httpx
```

Run:
```bash
python examples/python-direct/httpx_example.py
python examples/python-direct/httpx_streaming.py
```

## Working with images

For image examples you need to:

1. Upload an image in the official Qwen web interface
2. Get the image URL from network requests (see the instruction in the main project README.md)
3. Replace `IMAGE_URL` in the example with the obtained URL

## Additional information

Detailed API documentation is available in the main project README.md.
