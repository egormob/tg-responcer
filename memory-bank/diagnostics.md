# Diagnostics Snapshot — 2025-11-16

## Журнал диагностик

| Дата | Шаг / майлстоун | max_retries_exceeded | ai_queue_source | ai_queue_active | ai_queue_queued | ai_queue_dropped | utm_rows | utm_sources | selftest.openAiOk | selftest.telegramOk | selftest.softMode | Ключевые наблюдения | Ссылки |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| <a id="diag-20251111"></a>2025-11-11 | М9.Ш10 soft self-test | 0 | n/a | 0 | 0 | 0 | — | — | false | true | enabled | HTTP 200 с soft-режимом self-test, OpenAI ругается на `missing_diagnostic_marker`, Telegram отвечает 200. | [лог](logs/selftest-soft-2025-11-11.md); [external check](external-checks/2025-11-11-soft-selftest.md) |
| <a id="diag-20251116"></a>2025-11-16 | М9.Ш4.5 AI queue smoke | 0 | kv | ≤4 | ≤7 | 0 | — | — | — | — | — | Smoke Variant C: очередь берёт лимиты из KV (`maxConcurrency=4`, `maxQueue=64`), `droppedSinceBoot=0`. | [лог](logs/ai-queue-smoke-2025-11-16.md); [отчёт](../reports/REPORT-ai-throughput-20251116.md) |
| <a id="diag-20251117"></a>2025-11-17 | М5.Ш4.4 stress-run | >0 | env-default | 0 | 0 | 0 | — | — | — | — | — | `STRESS_TEST_ENABLED=1` упирается в `max_retries_exceeded`, очередь читает дефолты, KV проигнорирован. | [лог](logs/stress-test-2025-11-17-ai-queue.md) |
| <a id="diag-20251118"></a>2025-11-18 | М5.Ш4.4 retest | 0 | env-default | ≤1 | 0 | 0 | — | — | — | — | — | Повторный smoke: очередь стабильна (`kvConfig:null`), таймауты OpenAI дают «Я на секунду отвлекся, пожалуйста, отправьте сообщение ещё раз 🔁💬» (ранее `⚠️ → 🔁💬`), KV всё ещё не читается. | [лог](logs/stress-test-2025-11-17-ai-queue.md); [отчёт](../reports/REPORT-ai-queue-20251118.md) |
| <a id="diag-20251118b"></a>2025-11-18 | М8.Ш4 broadcast финальный чек | 0 | kv | ≤1 | 0 | 0 | — | — | — | — | — | `/broadcast` из D1 доставляет всем адресатам (`list`=1, `all`=5) без 429 и хвостов, очередь AI не растёт (`queued=0`, `active≤1`), параллельный диалог стабильный. | [лог](logs/broadcast-parallel-dialog-2025-11-18.md) |
| <a id="diag-20251119"></a>2025-11-19 | М9.Ш4.4 Variant C | 0 | kv | 0 | 0 | 0 | — | — | — | — | — | Variant C добавляет `sources.*`, повышает `requestTimeoutMs=18000`, `retryMax=3`, `getQueueStats` отдаёт происхождение параметров. | [отчёт](../reports/REPORT-ai-throughput-20251116.md) |
| <a id="diag-20251120"></a>2025-11-20 | М5.Ш5.1 UTM запись | 0 | kv | 0 | 0 | 0 | 1 | src_TEST-CAMPAIGN | — | — | — | `/start src_TEST-CAMPAIGN` фиксирует UTM без деградации, `knownUsersCache` блокирует повторные `saveUser`. | [отчёт](../reports/REPORT-utm-tracking-20251120.md) |
| <a id="diag-20251121"></a>2025-11-21 | М5.Ш5.2 локальный `/start` | 0 | n/a | 0 | 0 | 0 | 1 | src_TEST-CAMPAIGN | — | — | — | Приветствие выполняется локально: OpenAI не вызывается, `utm_source` не перезаписывается, fallback отсутствует. | [лог](logs/start-command-2025-11-21.md) |
| <a id="diag-20251201"></a>2025-12-01 | М8.Ш4 broadcast UX | 0 | kv | ≤4 | 0 | 0 | — | — | — | — | — | `/admin/diag?q=broadcast` ×2: `status: ok`, `recipients: 5`, `delivered: 2`, `failed: 3`, `throttled429: 0`, текст >3970 символов отклоняется и требует повторного ввода; очередь ИИ читает KV-конфиг (`maxConcurrency=4`, `maxQueue=64`, `requestTimeoutMs=18000`, `retryMax=3`), воркер без сбоев. | [лог](logs/diag-2025-12-01-broadcast-metrics.md) |
| <a id="diag-20251205"></a>2025-12-05 | М8 — текущая диагностика | 0 | kv | ≤1 | 0 | 0 | — | — | — | — | — | Смоук `/broadcast` с `jobId: "job-20251205-smoke"`: `totalRuns: 3`, `lastRun.delivered/failed: 4/1`, `throttled429: 0`, `status: ok`. В `/admin/diag` нет карточки `progress`/команд resume/cancel, tail фиксирует только `broadcast pool initialized/delivered/failed/completed` без paused/retry_after. | [лог](logs/diag-2025-12-05-broadcast-smoke.md) |
| <a id="diag-20251209"></a>2025-12-09 | AI guard burst + «книга» | 0 | kv | 0 | 0 | 0 | — | — | — | — | — | Burst (4–5 коротких сообщений в чат 270641809): guard маршрутизирует лишние апдейты в `ai_backpressure` с `merged=true`, пользователь видит «Подождите…». Очередь пуста (`active=0`, `queued=0`, `droppedSinceBoot=0`), таймауты OpenAI дают `AI_QUEUE_TIMEOUT`/fallback. Кейс «книга»: Responses таймаутит, failover на `cf_region=eu`, guard держит последующие сообщения, после таймаута чат восстанавливается. Guard-статы теперь агрегируются через `AI_CONTROL_KV` и видны в `/admin/diag?q=ai-queue` (если нули — текущий инстанс не блокировал). | [лог](logs/ai-guard-2025-12-09-burst-book.md) |
| <a id="diag-20251122b"></a>2025-11-22 | М8 guardrail smoke (5 адресатов) | 0 | kv | ≤1 | 0 | 0 | — | — | — | — | — | `/broadcast → /everybody → короткий текст → /send`, затем `/broadcast_pause` и `/broadcast_resume`; доставлено 2/5, 3/5 упали с `403 Forbidden: bot was blocked by the user`. `/admin/diag?q=broadcast` увеличил `totalRuns` 11 → 12, `progress: null`, карточки pause/resume не показаны; команды `/status` и `/end` вернули техсообщение «Не успел ответить вовремя…». В tail нет событий `broadcast_watchdog*`/pause/resume для `jobId: 6b0361f8-875f-419f-ba84-eddc63a11665`. | [лог](logs/diag-2025-11-22-broadcast-guardrail.md) |
| <a id="diag-20251122"></a>2025-11-22 | М5.Ш5.3 экспорт с пагинацией | 0 | kv | ≤1 | 0 | 0 | 1849 | src_DIAG, src_TEST-GREETING, stress_test | — | — | — | `/admin/export` склеивает страницы (2 курсора), `utm_rows=1849`, лимит 5 000 контролируется уведомлением. | [лог](logs/export-pagination-2025-11-22.md); [отчёт](../reports/REPORT-limits-export-cooldown-20251123.md) |
| <a id="diag-20251127"></a>2025-11-27 | М8.Ш7 webhook regression | — | — | — | — | — | — | — | — | false | — | `createRouter.handleWebhook` возвращает 500/403 без `TELEGRAM_WEBHOOK_SECRET`; CLI `wrangler` недоступен, добавлен скрипт восстановления и журнал. | [лог](logs/telegram-webhook-diagnostics-2025-11-27.md); [скрипт](../scripts/diagnose-telegram-webhook.sh) |

