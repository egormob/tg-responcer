# DIAG 2025-11-30 — broadcast + webhook tail

## Что сделано
- Очередь мгновенной рассылки и команда `/broadcast` активны, источник получателей — выборка D1 (таблица `users`).
- Pending-сессии переживают сброс `routerCache`: подтверждено хранением в KV и восстановлением сценария.
- Хвост `wrangler tail` зафиксировал успешный webhook и отправку broadcast без 429.

## Что осталось
- Синхронизировать обновлённую памятку по приёмке (чек-лист с доставкой по D1 и KV-логом pending-сессий).
- Повторять smoke `/broadcast` при изменении аудитории D1 или перезапуске воркера.

## План проверки
1. Выполнить `/admin/selftest` и убедиться, что `webhook` в статусе `ok`.
2. От whitelisted аккаунта отправить `/broadcast` → «ping»; ожидание D1 ≥3 получателей.
3. В tail увидеть:
   - `telegram webhook ok` / `status=200`.
   - `broadcast recipients resolved` с `source=d1`, `recipients=3` (или больше).
   - `broadcast pool completed` с `delivered>0`, `failed=0`, `throttled429=0`.
4. Проверить KV pending-ключи: отсутствие зависших записей после завершения (`broadcast:pending:*` очищены).

## Tail успешного webhook и broadcast
```
2025-11-30T09:58:12.004Z [telemetry][webhook] status=200 route=/webhook/<secret> chatId=123456789 chatType=private
2025-11-30T10:00:03.117Z [broadcast] broadcast recipients resolved source=d1 recipients=3 requestedBy=123456789
2025-11-30T10:00:05.842Z [broadcast] broadcast pool completed delivered=3 failed=0 throttled429=0 durationMs=2643
```

## Привязки и ссылки
- Использовать этот отчёт как якорь для финальной проверки М8 и обновления памятки минимальной рассылки.
- Для повторных прогонов tail фиксировать новые блоки под этим отчётом, чтобы сохранять сквозную историю.
