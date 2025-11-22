# Диагностика broadcast guardrail — 2025-11-22 (5 адресатов)

## Контекст
- Администратор: `136236606` (whitelist).
- Сценарий: `/broadcast → /everybody → короткий текст → /send`, затем вручную `/broadcast_pause` → `/broadcast_resume`. После возобновления команды `/status` и `/end` дважды вернули «Не успел ответить вовремя — пожалуйста, отправь сообщение ещё раз.»
- Цель: smoke guardrail на малой аудитории, проверка pause/resume и наличия команд в уведомлениях.

## Диагностика до теста — `/admin/diag?q=broadcast`
- `totalRuns: 11`.
- `lastRun` (перед тестом): `jobId` не указан, `requestedBy: "136236606"`, `recipients: 5`, `delivered: 2`, `failed: 3`, `throttled429: 0`, `durationMs: 204`, `startedAt: 2025-11-22T08:04:50.170Z`, `completedAt: 2025-11-22T08:04:50.374Z`, `status: "ok"`.
- `history`: последние 10 запусков с аналогичными метриками; `progress: null`.

## Хвост `wrangler tail` (`tg-responcer-broadcast-20251122-141141.log`)
- Единственный цикл отправки с `jobId: 6b0361f8-875f-419f-ba84-eddc63a11665`.
- Последовательность событий:
  - `broadcast pending metrics` → reason `command`, `activePending: 0`, `expiredPending: 0`.
  - `broadcast awaiting audience selection` → `userId/chatId: 136236606`.
  - `broadcast_resolve` → source `D1`, `recipients: 5`, выборка: `136236606`, `270641809` и ещё 3 chatId; `jobId` присвоен.
  - `broadcast using registry recipients` → `recipients: 5`.
  - `broadcast awaiting text` → `mode: all`, `total: 5`, `notFound: []`.
  - `broadcast awaiting send confirmation` → `total: 5`.
  - `broadcast dispatch confirmed via telegram command` → `total: 5`.
  - `broadcast pool initialized` → `poolSize: 4`, `maxAttempts: 3`, `baseDelayMs: 1000`, `jitterRatio: 0.2`, `maxRps: 28`, `rateJitterRatio: 0.1`, `batchSize: 50`, `maxBatchTextBytes: 198500`.
  - Доставки (2 шт): `chatId 136236606` (`messageId 3348`), `chatId 270641809` (`messageId 3349`), `attempt: 1`.
  - Ошибки (3 шт): `chatId 100596580 / 174401059 / 67961303`, ошибка `TelegramApiError: Forbidden: bot was blocked by the user`, `attempt: 1`.
  - `broadcast_summary` → `delivered: 2`, `failed: 3`, `throttled429: 0`, `durationMs: 222`, `topErrors[0]: Forbidden: bot was blocked by the user`.
  - `broadcast sent via telegram command` → `delivered: 2`, `failed: 3`.
- В tail нет событий `broadcast_watchdog*`, `broadcast pool aborted`, записей pause/resume или retry_after/oom для этого jobId. В чатах jobId не показывался.

## Диагностика после теста — `/admin/diag?q=broadcast`
- `totalRuns: 12`.
- `lastRun`: `requestedBy: "136236606"`, `recipients: 5`, `delivered: 2`, `failed: 3`, `throttled429: 0`, `durationMs: 222`, `startedAt: 2025-11-22T11:13:35.224Z`, `completedAt: 2025-11-22T11:13:35.446Z`, `status: "ok"`.
- `history`: содержит run на 204 мс (08:04) и текущий run на 222 мс (11:13). `progress: null` — активный чекпоинт не surfaced.

## Выводы
- Пул и лимитирование работают (2/5 доставлено, 3/5 — ожидаемые 403), перегрузки/429 нет.
- Pause/resume не отражены в `/diag` и в уведомлениях: нет карточки `progress`, команды `/status` и `/end` не отработали (таймаут).
- Подтверждение отправки не содержит `jobId`; оператор не видит идентификатор запуска и доступные команды.