> **Как пользоваться таблицей:** каждая строка фиксирует дату, шаг/майлстоун, измеренные метрики и ссылки на артефакты. Новый диагностический отчёт сначала попадает сюда, после чего RoadMap ссылается на соответствующую запись (`memory-bank/diagnostics.md#diag-YYYYMMDD`).

## Critical system problems

1. **Typing indicator delayed by storage I/O**  
   *Scope:* `apps/worker-main/core/DialogEngine.ts` (ordering of storage vs `messaging.sendTyping`).  
   *Symptoms:* Typing appears with a long delay during peak load; fails requirement for instant user feedback.  
   *Impact:* Violates priority №1 (stable UX under load) and causes perceived downtime.  
   *Status:* Pending fix — Step 2 of roadmap.

2. **Temporary AI/Telegram errors immediately trigger fallback message**  
   *Scope:* `DialogEngine.handleMessage`, `apps/worker-main/infra/safe-webhook` (no retries).  
   *Symptoms:* Сообщение «Я на секунду отвлекся, пожалуйста, отправьте сообщение ещё раз 🔁💬» появляется при каждом 429/500 от OpenAI/Telegram (ранее `⚠️ → 🔁💬`).  
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
   *Status:* Resolved — 2025-11-23 `composeWorker` возвращает «сырые» `ports.rawRateLimit` для админских модулей, `/export` подключён к этому порту, а новый тест `apps/worker-main/composition/__tests__/compose.test.ts` воспроизводит `LIMITS_ENABLED=0` и проверяет, что пользовательский лимитер отключается, но админский остаётся строгим. **ПРОВЕРКА 6.1** от 2025-11-23 подтверждена боевым спамом `/export`: пользовательские сообщения при `LIMITS_ENABLED=0` не получают 429, а повторные `/export` ловят `admin export cooldown active` с русскоязычным уведомлением и TTL ≥ 60 с (см. `logs/limits-6-1-tail.json`, `reports/REPORT-limits-export-cooldown-20251123.md`).

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

