# DIAG-PACKET 2025-11-13 — External Pre-Step 5 Load Monitoring

## Scope
- **Goal:** подтвердить стабильность очереди `ai-queue` и D1 stress-ручки перед началом RoadMap Step 5.
- **Source:** Cloudflare `wrangler tail` + `/admin/diag?q=ai-queue` + `/admin/d1-stress?durationSec=120&concurrency=8` (старт отмечен `[d1-stress][start]`).
- **Worker mode:** `STRESS_TEST_ENABLED=1`, Variant C конфиг очереди (`requestTimeoutMs=18000`, `retryMax=3`).

## ai-queue snapshots
1. `/admin/diag?q=ai-queue` до нагрузки: `status:"ok"`, `active:0`, `queued:0`, `droppedSinceBoot:0`, `maxConcurrency:4`, `maxQueue:64`, `requestTimeoutMs:18000`, `retryMax:3`, `avgWaitMs:0`, `lastDropAt:null`, `sources.* = "default"`, `kvConfig:null`.
2. `/admin/diag?q=ai-queue` после нагрузки: полностью совпадает с начальным снимком.
3. Tail-лог `queue_leave` под нагрузкой показывает `queueWaitMs:0`, `droppedSinceBoot:0`, рост очереди не фиксируется.

**Вывод:** текущая нагрузка не насыщает очередь: `active ≤ 1`, отбрасываний нет. Из-за `kvConfig:null` значения читаются из дефолтов env, а не из `AI_CONTROL_KV`, что остаётся известным ограничением Variant C.

## D1 stress harness
- Выполнен `/admin/d1-stress?durationSec=120&concurrency=8`, старт отмечен `[d1-stress][start]`.
- В логах присутствует `Too many API requests by single worker invocation` с `retryable:true` и автоповтором (`nextDelayMs≈100 ms`), `max_retries_exceeded` не достигается.
- Механика ретраев `runWithRetry` сохраняет успешный прогон: D1 записей хватает без деградаций.

**Вывод:** стресс-инструмент подтверждает устойчивость D1 под имитацией параллельных обращений; ограничения приходят со стороны API лимитов, но перехватываются ретраями.

## OpenAI Responses behavior
- На части боевых диалогов фиксируются `[ai][retry]` / `[ai][timeout]` c причиной `OpenAI Responses request timed out`.
- После таймаута срабатывает безопасный fallback (`[safe] done`), пользователи получают заглушку, последующие сообщения проходят успешно.

**Вывод:** текущее узкое место — латентность внешнего OpenAI API. Safe-fallback работает, ядро воркера и D1 не деградируют.

## Verdict
- **Queue/D1 gate:** PASS — `ai-queue` и `d1-stress` выдерживают External Pre-Step 5 нагрузку без насыщения очереди и без `max_retries_exceeded`.
- **Action items:** подтвердить чтение `AI_QUEUE_CONFIG` из `AI_CONTROL_KV` (сейчас `kvConfig:null`) и продолжить работу RoadMap Step 5; дополнительные улучшения нужны по OpenAI Responses (таймауты), а не по воркеру.
