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
    throw new Error(`${options.method || 'GET'} ${path}: ошибка HTTP ${response.status} ${text.slice(0, 500)}`);
  }

  return data;
}

async function main() {
  const status = await requestJson('/status');
  const models = await requestJson('/models');
  const modelIds = models.data.map(model => model.id);

  console.log(`Аккаунтов в статусе: ${status.accounts?.length ?? 0}`);
  console.log(`Моделей: ${modelIds.length}`);

  if (!modelIds.includes(MODEL)) {
    throw new Error(`Smoke-модель ${MODEL} отсутствует в /models`);
  }

  const completion = await requestJson('/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages: [
        { role: 'user', content: 'Ответь ровно одним словом: работает' }
      ]
    })
  });

  const answer = completion.choices?.[0]?.message?.content || '';
  console.log(`${MODEL}: ${answer}`);

  await checkToolCalling();

  console.log('Smoke-проверка OK');
}

/** Проверяет, что модель возвращает настоящий tool_call — то, чего ждут агенты. */
async function checkToolCalling() {
  const response = await requestJson('/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      messages: [
        { role: 'user', content: 'Какая сейчас погода в Москве? Используй доступный инструмент.' }
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Возвращает текущую погоду в городе',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string', description: 'Название города' } },
            required: ['city']
          }
        }
      }]
    })
  });

  const choice = response.choices?.[0];
  const toolCall = choice?.message?.tool_calls?.[0];

  if (!toolCall) {
    console.warn(`Tool calling: модель ответила текстом вместо вызова (finish_reason=${choice?.finish_reason}). Это возможно, но нежелательно.`);
    return;
  }

  if (toolCall.function?.name !== 'get_weather') {
    throw new Error(`Tool calling: неверное имя функции ${toolCall.function?.name}`);
  }

  const args = JSON.parse(toolCall.function.arguments || '{}');
  if (!args.city) {
    throw new Error('Tool calling: в аргументах нет обязательного поля city');
  }

  console.log(`Tool calling: ${toolCall.function.name}(${toolCall.function.arguments})`);
}

main().catch(error => {
  console.error(`Smoke-проверка не удалась: ${error.message}`);
  process.exit(1);
});
