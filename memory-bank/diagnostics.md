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
   *Status:* Resolved — актуальная база (вариант C из [REPORT-ai-throughput-20251116](../reports/REPORT-ai-throughput-20251116.md)) зафиксирована через `AI_CONTROL_KV`: `maxConcurrency = 4`, `maxQueue = 64`, `requestTimeoutMs = 18000`, `retryMax = 3`. Диагностика `/admin/diag?q=ai-queue` обязана показывать `sources.maxConcurrency = sources.maxQueue = sources.requestTimeoutMs = sources.retryMax = "kv"`; значения `status: ok`, `active: 0`, `queued: 0`, `droppedSinceBoot: 0` остаются нормой. Пороги тревог прежние: `queued ≥ 48` (Warning, >30 с ожидания) и `droppedSinceBoot > 0` (Critical). При обновлении конфигурации скриншоты `/admin/diag` прикладываются к `memory-bank/logs/ai-queue-smoke-*.md` и стресс-отчётам.

5. **Telegram export stops after first page**  
   *Scope:* `apps/worker-main/features/export/createTelegramExportCommandHandler.ts`.  
   *Symptoms:* CSV lacks most users/UTM data when dataset exceeds first page.  
   *Impact:* Breaks priorities №3 and №4 (UTM tracking & admin export).  
   *Status:* Pending fix — Step 5 of roadmap.

6. **Global LIMITS_ENABLED flag disables admin safeguards**
   *Scope:* `apps/worker-main/compose.ts` (rate-limit toggle applied to all ports).
   *Symptoms:* Disabling limits for dialogues removes throttling from `/export` and `/broadcast`.
   *Impact:* Risks overload of D1 & Telegram; violates priorities №1 and №4.
   *Status:* Resolved — 2025-11-23 `composeWorker` возвращает «сырые» `ports.rawRateLimit` для админских модулей, `/export` подключён к этому порту, а новый тест `apps/worker-main/composition/__tests__/compose.test.ts` воспроизводит `LIMITS_ENABLED=0` и проверяет, что пользовательский лимитер отключается, но админский остаётся строгим. **ПРОВЕРКА 6.1** теперь требует интеграционный техтест с KV-флагом и боевой спам `/export`, чтобы подтвердить отсутствие 429 для пользователя и сохранение 429 для админов.

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
- Smoke-прогон варианта C: `memory-bank/logs/ai-queue-smoke-2025-11-16.md` (лог, diag JSON), подтверждает `sources.*='kv'` и отсутствие `droppedSinceBoot`.
- Cloudflare negative run (2025-11-16) — [dialog-engine][sendText][error] зафиксирован, сохранение `assistant` подавлено, запись отсутствует без `messageId` (см. `../logs/cloudflare-sendtext-failure-2025-11-16.log`).
- Стресс-тест AI/D1 (2025-11-17) — см. `../logs/stress-test-2025-11-17-ai-queue.md`: фиксируем `wrangler tail` фрагменты `[ai][config]` + скрин `/admin/diag?q=ai-queue` (до/во время/после) и указываем путь к внешним артефактам (tail-лог, diag PNG/JSON). `/admin/diag` должен подтверждать `sources.*='kv'`; если `kvConfig:null`, это блокер шага [RoadMap Step 4.4](../RoadMap.md).
- Admin export CSV missing user conversations and UTM column.
- Self-test payload from `https://tg-responcer.egormob.workers.dev/admin/selftest?token=***` returning 500 with `openAiOk: false`.
- Lossless Telegram ID parser подтверждён: `chatIdRawType` и `chatIdNormalizedHash` стабильны, ручной прогон `/start`/self-test не показывает `400 Bad Request` от Bot API.

### Operations memo — `⚠️ → 🔁💬`

- Символ `⚠️ → 🔁💬` фиксирует мягкий отказ OpenAI/Telegram. Считаем **допустимым** при наличии в логах явного `(warn) [ai][timeout] reason: 'OpenAI Responses request timed out' requestId=…` или `openaiError.requestId`, т.е. совпадает с RoadMap Step 4.4 критериями (`requestTimeoutMs`, `retryMax`), и сопровождается `sources.*='kv'` в `/admin/diag`.
- Сигнал становится **actionable**, если всплеск `⚠️ → 🔁💬` не сопровождается `requestId`/timeout-контекстом или происходит при `max_retries_exceeded`/`kvConfig:null`. В этом случае эскалируем по Step 4.4: собираем `wrangler tail` (с `requestId`, `ai-queue` метриками), скрин `/admin/diag?q=ai-queue`, лог `/admin/d1-stress` (если запущен).
- Для `/admin/d1-stress` и pre-Step 5 наблюдения сохраняем: (1) Cloudflare tail `logs/stress-test-YYYY-MM-DD-ai-queue.log`, (2) diag JSON/PNG в каталоге внешних артефактов + ссылка в `memory-bank/logs/stress-test-*.md`, (3) снимок `/admin/d1-stress` ответа (внешнее хранилище). Это служит источником истины при сверке с `reports/REPORT-ai-throughput-20251116.md` и RoadMap.

## Next steps

- Roadmap Step 1 закрыт — текущая диагностика зафиксирована в этом файле и `RoadMap.md`.
- Продолжить с Roadmap Step 2 (ранний запуск typing) и последующими шагами, обновляя файл при появлении новых симптомов.
