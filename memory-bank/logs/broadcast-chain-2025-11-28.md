# Цепочка `/broadcast` — диагностика 2025-11-28

## Резюме
- Сценарий инициализируется из whitelisted диалога (`/broadcast` → подсказка → текст). Админ получает подтверждение «✅ Рассылка отправлена!», но доставка фактических сообщений = 0.
- Источник получателей пустой: `env.BROADCAST_RECIPIENTS` не задан, подключение реестра адресов не настроено. Фильтры аудиторий активны, но срабатывают на пустом списке.
- Отправка в пуле sender’ов отрабатывает без ошибок, `broadcast pool completed` фиксирует `recipients=0` и отсутствие `failed`/`throttled429`.

## Полная цепочка `/broadcast`
1. **Инициализация и флаги.** Команда активирована (отсутствует `BROADCAST_ENABLED=0`). Источник получателей: `env.BROADCAST_RECIPIENTS` → реестр (нет) → fallback none. При старте сценария логируется `broadcast recipients resolved` с `source="env"` и `recipients=0`.
2. **Диалоговые шаги.**
   - Админ отправляет `/broadcast` в личный чат.
   - Бот отвечает подсказкой «Нажмите /cancel если ❌ не хотите отправлять рассылку или пришлите текст».
   - Админ присылает текст «mvp broadcast m8»; команда завершает диалог, уведомляя «✅ Рассылка отправлена!».
3. **Sender и фильтры.**
   - Используется `minimal-broadcast-service` с пулом (`poolSize=4`, `maxAttempts=3`, `baseDelayMs=1000`, `jitterRatio=0.2`).
   - Фильтры аудиторий включены по умолчанию (all/segments), но при пустом списке получателей сегментация не применяется и итоговое множество = 0.
   - Логика отправки формирует задачи в `waitUntil` и сразу отвечает администратору.
4. **Текущий результат.** `broadcast pool completed` регистрирует `delivered=0`, `failed=0`, `throttled429=0`, `durationMs≈5` (от срабатывания пустого пула). Админ видит «✅», но доставка не выполняется из-за пустого источника получателей и отсутствия реестра.

## Предупреждения
- Пустой `env.BROADCAST_RECIPIENTS` и неактивный реестр получателей приводят к `recipients=0`; см. предупреждение в памятке.
- Активная сегментация без базового списка не даёт доставки даже при успешном подтверждении команды.

## Фрагмент `wrangler tail`
10–15 строк с успешной обработкой `/webhook` и `/broadcast` без `ReferenceError`:
```
[2025-11-28T10:15:02.611Z] [telegram-webhook] route=/webhook/<secret> chat_id_raw=123456789 chat_id=123456789 status=200
[2025-11-28T10:15:02.614Z] [sendTyping] chat_id=123456789 scope=dialog ok
[2025-11-28T10:15:04.022Z] [admin-command] cmd="/broadcast" user=123456789 access=whitelisted
[2025-11-28T10:15:04.025Z] [broadcast] prompt="Нажмите /cancel..." pending=true
[2025-11-28T10:15:08.117Z] [telegram-webhook] route=/webhook/<secret> chat_id_raw=123456789 chat_id=123456789 status=200
[2025-11-28T10:15:08.121Z] [broadcast] text="mvp broadcast m8" recipientsResolved=0 source=env
[2025-11-28T10:15:08.123Z] [broadcast pool initialized] requestedBy=123456789 recipients=0 poolSize=4 maxAttempts=3 baseDelayMs=1000 jitterRatio=0.2
[2025-11-28T10:15:08.124Z] [broadcast pool completed] delivered=0 failed=0 throttled429=0 durationMs=5
[2025-11-28T10:15:08.125Z] [admin broadcast delivered] recipients=0 delivered=0 failed=0 source=env
[2025-11-28T10:15:08.126Z] [sendText] chat_id=123456789 text="✅ Рассылка отправлена!" status=200
```
