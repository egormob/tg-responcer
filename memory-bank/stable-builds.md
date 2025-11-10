# Stable Production Snapshots

- После подтверждения внешними проверками успешного завершения майлстоуна создаём аннотированный тег `prod-YYYY-MM-DD[-label]`, пушим его в `origin` и добавляем сюда запись со ссылкой и описанием.

## 2025-11-10 — Старт задач М8 (минимальная модель рассылок)
- Зафиксировано начало работ по подпунктам М8: переход на минимальный сценарий `/broadcast → введите текст → мгновенная отправка`, отказ от HTTP-роутов и очередей.
- Обновлены артефакты: `RoadMap.md` (подраздел М8) и `memory-bank/operations/broadcast-operations.md`.
- Следующие шаги: поддерживать журналы рассылок, наблюдать `wrangler tail` и оценить необходимость дополнительных подтверждений перед отправкой.

## 2025-11-11 — Telegram 400 из-за усечённого chat_id
- См. расследование: [issues/2025-11-11-telegram-id-truncation.md](issues/2025-11-11-telegram-id-truncation.md).
- Следующая диагностика должна проверять корректность BigInt-совместимого парсинга webhook и отсутствие повторных 400-ответов.

## 2025-11-09 — Диалог зависает при 400 от transformPayload
- См. расследование: [issues/2025-11-09-dialog-freeze.md](issues/2025-11-09-dialog-freeze.md).
- Текущий статус: требуется вынести UTM-запись из критического пути и подтвердить восстановление ответов.

## prod-2025-11-02-stable
- **Commit**: efe6573413f12ff24451eb89d5ea73b03bae3689
- **Description**: Responses-only prod: Telegram-бот отвечает по промпту из OpenAI Responses, память отключена.
- **Checks**:
  - Ручной прогон через Telegram: ответы соответствуют сценариям промпта, задержек и ошибок не наблюдается.
  - Подтверждена работоспособность без памяти: диалоги обрабатываются через Responses, состояние не сохраняется.
- **Tag**: `prod-2025-11-02-stable`

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
- `features/broadcast` — доработать наблюдение за минимальной моделью рассылок (М8.Ш3): журналирование, оповещения, контроль whitelisting.
- `features/observability`/`http/admin/*` — добавить requestId в логи и убедиться, что метрики не зависят от legacy-полей.
- Памятки деплоя — обновить `memory-bank/openai-responses-prompt.md`, `memory-bank/operations.md` перед включением Responses-only.

## 2025-11-09 — IaC конфигурация Cloudflare (неуспешно)
- **Status**: блокировано политикой npm — установка `wrangler` из `npx` завершилась ошибкой `403 Forbidden`, поэтому деплой и проверка `/admin/envz` не выполнены.
- **Command log**: см. попытку `npx wrangler deploy` с ошибкой доступа к пакету Wrangler.【a079f5†L1-L7】
- **Screenshots**: отсутствуют (деплой не запускался, раздел `/admin/envz` недоступен).
