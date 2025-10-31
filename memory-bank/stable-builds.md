# Stable Production Snapshots

## prod-2025-10-31-pr38
- **Commit**: 3aaaf6fb081e131b56de2bc3b9a633fbb23ebaed
- **Description**: Known-good prod. Workers Builds: PR #38 (lazy model retrieval).
- **Checks**:
  - Healthz: https://tg-responcer.egormob.workers.dev/healthz → {"status":"ok"}
  - Self-test ping: https://tg-responcer.egormob.workers.dev/admin/selftest?token=devadmintoken&q=ping → {"ok":false,"error":"OpenAI Responses request failed: OpenAI Responses request failed: AI_NON_2XX","snippet":"Error: OpenAI Responses request failed: OpenAI Responses request failed: AI_NON_2XX\n    at createWrappedError (index.js:673:17)\n    at Object.reply (index.js:813:19)\n    at async Object.selfTest (index.js:1433:21)"}
  - Diagnostics: https://tg-responcer.egormob.workers.dev/admin/diag?token=devadmintoken → Not Found
- Telegram webhook: https://api.telegram.org/bot<token>/getWebhookInfo → {"ok":true,"result":true,"description":"Webhook is already set"}

Use this tag as the baseline for future recoveries and production deploys.

## Pending module readiness (RoadMap M1.Ш3)
- `adapters/d1-storage` — добавить `response_id` в миграции и убедиться, что self-test использует сохранённые идентификаторы при `previous_response_id`.
- `features/export` — расширить CSV колонками `model`, `response_id`, протестировать выгрузку длинных сообщений.
- `features/limits`/`adapters/kv-rate-limit` — синхронизировать тексты уведомлений и убедиться, что отсутствуют ссылки на `assistantId`.
- `features/broadcast` — предусмотреть включение флага `BROADCAST_ENABLED`, троттлинг и очереди для больших рассылок.
- `features/observability`/`http/admin/*` — добавить requestId в логи и убедиться, что метрики не зависят от legacy-полей.
- Памятки деплоя — обновить `memory-bank/openai-responses-prompt.md`, `memory-bank/operations.md` перед включением Responses-only.
