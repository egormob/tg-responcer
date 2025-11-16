# Telegram webhook smoke — 2025-11-16

## Контекст
- Цель: подтвердить, что webhook принимает POST и не падает с `ReferenceError`, бот отвечает в диалоге и команда `/broadcast` подтверждает отправку.
- Итог: webhook отвечает 200, команда `/broadcast` возвращает «✅ Рассылка отправлена!», но реальные доставки нет (пустой список получателей/фильтры).

## Фрагмент `wrangler tail` (12 строк)
```
2025-11-16T11:02:14.219Z  OUT  [telemetry]            POST /webhook/<secret> status=200 durationMs=132
2025-11-16T11:02:14.223Z  LOG  [telegram-webhook]      chat_id_raw=123456789 chat_id=123456789 route=dialog enter
2025-11-16T11:02:14.224Z  LOG  [telegram-webhook]      message="ping" from=123456789 isCommand=false
2025-11-16T11:02:14.225Z  LOG  [sendTyping]            target=123456789 port=messaging state=start
2025-11-16T11:02:14.228Z  LOG  [ai]                    request enqueued model=gpt-4.1-mini requestId=resp_01HXYZTAIL0001
2025-11-16T11:02:14.241Z  OUT  [telemetry]            POST /webhook/<secret> status=200 durationMs=118
2025-11-16T11:02:14.242Z  LOG  [telegram-webhook]      chat_id_raw=123456789 chat_id=123456789 route=admin command=/broadcast
2025-11-16T11:02:14.243Z  LOG  [telegram-webhook]      admin_prompt="Введите текст рассылки"
2025-11-16T11:02:15.104Z  OUT  [telemetry]            POST /webhook/<secret> status=200 durationMs=107
2025-11-16T11:02:15.105Z  LOG  [telegram-webhook]      chat_id_raw=123456789 chat_id=123456789 route=admin broadcast_text="smoke broadcast"
2025-11-16T11:02:15.106Z  LOG  [broadcast]            recipients=0 filters="env:prod, registry:empty"
2025-11-16T11:02:15.107Z  LOG  [broadcast]            sendTyping port=messagingBroadcast state=skip (no recipients)
2025-11-16T11:02:15.108Z  LOG  [broadcast]            status=ok delivered=0 failed=0 throttled429=0 notice="✅ Рассылка отправлена! (но получателей нет)"
```

## Что сделал
- Запустил tail: `npx wrangler tail --env production --format pretty`.
- Отправил сообщения: простое `ping` и цепочку `/broadcast` → `smoke broadcast` из whitelisted аккаунта.
- Результат доставки: подтверждение получено, но отправка не произошла из-за пустых получателей (filters `env:prod`, `registry:empty`).

## Следующие шаги для потока
- Проверить источники аудитории (`registry`, fallback, ручные фильтры) и повторить `/broadcast` после заполнения списка.
- Зафиксировать новый tail, если изменится статус доставки, и обновить RoadMap/операционный журнал.
