# Задача: добавить UTM-колонки в `/admin/export`

## Что сделать
1. Дополнить `SELECT` в `apps/worker-main/features/export/csv-export.ts` полем `u.utm_source` (и при необходимости вычисляемыми `utm_medium`, `utm_campaign`, `utm_content`).
2. Расширить заголовок CSV и сериализацию строк, обновить тест `csv-export.test.ts` с проверкой новых колонок.
3. Добавить парсер payload → `utm_*` (можно на Node перед экспортом или внутри SQL, если есть helper) и убедиться, что отсутствующие значения возвращают пустые строки.
4. Обновить документацию (`memory-bank/operations/export.md`, `memory-bank/references/telegram-deeplink-utm.md`, `RoadMap.md`) и контрольный CSV в `memory-bank/tests/2025-11-05-admin-export-check.csv`.
5. Прогнать `npm run test -- apps/worker-main/features/export/__tests__/csv-export.test.ts` и `npm run check:roadmap`.

## Быстрый старт
```sh
npm run task:checkout m7-export-utm-gap
```

> Команда создаст рабочую ветку `work/m7-export-utm-gap` от актуальной `work` и отметит задачу в журнале прогресса.
