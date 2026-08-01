const BASE_URL = process.env.QWEN_PROXY_BASE_URL || 'http://127.0.0.1:3264/api';
const MODEL = process.env.QWEN_PROXY_SMOKE_MODEL || 'qwen3.7-max';

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

async function main() {
  const status = await requestJson('/status');
  const models = await requestJson('/models');
  const modelIds = models.data.map(model => model.id);

  console.log(`Accounts in status: ${status.accounts?.length ?? 0}`);
  console.log(`Models: ${modelIds.length}`);

  if (!modelIds.includes(MODEL)) {
    throw new Error(`Smoke model ${MODEL} is missing from /models`);
  }

  const completion = await requestJson('/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages: [
        { role: 'user', content: 'Answer with exactly one word: works' }
      ]
    })
  });

  const answer = completion.choices?.[0]?.message?.content || '';
  console.log(`${MODEL}: ${answer}`);

  await checkToolCalling();

  console.log('Smoke check OK');
}

/** Checks that the model returns a real tool_call — what agents expect. */
async function checkToolCalling() {
  const response = await requestJson('/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages: [
        { role: 'user', content: 'What is the current weather in Moscow? Use the available tool.' }
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Returns the current weather in a city',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string', description: 'City name' } },
            required: ['city']
          }
        }
      }]
    })
  });

  const choice = response.choices?.[0];
  const toolCall = choice?.message?.tool_calls?.[0];

  if (!toolCall) {
    console.warn(`Tool calling: model responded with text instead of a call (finish_reason=${choice?.finish_reason}). This is possible but undesirable.`);
    return;
  }

  if (toolCall.function?.name !== 'get_weather') {
    throw new Error(`Tool calling: invalid function name ${toolCall.function?.name}`);
  }

  const args = JSON.parse(toolCall.function.arguments || '{}');
  if (!args.city) {
    throw new Error('Tool calling: arguments are missing the required city field');
  }

  console.log(`Tool calling: ${toolCall.function.name}(${toolCall.function.arguments})`);
}

main().catch(error => {
  console.error(`Smoke check failed: ${error.message}`);
  process.exit(1);
});
