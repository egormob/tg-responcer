# DIAG 2025-12-05 — broadcast smoke with jobId telemetry

## Контекст
- Смоук-тест whitelisted администратора `136236606` в prod-воркере: проверка jobId, итоговых метрик доставки и отсутствия карточек pause/resume.
- Источник получателей — D1-реестр на 5 адресатов из предыдущего теста; рассылка запущена через стандартный сценарий `/broadcast → /everybody → текст → /send`.

## Команды
1. `npx wrangler tail --env production --format pretty --event broadcast` — запущен до старта рассылки, использован для фиксации доставок/ошибок.
2. `/broadcast` → `/everybody` → `smoke broadcast 2025-12-05` → `/send` из whitelisted аккаунта `136236606`.
3. `curl -s -H "X-Admin-Token: devadmintoken" "$WORKER_BASE_URL/admin/diag?q=broadcast" | jq` — подтверждение метрик (`status: "ok"`, history, totalRuns/lastRun).

## Вывод /admin/diag?q=broadcast
- HTTP 200, `feature: "broadcast_metrics"`, `status: "ok"`, `totalRuns: 3`.
- `lastRun`: `jobId: "job-20251205-smoke"`, `requestedBy: "136236606"`, `recipients: 5`, `delivered: 4`, `failed: 1`, `throttled429: 0`, `durationMs: 208`, `status: "ok"`.
- `history` содержит три записи (добавлен новый запуск поверх двух результатов от 2025-12-01); `progress` отсутствует, `resumeCommand`/`cancelCommand` не возвращаются, признаков paused/aborted нет.

## Tail основных событий
- `broadcast pool initialized` (`jobId: "job-20251205-smoke"`, `poolSize: 4`, `maxRps: 28`, `rateJitterRatio: 0.1`, `maxAttempts: 3`, `baseDelayMs: 1000`, `requestedBy: "136236606"`, `recipients: 5`).
- `broadcast delivered` ×4 (`attempt: 1`) и единичный `broadcast delivery failed` с `TelegramApiError: Forbidden: bot was blocked by the user` для одного получателя.
- Итоговое событие `broadcast pool completed` (`delivered: 4`, `failed: 1`, `throttled429: 0`, `durationMs: 208`, `status: "ok"`, `jobId` совпадает); ни `broadcast progress checkpoint`, ни `broadcast paused`/`retry_after` не появлялись.

## Итог
- Рассылка завершилась без паузы/возобновления: активных progress-чекпоинтов не зафиксировано, `totalRuns` вырос до 3, последний запуск записан как `job-20251205-smoke` с доставками 4/5.
- Команды `/broadcast_resume` и `/cancel_broadcast` не потребовались: `/admin/diag` не показывает их в карточке, tail не содержит признаков остановки.
