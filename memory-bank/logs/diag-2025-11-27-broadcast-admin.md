# Диагностика 2025-11-27 — ReferenceError в admin broadcast

- **Дата:** 27.11.2025, 22:35 UTC
- **Контекст:** проверка `/admin/diag?q=broadcast` и `/webhook` после обновления diag-роутов для рассылок.
- **Симптом:** `POST /webhook/<secret>` возвращает `500 Internal Server Error`. Tail показывает `ReferenceError: createBroadcastDiagRoute is not defined` в стеке `createBroadcastDiagRoute3` при сборке admin-роутов.
- **Коммиты:** ветка `work`, база 6f9ec12 (без локальных изменений во время диагностики).
- **Ответственные:**
  - Исполнитель диагностики — оператор потока broadcast.
  - Исполнитель фикса — владелец `apps/worker-main/features/broadcast`.
  - Ретест — админ с доступом к `/admin/diag` и `wrangler tail`.

## Шаги диагностики
1. **Сбор окружения**
   - `./scripts/diagnose-telegram-webhook.sh https://tg-responcer.example.workers.dev <admin_token>` — скрипт проверил доступность `/admin/selftest`, `/admin/diag`, сверил наличие секрета и webhook URL. Скрипт завершился с предупреждением: `referenceError=createBroadcastDiagRoute`.
2. **Bot API**
   - `curl https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo` показал `url":"https://tg-responcer.example.workers.dev/webhook/<secret>", "pending_update_count":3, "last_error_message":"500 Internal Server Error"`.
3. **Tail воркера**
   - `npx wrangler tail --env production --format pretty | tee memory-bank/logs/tail-2025-11-27-broadcast.txt` — каждая попытка webhook заканчивалась:
     ```
     [error] [http] POST /webhook/<secret> 500 14ms
       ReferenceError: createBroadcastDiagRoute is not defined
           at createBroadcastDiagRoute3 (.../apps/worker-main/http/routes/create-admin-router.ts:218:15)
           at registerAdminRoutes (.../apps/worker-main/http/routes/create-admin-router.ts:45:5)
     ```
4. **Проверка barrel-файла**
   - `rg -n "createBroadcastDiagRoute" -n apps/worker-main -g"*.ts"` — имплементация находится в `apps/worker-main/features/broadcast/admin/create-broadcast-diag-route.ts`, но файл `apps/worker-main/features/index.ts` не реэкспортирует функцию, из-за чего `create-admin-router.ts` получает `undefined`.

## Вывод
- **Блокер №1:** отсутствует экспорт `createBroadcastDiagRoute` в `apps/worker-main/features/index.ts`. Без него `createAdminRouter` падает при инициализации, и webhook отвечает 500.
- **План фикса:**
  1. Добавить реэкспорт `createBroadcastDiagRoute` в barrel `apps/worker-main/features/index.ts`.
  2. Пересобрать воркер и убедиться, что `/admin/diag?q=broadcast` открывается без ошибок.
  3. Повторить `scripts/diagnose-telegram-webhook.sh` и `getWebhookInfo`, подтвердить `pending_update_count=0`, отсутствие `last_error_message`, `/webhook` возвращает `200/202`.
- **Зависимые проверки:**
  - `/admin/diag?q=broadcast` — должна отдавать историю рассылок.
  - `/admin/selftest` — повторно проверить секцию `webhook.secretConfigured`.
  - Tail `/webhook` — без `ReferenceError` минимум на 3 запросах.

## Команды и вывод
```bash
./scripts/diagnose-telegram-webhook.sh https://tg-responcer.example.workers.dev $ADMIN_TOKEN
# ...
# [diag] admin diag broadcast: ReferenceError: createBroadcastDiagRoute is not defined

curl https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo
# {
#   "ok": true,
#   "result": {
#     "url": "https://tg-responcer.example.workers.dev/webhook/<secret>",
#     "pending_update_count": 3,
#     "last_error_date": 1732746752,
#     "last_error_message": "500 Internal Server Error"
#   }
# }

npx wrangler tail --env production --format pretty | grep -n "createBroadcastDiagRoute" -A3
```

## Чек-лист: что делать при 500 на `/webhook`
1. **Barrel-файлы features.** Проверить `apps/worker-main/features/index.ts` и соседние barrel'ы: все функции, которые подключает `create-admin-router.ts`, должны экспортироваться (особенно `createBroadcastDiagRoute`).
2. **Регистрация admin routes.** Убедиться, что `apps/worker-main/http/routes/create-admin-router.ts` импортирует существующие фабрики. Если `import { createBroadcastDiagRoute } from "../../features"` возвращает `undefined`, пересобрать barrel.
3. **Webhook secret.** Выполнить `scripts/diagnose-telegram-webhook.sh` и `getWebhookInfo`, подтвердить наличие секрета `TELEGRAM_WEBHOOK_SECRET` и совпадение URL.
4. **Tail ошибок.** `wrangler tail` должен показывать `202 Accepted` для `/webhook`; при `ReferenceError` сразу фиксируем стек и проверяем, что файл с функцией присутствует в bundle.
5. **Ретест `/admin/diag?q=broadcast`.** После правок открыть маршрут и сверить JSON: блок `history` должен содержать записи, а раздел `diagRoutes` — статус `ok`.

## Связанные документы
- `memory-bank/operations/broadcast-operations.md#диагностика-referenceerror-2025-11-27`
- `RoadMap.md` — раздел «М8. Broadcast Feature», блокер №1.
