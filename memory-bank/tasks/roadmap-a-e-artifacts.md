# Crosslinks: Полная дорожная карта (A–E)
Записи для секции RoadMap «Полная дорожная карта (A–E)» с артефактами диагностики, боевых проверок и памяток.

## A1. Encode system conversation turns as `input_text`
- Статус: выполнено. Адаптер Responses использует `input_text`, что покрыто тестами `openai-responses.test.ts`.
- Артефакты: `apps/worker-main/adapters/openai-responses/index.ts`, `docs/operations/diagnostics.md` (фиксирует валидный `input_text`).

## A2. AI Queue stress-тесты (`STRESS_TEST_ENABLED`, `STRESS_TEST_MAX_RETRIES_EXCEEDED`)
- Статус: выполнено. Стресс-прогон Variant C и диагностика ретраев задокументированы.
- Артефакты: [`memory-bank/logs/stress-test-2025-11-17-ai-queue.md`](../logs/stress-test-2025-11-17-ai-queue.md), [`memory-bank/diagnostics.md#diag-20251116`](../diagnostics.md#diag-20251116), [`memory-bank/logs/m9-ai-export-timeout-2025-11-26.md`](../logs/m9-ai-export-timeout-2025-11-26.md).

## B1. Гарантированная async UTM-регистрация и UTM-алерты
- Статус: выполнено, боевой тест подтверждён; регистрация UTM не блокирует диалоги.
- Артефакты: [`memory-bank/diagnostics.md#diag-20251120`](../diagnostics.md#diag-20251120), [`memory-bank/operations/start-command.md`](../operations/start-command.md), [`memory-bank/references/telegram-deeplink-utm.md`](../references/telegram-deeplink-utm.md).

## B2. Экспорт CSV с пагинацией и UTM
- Статус: выполнено, боевой тест экспорта подтверждён.
- Артефакты: [`memory-bank/logs/export-pagination-2025-11-22.md`](../logs/export-pagination-2025-11-22.md), [`reports/REPORT-utm-tracking-20251120.md`](../../reports/REPORT-utm-tracking-20251120.md), [`memory-bank/operations/export.md`](../operations/export.md).

## C1. UX-фиксы `/broadcast`
- Статус: не завершено; требуется устранить двойное предупреждение о лимите текста (М8.Ш4) и смежные UX-пункты.
- Артефакты: [`memory-bank/logs/diag-2025-11-30-broadcast-webhook.md`](../logs/diag-2025-11-30-broadcast-webhook.md), [`memory-bank/operations/broadcast-operations.md`](../operations/broadcast-operations.md).

## D1. Observability & On-call
- Статус: выполнено; проведены мягкий self-test (200 с `openAiOk=false` → `true`), разделение retriable/non-retriable и разграничение user/admin команд.
- Артефакты: [`memory-bank/logs/selftest-soft-2025-11-11.md`](../logs/selftest-soft-2025-11-11.md), [`memory-bank/logs/m9-ai-export-timeout-2025-11-26.md`](../logs/m9-ai-export-timeout-2025-11-26.md), [`memory-bank/diagnostics.md#diag-20251111`](../diagnostics.md#diag-20251111).

## E1. Comms & models evaluation
- Статус: не выполнено; остаётся в backlog М10 для уточнения критериев и тестов перед стартом.
- Артефакты: [`memory-bank/openai-responses-prompt.md`](../openai-responses-prompt.md) для текущих моделей и контекстной информации.
