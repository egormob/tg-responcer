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
[admin:selftest][openai] { scope, check, ok, reason?, responseId?, latencyMs? }
[admin:selftest][telegram] { scope, check, ok, route, chatIdRawType, chatIdRawHash, chatIdNormalizedHash, status?, reason? }
```

Второе сообщение дополнительно содержит `chatIdSource`, `description`,
`latencyMs` и совпадающие хэши `chatIdRawHash` / `chatIdNormalizedHash`,
чтобы легко отследить преобразования ID.

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

## `GET /admin/known-users/clear`

Сбрасывает in-memory кэш UTM-источников известных пользователей.
Возвращает JSON-ответ `{ "ok": true, "cleared": <количество записей> }`,
где `cleared` — число удалённых записей.