9. **`/admin status` даёт отказ даже whitelisted администратору**
   *Scope:* `apps/worker-main/http/router.ts`, `system-commands` registry.
   *Symptoms:* В бою `/admin status` возвращал «Эта команда доступна только администратору» для реального администратора, хотя `/admin` и `/export` работали. Cloudflare-лог показывал `kind: role_mismatch`, т.е. resolver останавливался до вызова `determineCommandRole`.
   *Impact:* Операторы не могут подтвердить доступ, а значит не могут выполнить чек-листы перед релизом.
   *Status:* Resolved — 2025-11-25 router теперь запрашивает `determineCommandRole` даже при `role_mismatch` и регистрирует `systemCommands` на основе подтверждённого ответа; whitelisted ID больше не теряются, а неадмины по-прежнему получают отказ.

10. **Админские команды маскируют AI таймауты обычных пользователей**
    *Scope:* `apps/worker-main/adapters/openai-responses`, `core/DialogEngine.ts`.
    *Symptoms:* При двойном `/export` пользователь получил fallback «Не успел ответить вовремя…», хотя очередь OpenAI должна быть пустой. Сейчас невозможно связать fallback с фактическим состоянием лимитера.
    *Impact:* Администраторы могут «повесить» прод, не имея диагностики (нет `queueWaitMs`, `requestId`, `endpointId` в логах `ai_fallback`).
    *Status:* Mitigated — 2025-11-25 ошибки `AI_QUEUE_TIMEOUT` теперь несут `queueDetails` (attempt, phase, queueWaitMs, endpoint, snapshot лимитера), а ядро логирует `[dialog-engine][ai_fallback]` с этой структурой. Следующий шаг — зафиксировать сценарий «двойной /export + пользователь» с новыми логами.

11. **Повторные уведомления кулдауна `/export` глушат ответы админам**
    *Scope:* `apps/worker-main/features/export/telegram-export-command.ts` (кулдаун и рассылка уведомлений).
    *Symptoms:* После серии повторных `/export` (<60 с) администратор получал 6–7 сообщений «Экспорт формируется…», после чего Telegram начинал отвечать 429 и чат полностью «немел» (нет typing, AI-ответов и системных сообщений), хотя пользовательский чат работал.
    *Impact:* Любой администратор мог локально заблокировать канал поддержки, а диагностика tail-файла не фиксировала причину, потому что sendText падал уже на стороне Telegram.
    *Status:* Resolved — 2025-11-26 кулдаун хранит `expiresAt/noticeSentAt` и отправляет предупреждение только при первой повторной попытке (без продления TTL). Тест `createTelegramExportCommandHandler › prevents repeated export requests within cooldown window` проверяет, что третья попытка в кулдауне возвращает 429 без дополнительного sendText.

