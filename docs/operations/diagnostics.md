# Диагностические маршруты

Все диагностические ручки доступны только администраторам. Для доступа
используйте заголовок `x-admin-token` или параметр строки запроса
`token` с валидным админ-токеном.

## Порядок проверок после деплоя

1. `GET /admin/diag?q=telegram.getMe` — убеждаемся, что Bot API отвечает
   и токен не протух. В ответе возвращаются флаги `ok`, HTTP-статус
   Telegram и `description`; сам токен маскируется.
2. `GET /admin/selftest` — прогоняем end-to-end self-test: OpenAI, Telegram
   и D1/KV (по необходимости). Если не передавать `chatId`, воркер возьмёт
   первый ID из whitelist в `ADMIN_TG_IDS` и вернёт использованный ID в теле
   ответа.
3. `GET /admin/diag?q=bindings` — проверяем KV/D1 и убеждаемся, что
   обязательные секреты прокинуты (поле `secrets.*.present`).

## `GET /admin/selftest`

Прогоняет self-test и проверяет ключевые интеграции (OpenAI, Telegram,
хранилище). Ручка всегда отвечает `200 OK`, даже если проверки провалены —
состояние отражается в полях ответа.

### Поля ответа

- `openAiOk` — `true`, если OpenAI вернул диагностический маркер
  `[[tg-responcer:selftest:openai-ok]]` и ответ получен из `output_text`.
- `openAiReason` — код причины (`missing_diagnostic_marker`,
  `marker_in_fallback_output`, `request_failed`, `noop_adapter_response`).
- `openAiLatencyMs`, `openAiUsedOutputText`, `openAiSample`,
  `openAiResponseId` — телеметрия и сниппет ответа (маркер вырезается).
- `openAiEndpointId`, `openAiBaseUrl` — какая нода двухэндпоинтовой
  архитектуры OpenAI-адаптера отработала последней. Значения берутся из
  метаданных ответа: например, `endpoint_1` + `https://api.openai.com/v1/responses`
  для основного региона и другой base URL для бэкапа.
- `telegramOk` — `true`, если Bot API принял `sendTyping` и `sendMessage`.
- `telegramReason` — `chat_id_missing` (query-параметр не передан и
  whitelist пуст), либо `send_failed` (Bot API вернул ошибку).
- `telegramStatus`, `telegramDescription`, `telegramChatId`,
  `telegramChatIdSource` — подробности последнего вызова.
- `errors` — плоский массив ошибок (`openai: …`, `telegram: …`).
- `lastWebhookSnapshot` — снимок последнего вебхука/диагностик.

Для `q=utm` дополнительно возвращаются `test`, `ok`, `saveOk`, `readOk`,
`utmDegraded`; ручка также отвечает `200 OK` даже при деградации
(`ok:false`, `errors:[…]`).

### Логи Cloudflare

Self-test пишет два читаемых сообщения:

```
[admin:selftest][openai] {
  scope,
  check,
  ok,
  endpointId?,
  baseUrl?,
  reason?,
  responseId?,
  latencyMs?,
  sample?
}
[admin:selftest][telegram] {
  scope,
  check,
  ok,
  route,
  chatIdRawType,
  chatIdRawHash,
  chatIdNormalizedHash,
  status?,
  reason?
}
```

Второе сообщение дополнительно содержит `chatIdSource`, `description`,
`latencyMs` и совпадающие хэши `chatIdRawHash` / `chatIdNormalizedHash`,
чтобы легко отследить преобразования ID.

Первое сообщение теперь помогает операторам понимать, какой базовый URL
двухэндпоинтовой конфигурации OpenAI вернул ошибку или задержку: при
срабатывании failover в лог и тело ответа попадают `openAiEndpointId` и
`openAiBaseUrl`, поэтому сразу видно, что, например, упал `endpoint_1`
(`api.openai.com`) и воркер ушёл на бэкап в `endpoint_2`.

