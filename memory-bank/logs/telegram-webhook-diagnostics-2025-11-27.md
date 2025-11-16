# Telegram webhook diagnostics — 27.11.2025

## Контекст и симптомы
- Админ и пользователь не видят typing-индикацию, команды (`/admin`, `/broadcast`, `/start`) не доставляются.
- Cloudflare роутер `createRouter.handleWebhook` отвечает `500 Webhook secret is not configured`/`403 Forbidden`, если `TELEGRAM_WEBHOOK_SECRET` отсутствует или не совпадает с сегментом `POST /webhook/<secret>`.
- Секрет входит в обязательный список (`wrangler.toml → CONFIG_REQUIRED_SECRETS`), поэтому обе роли ломаются одновременно.

## Попытки диагностики
1. Проверка через `npx wrangler secret list` недоступна — CLI не скачивается из-за запрета на обращение к registry.

```bash
$ npx wrangler secret list
npm warn Unknown env config "http-proxy". This will stop working in the next major version of npm.
npm error code E403
npm error 403 403 Forbidden - GET https://registry.npmjs.org/wrangler
npm error 403 In most cases, you or one of your dependencies are requesting
npm error 403 a package version that is forbidden by your security policy, or
npm error 403 on a server you do not have access to.
```

2. Прямая загрузка бинарника `wrangler` также блокируется (HTTP 403 на `github.com`).

```bash
$ curl -L -o /tmp/wrangler.tar.gz https://github.com/cloudflare/workers-sdk/releases/download/wrangler-v3.64.0/wrangler-v3.64.0-linux-x64.tar.gz
curl: (56) CONNECT tunnel failed, response 403
```

3. Без CLI невозможно подтвердить наличие `TELEGRAM_WEBHOOK_SECRET` и пересоздать webhook, поэтому задокументирован обходной путь: добавить скрипт `scripts/diagnose-telegram-webhook.sh`, который автоматизирует требуемые шаги и служит чек-листом для оператора, когда доступ к `wrangler` будет восстановлен.

## Следующие действия
1. На рабочей станции с доступным `wrangler` выполнить:
   ```bash
   export WORKER_BASE_URL="https://<worker>.workers.dev"
   export TELEGRAM_BOT_TOKEN="<bot_token>"
   export TELEGRAM_WEBHOOK_SECRET="<secret>"
   ./scripts/diagnose-telegram-webhook.sh | tee logs/telegram-webhook-diag-$(date +%Y%m%d-%H%M%S).log
   ```
2. После записи секрета запустить `wrangler deploy` и повторить `curl https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo` — поле `url` должно указывать на `https://<worker>/webhook/<secret>`, `last_error_message` пустое.
3. Сохранить лог запуска скрипта и вывод `getWebhookInfo` во внешнее хранилище, ссылка фиксируется в `memory-bank/logs/telegram-webhook-diagnostics-2025-11-27.md` (эта запись).
