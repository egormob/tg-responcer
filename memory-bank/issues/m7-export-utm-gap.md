# Экспорт UTM-меток в CSV (`/admin/export`)

## Контекст
- Документация Майлстоуна М7.Ш8 требовала наличия колонок `utm_label`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_content` в CSV.
- Фактический обработчик `createCsvExportHandler` выгружает сообщения без агрегирования по диалогу и не добавляет `utm_*`-поля.
- Источник кампании сохраняется в таблице `users` (`utm_source`), но в экспорт не попадает, из-за чего BI не может сопоставить кампании с сообщениями.

## Проблема
- Памятка `memory-bank/operations/export.md` и справка по deeplink пересмотрены: UTM берём из `users.utm_source` вручную.
- Нужен кодовый фикс, который расширит экспорт и документацию, чтобы UTM попадали в CSV автоматически.

## Решение
1. Расширить SQL-запрос в `apps/worker-main/features/export/csv-export.ts`, добавив `u.utm_source` и производные поля.
2. При необходимости выполнить миграцию/расчёт производных (`utm_medium`, `utm_campaign`, `utm_content`) на лету.
3. Обновить тесты `csv-export.test.ts`, чтобы проверяли новые заголовки и значения.
4. Синхронизировать документы (`memory-bank/operations/export.md`, `memory-bank/references/telegram-deeplink-utm.md`, RoadMap).

## Кнопка быстрого старта
[▶️ Запустить фикс](../tasks/m7-export-utm-gap.md)

## Готовность
- Требуется разработка и ревью.
