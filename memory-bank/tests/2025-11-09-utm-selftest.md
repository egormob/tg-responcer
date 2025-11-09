# Внутренняя проверка `/admin/selftest?q=utm` — 2025-11-09

## Итог
- **Статус:** ✅ Пройдено.
- **Результат:** `StoragePort.saveUser/getRecentMessages` возвращают ожидаемые данные, `utmDegraded = false`, отчёт self-test завершается без ошибок.

## Использованные инструкции
- [memory-bank/operations/admin-access.md](../operations/admin-access.md) — раздел о диагностике `/admin/selftest`.
- [memory-bank/verification-protocol.md](../verification-protocol.md) — чек-лист фиксации артефактов self-test.

## Выполненные шаги
1. Подготовил заглушки портов (`AiPort`, `MessagingPort`, `StoragePort`) с поведением, идентичным production-контракту `StoragePort.saveUser`/`getRecentMessages`.
2. Запустил `createSelfTestRoute` с параметром `q=utm`, подтвердил статус `200` и успешные флаги `saveOk/readOk`.
3. Повторил прогон с новым timestamp, чтобы убедиться в устойчивости и уникальности `userId` (`admin:selftest:utm:<ts>`).
4. Сохранил оба JSON-ответа и запись проверки в `memory-bank/tests/`.

## Выходные артефакты
- Ответ self-test №1: [2025-11-09-utm-selftest-response-1.json](2025-11-09-utm-selftest-response-1.json).
- Ответ self-test №2: [2025-11-09-utm-selftest-response-2.json](2025-11-09-utm-selftest-response-2.json).

```json
{
  "test": "utm",
  "ok": true,
  "saveOk": true,
  "readOk": true,
  "utmDegraded": false,
  "errors": []
}
```

## Скриншоты
- Не снимались: проверка выполнялась в изолированном контейнере без доступа к веб-интерфейсу.

## Рекомендации
- При следующем запуске self-test на продовом воркере сохранить также лог `wrangler tail` для подтверждения записи в D1.
- Подтвердить `utm_source` выборкой `wrangler d1 execute ... SELECT user_id, utm_source FROM users WHERE user_id LIKE 'admin:selftest:utm:%'`.
