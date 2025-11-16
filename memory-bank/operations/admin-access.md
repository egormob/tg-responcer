# Админ-доступ и диагностика

- Баррель `apps/worker-main/features/index.ts` обязан реэкспортировать публичный API `features/admin-access`, включая `createAdminCommandErrorRecorder`, `readAdminMessagingErrors`, `extractTelegramErrorDetails`, `shouldInvalidateAdminAccess` и связанные типы.
- Diagnostics-роут `/admin/access` использует `readAdminMessagingErrors` и должен продолжать отображать блок `adminMessagingErrors` после обновлений экспорта.
- При изменениях в `admin-messaging-errors` проверяй сборку воркера (`npx wrangler deploy --dry-run`) и запускай профильные тесты `npm test`, чтобы подтвердить, что диагностические записи продолжают собираться.
- `/admin/selftest?q=utm` выполняет быструю проверку сохранения UTM-меток через `StoragePort.saveUser` и чтения истории (`getRecentMessages`); успешный ответ — `200` с `{ test: 'utm', ok: true, utmDegraded: false }`.
- `/admin/diag?q=bindings` отображает подготовленные биндинги для `saveUser` и `getRecentMessages`, используя тот же `StoragePort`; при недоступности хранилища возвращает `500` с описанием ошибки.

## Self-test contract и внешняя проверка

- `/admin/selftest` всегда отвечает `200` и возвращает флаги `openAiOk`/`telegramOk`, строку `reason` при `false`, диагностический маркер `openAiMarkerPresent`, а также `lastWebhookSnapshot` с полями `route`, `chat_id`, `chatIdRaw`, `chatIdNormalized` и типом исходного значения.
- В Cloudflare-логах ожидаем ключи `route=…`, `chatIdRawType=…`, `chatIdNormalizedHash=…`, `sendTyping status=…`, `sendText status=…` для внешней сверки и подтверждения работы guards.
- Протокол ручной проверки: отправить `/start` из Telegram-клиента (отсутствие 400 от Bot API), выполнить `GET /admin/selftest?token=…`, затем проверить Cloudflare-логи на наличие перечисленных ключей и на отсутствие `400 Bad Request`.
- Отсутствие диагностического маркера OpenAI больше не приводит к `500`: self-test возвращает `openAiOk=false`, заполняет `reason` и оставляет остальные проверки доступными.

## Восстановление Telegram webhook

- Симптом регрессии: в чатах администратора и пользователя отсутствует даже typing-индикация, а `wrangler tail` фиксирует ответы `500 Webhook secret is not configured`/`403 Forbidden` на `POST /webhook/*`.
- Алгоритм диагностики:
  1. Выполнить `scripts/diagnose-telegram-webhook.sh` с заданными переменными `WORKER_BASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`. Скрипт проверяет наличие секрета через `wrangler secret list`, при отсутствии заливает его и выводит инструкции по повторному деплою.
  2. Скрипт автоматически вызывает `setWebhook` и `getWebhookInfo`, убеждаясь, что `url=https://<worker>/webhook/<secret>` и `last_error_message` пусты. Все ответы печатаются в STDOUT — сохраняем их в рабочий журнал.
  3. После ротации секрета вручную выполнить `wrangler deploy` (или `wrangler deploy --dry-run` для smoke) и повторить `curl https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo` при необходимости.
- Если CLI `wrangler` недоступен, фиксируем блокер в журнале и повторяем процедуру после восстановления доступа — без секрета бот не начнёт обрабатывать сообщения и не покажет typing.
