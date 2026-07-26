# Tool calling: подключение агентов (Codex, Claude Code, OpenCode)

FreeQwenApi принимает поле `tools` запроса OpenAI и возвращает нормальные
`tool_calls`. Это то, что нужно кодинг-агентам: свои встроенные инструменты и
инструменты подключённых MCP-серверов они передают именно так.

```text
Агент ──tools[]──▶ FreeQwenApi ──промпт──▶ Qwen Chat
Агент ◀─tool_calls── FreeQwenApi ◀─<tool_call>── Qwen Chat
```

## Как это устроено

Веб-API Qwen Chat не принимает JSON Schema инструментов — там нет поля `tools`.
Поэтому прокси описывает инструменты в системном сообщении, используя штатный
формат Qwen (`<tools>` + `<tool_call>`), а ответ модели разбирает обратно в
структуру OpenAI.

| Шаг | Что делает прокси |
|---|---|
| Приём | нормализует `tools` и устаревшие `functions`, снимает дубли |
| Промпт | описывает инструменты в нативном для Qwen формате, учитывает `tool_choice` |
| Ответ | разбирает `<tool_call>`, markdown-фенсы, `{"tool_calls":[…]}`, голый объект |
| Ремонт | чинит битый JSON, переспрашивает при неизвестном имени/аргументах |
| Проверка | приводит аргументы к типам JSON Schema, проверяет обязательные поля |
| Стриминг | придерживает служебный JSON, отдаёт `tool_calls` дельтами |

### Имена с префиксом MCP

Claude Code и другие клиенты передают инструменты MCP как
`mcp__github__create_pull_request`. Модель часто отвечает коротким именем
(`create_pull_request`). Прокси восстанавливает полное имя — клиент получает
ровно то, что объявлял. Если короткое имя неоднозначно (два MCP-сервера отдали
одинаковый `search`), прокси не угадывает и запрашивает уточнение у модели.

### Много инструментов

Агенты присылают десятки инструментов. Блок описания ограничен бюджетом
(`TOOL_PROMPT_MAX_CHARS`, по умолчанию 24000 символов) и при переполнении
сжимается ступенчато: сначала описания, затем вложенность схем, затем формат
сигнатур. Имена инструментов урезаются в последнюю очередь — инструмент,
которого нет в промпте, для модели не существует.

### Результаты инструментов

Ход, в котором агент присылает `role: "tool"`, нельзя продолжить в серверной
истории Qwen — там нет такой роли. Такой запрос сворачивается в одно сообщение
в нотации `<tool_call>` / `<tool_response>`; длинные результаты обрезаются
(`TOOL_RESULT_MAX_CHARS`).

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `TOOL_PROMPT_MAX_CHARS` | `24000` | бюджет символов на описание инструментов |
| `TOOL_CALL_MAX_REPAIRS` | `1` | уточняющих запросов при некорректном вызове |
| `TOOL_RESULT_MAX_CHARS` | `8000` | обрезка результата инструмента в истории |
| `TOOL_COERCE_ARGUMENTS` | `true` | приведение аргументов к типам схемы |

## Настройка агентов

Во всех примерах прокси запущен локально: `http://127.0.0.1:3264/api/v1`.
Если в `src/Authorization.txt` заданы ключи, подставьте свой в поле API-ключа;
если файл пуст, авторизация выключена и подойдёт любая строка.

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
export FREEQWEN_API_KEY=dummy   # либо ключ из src/Authorization.txt
codex
```

`wire_api = "chat"` обязателен: прокси реализует Chat Completions, а не
Responses API.

### OpenCode

`opencode.json` в корне проекта или `~/.config/opencode/opencode.json`:

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

Claude Code говорит в формате Anthropic Messages API, а прокси — в формате
OpenAI. Нужен мост, например LiteLLM:

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

LiteLLM отдаёт Anthropic-совместимый `/v1/messages` и сам переводит вызовы
инструментов между форматами. Альтернатива — `claude-code-router` с тем же
`base_url`.

### Прочие клиенты

| Клиент | Что указать |
|---|---|
| OpenAI SDK (Python/JS) | `base_url="http://127.0.0.1:3264/api/v1"` |
| Cline / Roo Code | провайдер «OpenAI Compatible», тот же base URL |
| Continue | `provider: openai`, `apiBase` тот же |
| Aider | `--openai-api-base http://127.0.0.1:3264/api/v1` |
| Open WebUI | см. [OPENWEBUI_SETUP.md](OPENWEBUI_SETUP.md) |

## Проверка

```bash
curl -s http://127.0.0.1:3264/api/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "qwen3.7-max",
    "messages": [{"role": "user", "content": "Прочитай файл src/index.js"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "Читает файл проекта",
        "parameters": {
          "type": "object",
          "properties": {"path": {"type": "string"}},
          "required": ["path"]
        }
      }
    }]
  }' | jq '.choices[0]'
```

Ожидаемый ответ:

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

## Ограничения

- Инструменты не-функционального типа (`web_search`, `code_interpreter` и
  подобные серверные) прокси выполнить не может и молча пропускает.
- Параллельные вызовы поддерживаются, но качество зависит от модели: `qwen3.7-max`
  и `qwen3-coder-plus` держат дисциплину заметно лучше мелких моделей.
- Строгая схема (`strict: true`) принимается, но гарантируется не форматом
  ответа модели, а проверкой на стороне прокси.
- Аргументы приводятся к типам схемы; при нехватке обязательных полей прокси
  переспрашивает модель, а не отдаёт клиенту заведомо нерабочий вызов.
