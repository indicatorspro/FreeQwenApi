# Архитектура

Три слоя, зависимости направлены только внутрь: `server → services → core`.
Ядро не знает ни про Express, ни про формат OpenAI, поэтому его можно
тестировать и переиспользовать из CLI или другого транспорта.

```text
index.js
└── src/server/start.js         запуск: меню, браузер, listen, graceful shutdown
    └── src/server/app.js       сборка Express-приложения
        ├── middleware/         авторизация, CORS, localOnly, обработка ошибок
        ├── openai.js           формат ответов: JSON и SSE
        └── routes/
            ├── completions.js  POST /api/(v1/)chat/completions
            ├── legacy.js       POST /api/chat, работа с чатами
            ├── media.js        изображения, видео, статусы задач
            ├── files.js        загрузка файлов
            ├── accounts.js     управление аккаунтами (только localhost)
            └── system.js       health, status, models, download

src/services/                   сценарии, общие для любого транспорта
├── completions.js              диалог + инструменты + ремонт вызовов
└── media.js                    генерация изображений и видео

src/core/                       домен, без знания о транспорте
├── qwen/                       клиент Qwen Chat
│   ├── client.js               sendMessage: аккаунт → чат → запрос → ретраи
│   ├── transport.js            node fetch + fetch в браузере, фолбэк при WAF
│   ├── sse.js                  разбор потока (один на оба пути)
│   ├── payload.js              тело запроса /api/v2/chat/completions
│   ├── chats.js, tasks.js      создание чатов, опрос долгих задач
│   ├── pagePool.js             пул вкладок браузера
│   ├── tokens.js, authState.js выбор аккаунта и текущий токен
│   ├── files.js                загрузка в OSS
│   └── media.js                поиск ссылок на медиа в ответах
├── tools/                      вызов инструментов
│   ├── registry.js             нормализация tools/functions, разрешение имён
│   ├── prompt.js               описание инструментов для модели
│   ├── parser.js               разбор ответа модели
│   ├── stream.js               фильтр потока
│   ├── validate.js             проверка и приведение аргументов
│   └── transcript.js           сворачивание истории с результатами
├── conversations/              связь id клиента ↔ чат Qwen
├── accounts/store.js           пул аккаунтов, ротация, лимиты
├── models/                     список моделей и алиасы
├── history/store.js            локальная копия истории
├── dashscope/images.js         генерация через официальный API
└── apiKeys.js                  ключи доступа к прокси

src/browser/                    Puppeteer: запуск, сессия, stealth, верификация
src/shared/                     логгер, ошибки, идентификаторы, пути
src/config/                     конфигурация с валидацией
src/cli/                        интерактивные сценарии консоли
```

## Два пути к Qwen

Запрос уходит либо напрямую из Node, либо через `fetch` внутри страницы
браузера. Второй путь несёт живую сессию и не получает капчу, но требует
открытого браузера.

```text
sendMessage
└── executeChatRequest
    ├── requestViaNode        быстрый; Aliyun WAF иногда подменяет ответ капчей
    └── requestViaBrowser     фолбэк: fetch в странице, строки SSE — в Node
                              через exposed-функцию (стриминг сохраняется)
```

Разбор потока общий для обоих путей (`core/qwen/sse.js`). Раньше он был
продублирован, и браузерная копия не умела отдавать чанки — при срабатывании
WAF стриминг превращался в долгую тишину.

## Жизненный цикл запроса с инструментами

```text
POST /api/v1/chat/completions
  ↓ routes/completions.js      разбор тела, ключ клиента, режим стрима
  ↓ services/completions.js
      registry     ← tools[] клиента
      resolver     ← chatId / conversation_id / сессия
      transcript   ← сворачивание истории, если есть результаты инструментов
      prompt       → системное сообщение с описанием инструментов
  ↓ core/qwen/client.js        аккаунт, чат, запрос, ретраи по 401/429
  ↓ core/tools/stream.js       фильтр: служебный JSON не уходит клиенту
  ↓ core/tools/parser.js       <tool_call> / фенс / {"tool_calls":…}
  ↓ core/tools/validate.js     имя из реестра, типы аргументов, обязательные поля
  ↓ (при неудаче) уточняющий запрос к модели, TOOL_CALL_MAX_REPAIRS раз
  ↑ server/openai.js           chat.completion или SSE с tool_calls
```

## Состояние процесса

| Что | Где | Зачем |
|---|---|---|
| Текущий токен Qwen | `core/qwen/authState.js` | один токен на создание чата и отправку |
| Пул вкладок | `core/qwen/pagePool.js` | переиспользование страниц браузера |
| Сессии диалогов | `core/conversations/store.js` | продолжение чата между запросами |
| Алиасы чатов | там же | внутренний `chat_…` ↔ реальный id Qwen |
| Аккаунты | `session/tokens.json` | пул, лимиты, статусы |

Пул аккаунтов ротируется по кругу. При 401 аккаунт помечается недействительным,
при 429 — блокируется на срок из ответа Qwen (или `QWEN_RATELIMIT_HOURS`), и
запрос повторяется с новым аккаунтом. `chatId` при смене аккаунта сбрасывается:
чат принадлежит прежнему токену и под новым не существует.
