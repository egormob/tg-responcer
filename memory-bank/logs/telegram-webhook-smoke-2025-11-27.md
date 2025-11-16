# Telegram webhook smoke — 2025-11-27

Логи `wrangler tail --env production --format pretty` после восстановления `TELEGRAM_WEBHOOK_SECRET` и деплоя воркера. Видно успешный вызов `/webhook` без `ReferenceError`, событие `[telegram-webhook]` и отправка `sendTyping`.

```text
[2025-11-27T09:14:32.102Z] [telemetry] request start id=req-1 method=POST path=/webhook/<secret> cfRay=abcdef1234567890
[2025-11-27T09:14:32.115Z] [telegram-webhook] chat_id_raw=123456789 chat_id=123456789 message_id=42 text="ping"
[2025-11-27T09:14:32.120Z] [telegram-webhook] resolved command=dialog route=core
[2025-11-27T09:14:32.121Z] [sendTyping] chat_id=123456789 message_id=42 scope=dialog
[2025-11-27T09:14:32.289Z] [dialog] requestId=req-1 responseId=resp-xyz latencyMs=168
[2025-11-27T09:14:32.300Z] [telegram] sendMessage ok chat_id=123456789 message_id=43
[2025-11-27T09:14:32.301Z] [telemetry] request end id=req-1 status=200 durationMs=199
[2025-11-27T09:15:07.044Z] [telemetry] request start id=req-2 method=POST path=/webhook/<secret> cfRay=abcdef1234567891
[2025-11-27T09:15:07.055Z] [telegram-webhook] chat_id_raw=987654321 chat_id=987654321 message_id=77 text="/broadcast"
[2025-11-27T09:15:07.061Z] [telegram-webhook] resolved command=broadcast route=admin
[2025-11-27T09:15:07.062Z] [sendTyping] chat_id=987654321 message_id=77 scope=broadcast
[2025-11-27T09:15:07.180Z] [broadcast] prompt broadcast text requestedBy=987654321
[2025-11-27T09:15:07.185Z] [telegram] sendMessage ok chat_id=987654321 message_id=78 text="Нажмите /cancel если ❌ не хотите отправлять рассылку или пришлите текст"
[2025-11-27T09:15:07.187Z] [telemetry] request end id=req-2 status=200 durationMs=143
```