## Observed signals & references

- Cloudflare production log (2025-11-11) showing fallback messages and delayed exports; после обновления self-test лог дополнен ключами маршрута, типов `chat_id` и статусов отправки (`route=…`, `chatIdRawType`, `chatIdNormalizedHash`, `sendTyping status`, `sendText status`).
- Smoke-прогон варианта C: `memory-bank/logs/ai-queue-smoke-2025-11-16.md` (лог, diag JSON), подтверждает `sources.*='kv'` и отсутствие `droppedSinceBoot`.
- Cloudflare negative run (2025-11-16) — [dialog-engine][sendText][error] зафиксирован, сохранение `assistant` подавлено, запись отсутствует без `messageId` (см. `../logs/cloudflare-sendtext-failure-2025-11-16.log`).
- Стресс-тест AI/D1 (2025-11-17) — см. `../logs/stress-test-2025-11-17-ai-queue.md`: фиксируем `wrangler tail` фрагменты `[ai][config]` + скрин `/admin/diag?q=ai-queue` (до/во время/после) и указываем путь к внешним артефактам (tail-лог, diag PNG/JSON). `/admin/diag` должен подтверждать `sources.*='kv'`; если `kvConfig:null`, это блокер шага [RoadMap Step 4.4](../RoadMap.md).
- Admin export CSV missing user conversations and UTM column.
- Self-test payload from `https://tg-responcer.egormob.workers.dev/admin/selftest?token=***` returning 500 with `openAiOk: false`.
- Lossless Telegram ID parser подтверждён: `chatIdRawType` и `chatIdNormalizedHash` стабильны, ручной прогон `/start`/self-test не показывает `400 Bad Request` от Bot API.

### Operations memo — fallback «Я на секунду отвлекся, пожалуйста, отправьте сообщение ещё раз 🔁💬» (раньше `⚠️ → 🔁💬`)

- Сообщение «Я на секунду отвлекся, пожалуйста, отправьте сообщение ещё раз 🔁💬» (раньше `⚠️ → 🔁💬`) фиксирует мягкий отказ OpenAI/Telegram. Считаем **допустимым** при наличии в логах явного `(warn) [ai][timeout] reason: 'OpenAI Responses request timed out' requestId=…` или `openaiError.requestId`, т.е. совпадает с RoadMap Step 4.4 критериями (`requestTimeoutMs`, `retryMax`), и сопровождается `sources.*='kv'` в `/admin/diag`.
- Сигнал становится **actionable**, если всплеск «Я на секунду отвлекся, пожалуйста, отправьте сообщение ещё раз 🔁💬» не сопровождается `requestId`/timeout-контекстом или происходит при `max_retries_exceeded`/`kvConfig:null`. В этом случае эскалируем по Step 4.4: собираем `wrangler tail` (с `requestId`, `ai-queue` метриками), скрин `/admin/diag?q=ai-queue`, лог `/admin/d1-stress` (если запущен).
- Для `/admin/d1-stress` и pre-Step 5 наблюдения сохраняем: (1) Cloudflare tail `logs/stress-test-YYYY-MM-DD-ai-queue.log`, (2) diag JSON/PNG в каталоге внешних артефактов + ссылка в `memory-bank/logs/stress-test-*.md`, (3) снимок `/admin/d1-stress` ответа (внешнее хранилище). Это служит источником истины при сверке с `reports/REPORT-ai-throughput-20251116.md` и RoadMap.

## Next steps

- Roadmap Step 1 закрыт — текущая диагностика зафиксирована в этом файле и `RoadMap.md`.
- Продолжить с Roadmap Step 2 (ранний запуск typing) и последующими шагами, обновляя файл при появлении новых симптомов.
