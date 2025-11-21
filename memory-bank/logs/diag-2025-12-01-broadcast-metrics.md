# DIAG 2025-12-01 — broadcast metrics & text limits

## Контекст
- Два последовательных вызова `GET /admin/diag?q=broadcast` с `X-Admin-Token: devadmintoken` отработали с HTTP 200 и `status: "ok"`, `feature: "broadcast_metrics"`.
- Фича рассылки в бою: выбран D1-реестр на 5 получателей, отправка шла в один поток через пул воркера без ошибок очереди ИИ.

## Наблюдения
1. Метрики первого вызова: `totalRuns: 1`, `requestedBy: "136236606"`, `recipients: 5`, `delivered: 2`, `failed: 3`, `throttled429: 0`, `durationMs: 194`, `status: "ok"`.
2. Метрики второго вызова: `totalRuns: 2`, `lastRun` совпадает по параметрам (`recipients: 5`, `delivered: 2`, `failed: 3`, `throttled429: 0`, `durationMs: 195`), `history` содержит обе записи.
3. Лимит текста срабатывает: первый текст отклонён `broadcast text rejected` (`reason: "too_long"`, `rawLength=visibleLength=4085`, `limit: 3970`, `exceededBy: 115`), после чего состояние перешло в `broadcast awaiting new text`.
4. Новый текст собирался чанками (`broadcast text chunk collected` ×2: `rawLength 2` и `3`), затем `broadcast awaiting send confirmation` с `total: 5`; подтверждение зафиксировано событием `broadcast dispatch confirmed via telegram command` для `userId/chatId: "136236606"`.
5. Сессия состояний: `broadcast pending metrics` (`activePending=0`, `expiredPending=0`) → `broadcast awaiting audience selection` (`userId/chatId: "136236606"`) → `broadcast awaiting text` (`mode: "all"`, `total: 5`, `notFound: []`).
6. Получатели выбраны из D1: события `broadcast using registry recipients` и `broadcast_resolve` с `source: "D1"`, `recipients: 5` и выборкой чатId (`136236606`, `100596580`, `174401059`, `548415437`, `270641809`).
7. Пул отправки: `broadcast pool initialized` (`poolSize: 4`, `maxAttempts: 3`, `baseDelayMs: 1000`, `jitterRatio: 0.2`, `maxRps: 28`, `rateJitterRatio: 0.1`).
8. Доставка: `broadcast delivered` для `136236606` и `270641809` при `attempt: 1`; ошибки: три `broadcast delivery failed` с `TelegramApiError: Forbidden: bot was blocked by the user` для `100596580`, `174401059`, `548415437`.
9. Сводки: `broadcast_summary` ×2 (`recipients: 5`, `delivered: 2`, `failed: 3`, `throttled429: 0`, `durationMs: 194/195`, `source: "D1"`, `topErrors[0].message: "Forbidden: bot was blocked by the user"`) → `broadcast sent via telegram command` (`userId: "136236606"`, `delivered: 2`, `failed: 3`).
10. Очередь ИИ в этих запросах читает KV-конфиг `AI_QUEUE_CONFIG`: `maxConcurrency: 4`, `maxQueueSize: 64`, `requestTimeoutMs: 18000`, `retryMax: 3`, `baseUrls` — два `/v1/responses`; все значения имеют пометку `source: "kv"`. Ошибок воркера или очереди ИИ не наблюдается, HTTP-ответы 200.

## Итоги
- Поток «новый текст → подтверждение → отправка» работает штатно, лимит видимой длины 3970 символов срабатывает и возвращает пользователя к вводу.
- Рассылка по D1-реестру проходит без троттлинга: 5 адресатов, 2 доставки, 3 отказа из-за блокировок бота пользователями, повторные метрики фиксируются в истории без расхождений.
- Конфигурация AI Queue стабильна и считывается из KV, активных/очередных задач нет, ошибок воркера не зафиксировано.

## Артефакты
- Диагностика `/admin/diag?q=broadcast` (2 прогона подряд) и tail логов событий `broadcast*`.
