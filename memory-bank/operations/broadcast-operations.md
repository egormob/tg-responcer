# Broadcast Operations Guide

## Контур и зависимости
- HTTP-роут: `POST /admin/broadcast` (Cloudflare Worker).
- Telegram-команды: `/broadcast <text>`, `/broadcast_status <jobId?>`, `/broadcast_cancel <jobId>` (обрабатываются до ядра в `apps/worker-main/http/telegram-webhook`).
- Очередь и планировщик: `createInMemoryBroadcastQueue`, `createBroadcastScheduler`, прогресс отслеживается через `BroadcastProgressStore`.
- KV и биндинги: `ADMIN_TG_IDS`, `BROADCAST_ENABLED`, (опционально) `ADMIN_EXPORT_KV` для синхронизации whitelists.

## Флаги и токены
- `BROADCAST_ENABLED` — строковый флаг (`"1"`, `"true"`, `"enabled"`) включает маршрут и планировщик. Любое иное значение отключает обработку.
- `ADMIN_TOKEN` — базовый админ-токен. Используется для `/admin/*` и служит запасным значением для `/admin/broadcast`, если не задан специализированный токен.
- `ADMIN_BROADCAST_TOKEN` — отдельный токен для рассылок. Приоритет: если установлен и не пустой, роут `/admin/broadcast` принимает только его.
- `TELEGRAM_BOT_TOKEN` — обязателен для Telegram-команд и фактической отправки сообщений.
- `ADMIN_TG_IDS` — KV-namespace с whitelisted Telegram ID. Команды `/broadcast*` доступны только перечисленным ID. Обновление списка требует синхронизации с `/admin/export`.
- `RATE_LIMIT_KV` — namespace, используемый планировщиком для троттлинга. Проверить, что namespace создан и привязан.

## Требования к админ-командам
1. **/broadcast**
   - Отправляет рассылку с текстом и опциональными фильтрами (`chatIds`, `userIds`, `languageCodes`). До внедрения сегментации обязательно указать хотя бы один `chatId`.
   - Команда конвертируется в запрос `POST /admin/broadcast` с заголовком `x-admin-token = ADMIN_BROADCAST_TOKEN` (или `ADMIN_TOKEN`) и `x-admin-actor = <telegram-username|id>`.
   - Ответ команды должен содержать `jobId`, время постановки и подсказку по статусу.
2. **/broadcast_status <jobId?>**
   - Без аргументов показывает последние активные задания для оператора.
   - С `jobId` возвращает прогресс (`queued`, `delivering`, `completed`, `failed`), счётчики получателей и таймстемпы. Источник данных — `BroadcastProgressStore`.
3. **/broadcast_cancel <jobId>**
   - Требует подтверждения (`Are you sure?`). Должен ставить признак отмены в прогресс-хранилище и останавливать планировщик для указанного задания.
   - Фолбек: если отмена невозможна (задание уже завершено), возвращать понятное сообщение и логировать попытку.

## Операционный чек-лист
1. **Подготовка окружения**
   - В `wrangler.toml` указать актуальные `kv_namespaces` для `RATE_LIMIT_KV` и `ADMIN_TG_IDS`.
   - Через `wrangler secret put` задать `ADMIN_TOKEN`, `ADMIN_BROADCAST_TOKEN`, `TELEGRAM_BOT_TOKEN`.
   - В KV `ADMIN_TG_IDS` добавить ID операторов рассылок (JSON-массив `{"ids":[123,456]}` или используемый формат).
   - Установить `BROADCAST_ENABLED=1` для включения контуров.
2. **Проверка HTTP-роута**
   - Выполнить `curl -X POST https://<worker>/admin/broadcast -H 'x-admin-token: <token>' -d '{"text":"ping","filters":{"chatIds":["<chatId>"]}}'`.
   - Ожидаемый ответ: `202 Accepted` с телом `{ "status": "queued", "jobId": "..." }`.
   - Проверить, что запрос с неверным токеном даёт `403` и логируется как предупреждение.
3. **Проверка Telegram-команд**
   - От whitelisted аккаунта отправить `/broadcast тест`. Ожидаемый ответ — `jobId` и подсказка.
   - От аккаунта вне whitelist — убедиться, что бот возвращает отказ без запуска очереди.
   - Выполнить `/broadcast_status` и `/broadcast_cancel <jobId>`; убедиться, что ответы соответствуют прогрессу и отмена фиксируется в логах.
4. **Мониторинг и восстановление**
   - Отслеживать логи `[broadcast]` в `wrangler tail`.
   - При ошибках доставки: использовать `/broadcast_status` для просмотра ошибок, повторить команду после устранения причины или поднять новое задание.
   - В случае зависшего задания воспользоваться `/broadcast_cancel` и удалить блокирующие записи из `BroadcastProgressStore` по инструкции.

## Требования к журналированию
- Каждая рассылка должна создавать запись в журнале прогресса (`memory-bank/stable-builds.md` или соответствующий лог) с датой, `jobId`, фильтрами и оператором.
- В случае использования временных обходов (ручной KV reset, очистка очереди) обязательна запись с описанием действий и ссылками на логи.

## Следующие шаги
- Добавить автоматизированные smoke-тесты HTTP-роута и Telegram-команд в CI (`npm run test -- --run apps/worker-main/http/__tests__/router.test.ts`).
- Рассмотреть миграцию очереди на Cloudflare Queues после подтверждения устойчивости in-memory реализации.