### Контроль целостности записи ответов

- При боевых проверках смотри хвост логов `DialogEngine`: `[dialog-engine][sendText][error]` должен сопровождаться подавлением
  сохранения `assistant`. Отсутствие записей без `messageId` при ошибках — критерий приёмки шага 3 дорожной карты (см.
  `memory-bank/logs/cloudflare-sendtext-failure-2025-11-16.log`). Снимок/ссылка добавляется в diagnostics при каждом негативном прогоне.

## `GET /admin/envz`

Выводит информацию о том, какие переменные окружения заданы и проходят
минимальные проверки формата.

## `GET /admin/diag`

Универсальная диагностическая ручка. Через параметр `q` выбирается тип
проверки. Поддерживаются варианты:

- `q=telegram.getMe` — выполняет запрос `getMe` к Bot API и возвращает
  `ok`, HTTP-статус, `description`, а также маскированный токен (`tokenMasked`).
- `q=bindings` — прогоняет тестовые запросы в D1 и KV. В ответе добавлено
  поле `secrets`, отражающее наличие обязательных секретов без раскрытия
  значений.
- `q=ai-queue` — показывает состояние очереди AI-лимитера. Ответ содержит
  сводку `{ status, active, queued, maxConcurrency, maxQueue, requestTimeoutMs,
  retryMax, droppedSinceBoot, avgWaitMs, lastDropAt }` и блоки `endpoints`
  (`activeBaseUrl`, `backupBaseUrls`, `failoverCounts`) и `sources`. В `sources`
  отображаются происхождение каждого лимита (`kv`/`env`/`default`), список
  активных `baseUrls`, `endpointFailoverThreshold` и указание на текущий
  `AI_CONTROL_KV`. Благодаря этому оператор сразу видит, какой base URL
  считается активным, какие бэкапы включены и почему (например, KV подменил
  дефолт). Это особенно важно для двухэндпоинтовой архитектуры OpenAI —
  если self-test упал, можно сопоставить `openAiBaseUrl`/`openAiEndpointId`
  с состоянием очереди и понять, какая нода деградирует.

## `GET /admin/known-users/clear`

Сбрасывает in-memory кэш UTM-источников известных пользователей.
Возвращает JSON-ответ `{ "ok": true, "cleared": <количество записей> }`,
где `cleared` — число удалённых записей.

## `POST /admin/d1-stress`

Нагрузочный прогон D1 выполняется только при включённом флаге `STRESS_TEST_ENABLED`.
По умолчанию флаг выключен, поэтому ручка отвечает `404 Not Found` и ничего не
запускает. Для запуска задайте `STRESS_TEST_ENABLED=1` (через Secrets/Vars) и
обновите воркер.

Запрос требует валидного `x-admin-token` и всегда возвращает JSON со сводкой.
Параметры запроса:

- `durationSec` — длительность прогона в секундах (по умолчанию 120, максимум 300).
- `concurrency` — `auto` (по умолчанию, адаптивно 8–32 потоков) или конкретное
  число потоков (1–32).

Во время прогона выполняются только операции `saveUser` и `appendMessage` над
тестовыми пользователями, все записи помечаются `metadata.stress=true` и
`metadata.runId=<uuid>`.

### Логи Cloudflare

Фильтруйте по ключам `$metadata.message`:

- `[d1-stress][start] runId=<uuid> durationSec=<int> concurrency=<int>`
- `[d1-stress][retry] op=<op> attempt=<n> error=<class|code>`
- `[d1-stress][success_after_retry] op=<op> attempts=<n>`
- `[d1-stress][max_retries_exceeded] op=<op> attempts=<n> error=<class|code>`
- `[d1-stress][non_retryable] op=<op> error=<class|code>`
- `[d1-stress][done] runId=<uuid> totals={<json>}`

Ответ ручки содержит распределение попыток (`attemptsDistribution`) и агрегаты,
поэтому можно сверять числа с логами.
