# Diagnostics Snapshot — 2025-11-16

## Critical system problems

1. **Typing indicator delayed by storage I/O**  
   *Scope:* `apps/worker-main/core/DialogEngine.ts` (ordering of storage vs `messaging.sendTyping`).  
   *Symptoms:* Typing appears with a long delay during peak load; fails requirement for instant user feedback.  
   *Impact:* Violates priority №1 (stable UX under load) and causes perceived downtime.  
   *Status:* Pending fix — Step 2 of roadmap.

2. **Temporary AI/Telegram errors immediately trigger fallback message**  
   *Scope:* `DialogEngine.handleMessage`, `apps/worker-main/infra/safe-webhook` (no retries).  
   *Symptoms:* Message "⚠️ → 🔁💬" appears for every 429/500 from OpenAI/Telegram.  
   *Impact:* Users lose replies, admins see false incident spikes; violates priority №1.  
   *Status:* Pending fix — Step 3 of roadmap.

3. **Assistant replies persisted before successful send**
   *Scope:* `DialogEngine.handleMessage` stores assistant message prior to `messaging.sendText`.
   *Symptoms:* Conversation history diverges when Telegram delivery fails; exports show phantom answers.
   *Impact:* Breaks priorities №1 and №2 (consistency of stored dialogue).
   *Status:* Resolved — 2025-11-16 проверка 3.1 завершена на продовом чате: записи `assistant` появляются только после подтверждённой отправки, содержат `messageId`, дублей и записей без `messageId` не обнаружено; fallback не срабатывал. См. [Cloudflare лог негативного прогона](../logs/cloudflare-sendtext-failure-2025-11-16.log) с подавленной записью `assistant` при искусственном отказе `sendText`.

4. **AI backpressure без контроля очереди**
   *Scope:* `adapters/openai-responses` (конкурентный доступ к OpenAI, конфиг очереди).
   *Symptoms:* До внедрения семафора воркер запускал неограниченное число fetch’ей, задержки AI приводили к росту TTFB и таймаутам.
   *Impact:* Нарушает приоритет №1 (стабильный UX) и создаёт ложные тревоги по таймаутам.
   *Status:* Resolved — реализован вариант A (см. [REPORT-ai-throughput-20251116](../reports/REPORT-ai-throughput-20251116.md)): `AI_MAX_CONCURRENCY = 4`, `AI_QUEUE_MAX_SIZE = 64`, `AI_TIMEOUT_MS = 12000 мс`, `AI_RETRY_MAX = 2`. Диагностика `/admin/diag?q=ai-queue` отдаёт `status: ok`, `active: 0`, `queued: 0`, `droppedSinceBoot: 0`; тревоги настроены на `queued ≥ 48` (Warning, >30 с) и любое `droppedSinceBoot > 0` (Critical). Артефакты smoke-прогона — `memory-bank/logs/ai-queue-smoke-2025-11-16.md`.

5. **Telegram export stops after first page**  
   *Scope:* `apps/worker-main/features/export/createTelegramExportCommandHandler.ts`.  
   *Symptoms:* CSV lacks most users/UTM data when dataset exceeds first page.  
   *Impact:* Breaks priorities №3 and №4 (UTM tracking & admin export).  
   *Status:* Pending fix — Step 5 of roadmap.

6. **Global LIMITS_ENABLED flag disables admin safeguards**  
   *Scope:* `apps/worker-main/compose.ts` (rate-limit toggle applied to all ports).  
   *Symptoms:* Disabling limits for dialogues removes throttling from `/export` and `/broadcast`.  
   *Impact:* Risks overload of D1 & Telegram; violates priorities №1 and №4.  
   *Status:* Pending fix — Step 6 of roadmap.

7. **Broadcast sender floods Telegram without throttling**  
   *Scope:* `apps/worker-main/features/broadcast/minimal-broadcast-service.ts`.  
   *Symptoms:* Parallel `Promise.all` triggers `429 Too Many Requests` and fallback storms.  
   *Impact:* Breaks priority №5 (basic broadcast) and destabilises rest of system.  
   *Status:* Pending fix — Step 7 of roadmap.

8. **Self-test fails hard when OpenAI marker missing**
   *Scope:* `apps/worker-main/features/admin/selftest`.
   *Symptoms:* `/admin/selftest` возвращал HTTP 500, хотя прод-контур отвечал.
   *Impact:* Создаёт ложные тревоги и скрывает реальные сбои.
   *Status:* Resolved — 2025-11-16 self-test зафиксирован: маршрут всегда отвечает `200`, поля `openAiOk`/`telegramOk` дополняются строкой `reason` при `false`, диагностический маркер (`openAiMarkerPresent`) проверяется без перевода ответа в `500`, `lastWebhookSnapshot` включает маршрут (`route`), `chat_id`, `chatIdRaw`, `chatIdNormalized` и тип исходного ID. Cloudflare-логи содержат ключи `route=`, `chatIdRawType`, `chatIdNormalizedHash`, `sendTyping status`, `sendText status` для внешней валидации.

## Observed signals & references

- Cloudflare production log (2025-11-11) showing fallback messages and delayed exports; после обновления self-test лог дополнен ключами маршрута, типов `chat_id` и статусов отправки (`route=…`, `chatIdRawType`, `chatIdNormalizedHash`, `sendTyping status`, `sendText status`).
- Smoke-прогон варианта A: `memory-bank/logs/ai-queue-smoke-2025-11-16.md` с ссылками на tail-лог и снимок диагностики.
- Cloudflare negative run (2025-11-16) — [dialog-engine][sendText][error] зафиксирован, сохранение `assistant` подавлено, запись отсутствует без `messageId` (см. `../logs/cloudflare-sendtext-failure-2025-11-16.log`).
- Стресс-тест AI/D1 (2025-11-17) — см. `../logs/stress-test-2025-11-17-ai-queue.md`: `/admin/diag?q=ai-queue` стабильно возвращает `active=0`, `queued=0`, `droppedSinceBoot=0`, `maxConcurrency=4`, `maxQueue=64`; в Observability нет `[ai][timeout]`/`[ai][dropped]`, но стресс-ручка D1 доходит до `max_retries_exceeded` после 6 попыток.
- Admin export CSV missing user conversations and UTM column.
- Self-test payload from `https://tg-responcer.egormob.workers.dev/admin/selftest?token=***` returning 500 with `openAiOk: false`.
- Lossless Telegram ID parser подтверждён: `chatIdRawType` и `chatIdNormalizedHash` стабильны, ручной прогон `/start`/self-test не показывает `400 Bad Request` от Bot API.

## Next steps

- Roadmap Step 1 закрыт — текущая диагностика зафиксирована в этом файле и `RoadMap.md`.
- Продолжить с Roadmap Step 2 (ранний запуск typing) и последующими шагами, обновляя файл при появлении новых симптомов.
