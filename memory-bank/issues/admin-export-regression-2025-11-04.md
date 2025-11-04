# Регрессия `/admin/export` на продовом воркере — 2025-11-04

## Сигналы
- `GET https://tg-responcer.egormob.workers.dev/admin/export?...` возвращает `404 Not Found`.
- `/admin/selftest?q=export` выдаёт `500` с ошибками `openai: missing diagnostic marker`, `telegram: chatId query parameter is required`.
- `/admin/envz` показывает `admin_export_token: false`, то есть секрет не привязан.

## Диагностика
1. В HTTP-роутере `/admin/export` работает только при настроенном `options.admin.export`. Он создаётся в `createAdminRoutes` при выполнении всех условий:
   - есть `ADMIN_TOKEN`;
   - задан `ADMIN_EXPORT_TOKEN` (не пустой);
   - привязан биндинг `DB`.
2. На проде отсутствует `ADMIN_EXPORT_TOKEN`, поэтому роутер отвечает `404` и экспорт недоступен.
3. Self-test зависит от диагностических параметров (`q=export` требует OpenAI маркера и `chatId`), которые не переданы — тестовый запрос запускался без обязательных query-параметров.

## Статус
- Майлстоун М7.Ш5 «внешняя проверка `/admin/export`» необходимо вернуть в работу: прод не подтверждён.
- Требуется восстановить секрет `ADMIN_EXPORT_TOKEN` и повторить внешнюю проверку.

## План восстановления
1. Создать или восстановить секрет `ADMIN_EXPORT_TOKEN` через `wrangler secret put ADMIN_EXPORT_TOKEN` (вводим токен вручную).
2. Убедиться, что `DB` привязан к воркеру (`wrangler d1 info <DB_NAME>`), иначе экспорт не соберётся.
3. Повторить `curl`-проверку и задокументировать результат в `memory-bank/tests/`.
4. Для self-test использовать корректные параметры (`/admin/selftest?q=export&chatId=<id>`), чтобы убедиться в прохождении цепочки OpenAI ↔ Telegram.

## Блокеры
- Без секретов экспорт не включится. Нужно снять блок до следующего майлстоуна.

