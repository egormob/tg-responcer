# Диагностика недоставленных рассылок (2025-11-16)

## Наблюдения
- Источник получателей теперь явно фиксируется: для `BROADCAST_RECIPIENTS` логируется `broadcast using env recipients`, для реестра D1/KV — `broadcast using registry recipients`, с fallback в `env_fallback` и пометкой `source` в итоговых метриках пула.
- Каждый запуск `/broadcast` логирует `broadcast recipients resolved` с выборкой chatId/username и фильтрами (`all` -> `filters: null`), а затем `broadcast deliveries recorded` с `delivered/failed`. Если список пуст, фиксируется `broadcast recipients list is empty` и отправка не стартует.
- Лог `broadcast pool completed/aborted` теперь содержит `filters` и `source`, что позволяет подтвердить создание задач в sender и статус доставки.
- Лимитер очереди `createQueuedMessagingPort` общий для диалогов и рассылок; добавлен предупреждающий лог `messaging quota queue backlog` при росте очереди (порог ≥ maxParallel). Это позволит заметить блокировки диалоговых ответов при массовых рассылках.

## Гипотезы и следующие шаги
- Если `source` фиксируется как `env` при включённом реестре — проблема в `recipients-store` (пустой результат или ошибка запроса); стоит проверить D1/KV и фильтры аудитории.
- При `filters: null` и ожидаемой аудитории список не должен быть пустым; появление лога `broadcast recipients list is empty` означает, что фильтрация/реестр вернули 0 записей.
- Появление частых `messaging quota queue backlog` вместе с замедлением ответов говорит о блокировке общего `MessagingPort`; актуальна задача разделить порты/лимиты для диалога и рассылок (см. карточку «Очередь отправки делит лимиты…»).

Связка с RoadMap: М8 (Broadcast Feature) — уточнение источника получателей, статусов доставок и влияния лимитера на рассылки.
