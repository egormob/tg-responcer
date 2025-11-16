# Telegram webhook diagnostics — 2025-11-16

## Контекст
Ожидалось выполнить чек-лист восстановления вебхука: подтвердить наличие `TELEGRAM_WEBHOOK_SECRET` через `wrangler secret list`, при необходимости загрузить его (`wrangler secret put`), задеплоить воркер и обновить URL вебхука (`https://<worker-domain>/webhook/<secret>`). В песочнице отсутствует установленный `wrangler`, а скачивание CLI блокируется политикой окружения.

## Ход работ
1. Попытка установить `wrangler` из npm завершается запретом доступа, поэтому команды `wrangler secret list/get` недоступны:
   ```bash
   $ npm install wrangler
   npm error 403 403 Forbidden - GET https://registry.npmjs.org/wrangler
   ```
2. Проверка окружения показала отсутствие `TELEGRAM_BOT_TOKEN` и `TELEGRAM_WEBHOOK_SECRET`, поэтому даже запуск `scripts/diagnose-telegram-webhook.sh` с ручными значениями невозможен — скрипт требует боевой токен для обращения к Bot API:
   ```bash
   $ env | grep -i TELEGRAM
   # (пусто)
   ```
3. С учётом отсутствия CLI и токенов `setWebhook`/`getWebhookInfo` не выполнялись, секрет не ротацировался, деплой воркера не запускался.

## Состояние на выходе
- Секрет `TELEGRAM_WEBHOOK_SECRET` по-прежнему не подтверждён: CLI недоступен, поэтому факт наличия в воркере неизвестен.
- URL вебхука не переустановлен, `getWebhookInfo` не обновлялся.
- Скрипт `scripts/diagnose-telegram-webhook.sh` не запускался из-за отсутствия требуемых переменных и `wrangler`.

## Рекомендации следующему потоку
1. Выполнить на рабочей станции с доступным `wrangler`:
   ```bash
   export WORKER_BASE_URL="https://tg-responcer.egormob.workers.dev"
   export TELEGRAM_BOT_TOKEN="<боевой_токен>"
   export TELEGRAM_WEBHOOK_SECRET="<актуальный_секрет>"
   scripts/diagnose-telegram-webhook.sh
   ```
2. После сохранения секрета не забыть `wrangler deploy`, затем повторить `curl https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo` и убедиться, что `url` указывает на `https://tg-responcer.egormob.workers.dev/webhook/<secret>` без `last_error_message`.
3. Зафиксировать результат в этом же каталоге логов и обновить `RoadMap.md` (раздел М8.Ш8), указав статус шага и ссылку на журнал.
