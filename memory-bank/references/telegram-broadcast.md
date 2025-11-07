# Справка: Telegram Broadcast

## Ограничения Telegram Bot API на редактирование и удаление
- `editMessageText` доступен только в течение 48 часов после отправки сообщения ботом. Попытки редактировать более старые сообщения приводят к ошибке `message can't be edited`. См. документацию Bot API по [`editMessageText`](https://core.telegram.org/bots/api#editmessagetext).
- `deleteMessage` может удалить сообщение для всех только в течение 48 часов после отправки. По истечении этого срока Telegram возвращает ошибку. См. документацию Bot API по [`deleteMessage`](https://core.telegram.org/bots/api#deletemessage).

## Коммуникация и ревизии
- 2025-11-11 — ограничения подтверждены и согласованы внутри команды. Источник: Bot API release notes и разделы документации, приведённые выше. Зафиксировано для последующих ревизий.
