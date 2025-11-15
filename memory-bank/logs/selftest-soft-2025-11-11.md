# Prod soft self-test snapshot — 2025-11-11

- **Маршрут:** `GET /admin/selftest` на продовом воркере с валидным `X-Admin-Token`.
- **Цель:** подтвердить работу soft self-test — HTTP 200 даже при `openAiOk:false`, зафиксировать latencies и `lastWebhookSnapshot`.
- **Метрики:**
  - `openAiOk:false`, `openAiReason:"missing_diagnostic_marker"`, `openAiLatencyMs≈3973`, `openAiResponseId=resp_0aea5d…`.
  - `telegramOk:true`, `telegramLatencyMs≈99`, `telegramMessageId:822`, `failSoft:false`.
  - `max_retries_exceeded:0`, `ai_queue_active:0`, `ai_queue_queued:0`, `ai_queue_dropped:0`.
  - `selftest.softMode:enabled` (маршрут всегда возвращает 200, ошибки только в payload).
- **Снимок:** `lastWebhookSnapshot.route="admin"`, `chatIdRaw/chatIdUsed` совпадают, `sendTyping`/`sendText` завершились `200`.
- **Артефакты:** подробный JSON-ответ и контекст сохранены в [`memory-bank/external-checks/2025-11-11-soft-selftest.md`](../external-checks/2025-11-11-soft-selftest.md).
