# Продовый soft self-test — 2025-11-11

## Результат запроса
- **Маршрут:** `GET /admin/selftest` (Cloudflare Workers prod, токен администратора).
- **HTTP:** `200 OK` (HTTP/2).
- **OpenAI:** `openAiOk:false`, `openAiReason:"missing_diagnostic_marker"`, `openAiLatencyMs ≈ 3973`.
- **Telegram:** `telegramOk:true`, `telegramLatencyMs ≈ 99`, `telegramMessageId:"822"`.
- **Snapshot:** `lastWebhookSnapshot.route = "admin"`, `failSoft:false`.

```http
HTTP/2 200
content-type: application/json; charset=utf-8
content-length: 888
cf-ray: 99cf742e5eebf5c3-AMS
```

```json
{
  "openAiOk": false,
  "telegramOk": true,
  "errors": [],
  "openAiLatencyMs": 3973,
  "openAiUsedOutputText": false,
  "telegramLatencyMs": 99,
  "telegramMessageId": "822",
  "telegramStatus": 200,
  "telegramDescription": "OK",
  "telegramChatId": "136236606",
  "telegramChatIdSource": "whitelist",
  "lastWebhookSnapshot": {
    "updatedAt": "2025-11-11T17:19:22.890Z",
    "route": "admin",
    "failSoft": false,
    "chatIdRaw": { "present": true, "type": "string", "hash": "25edc14e666b", "length": 9 },
    "chatIdUsed": { "present": true, "type": "string", "hash": "25edc14e666b", "length": 9 },
    "sendTyping": { "ok": true, "statusCode": 200, "description": "OK" },
    "sendText": { "ok": true, "statusCode": 200, "description": "OK" }
  },
  "openAiReason": "missing_diagnostic_marker",
  "openAiSample": "Ку-прием, pong. Чем могу помочь?",
  "openAiResponseId": "resp_0aea5d3d9f81c71100691370175d808197aa10783f2db4b51b"
}
```

## Дополнительные наблюдения
- Cloudflare лог содержит одиночный `safe fallback sent` без поля `reason`.
- При вызове `/admin/export` появляется предупреждение `failed to update admin export cooldown kv`.
- Рекомендация консультанта: восстановить диагностический маркер в промпте Responses, убрать предупреждение экспорта и расширить логирование safe fallback.
