# Active Stack Checks (Responses-only)

## Назначение
Фиксация результатов проверки активной цепочки «Telegram → ядро → OpenAI Responses» в рамках майлстоуна 1 (шаг 1). Список покрывает компоненты, которые должны оставаться стабильными после перехода на `model`/`prompt`. Перед запуском сверяйся с `verification-protocol.md` для соблюдения общего протокола проверок и ведения журнала.

## Проведённые проверки

### `core/DialogEngine` и `ports/*`
- Диалоговый контур вызывает порты в порядке «rateLimit → storage.saveUser → storage.appendMessage(user) → messaging.sendTyping → ai.reply → storage.appendMessage(assistant) → messaging.sendText».
- Интерфейсы портов принимают только `model`/контекст, отсутствуют ссылки на `assistantId`.
- Тесты: `apps/worker-main/core/__tests__/DialogEngine.test.ts` и общий прогон `npm test`.

### `adapters/openai-responses`
- Формирует тело запроса с `model`, `input` и, при наличии, `prompt: { id, variables }`; `previous_response_id` извлекается из `metadata.responseId` в истории.
- Валидация переменных окружения (`OPENAI_MODEL`, `OPENAI_PROMPT_ID`, `OPENAI_PROMPT_VARIABLES`) и логирование `response_id` подтверждены код ревью.
- Тесты: `apps/worker-main/adapters/openai-responses/__tests__/openai-responses.test.ts` (запуск `npm test`).

### `http/telegram-webhook` и `adapters/telegram`
- `telegram-webhook.ts` обрабатывает бот-команды до вызова ядра и возвращает `HandledWebhookResult` для служебных обновлений.
- Messaging-адаптер использует ретраи/джиттер, очищает текст и не зависит от `assistantId`.
- Тесты: `apps/worker-main/http/__tests__/telegram-webhook.test.ts`, `apps/worker-main/http/__tests__/router.test.ts`, `apps/worker-main/adapters/telegram/__tests__/messaging.test.ts`.

### Регрессионные проверки `/broadcast`
- `/broadcast → admin command → dialog` не ломает цепочку: после завершения сценария команда возвращается к стандартной обработке сообщений без залипания в «ожидании текста»; автотесты покрывают ветки подтверждения отмены и отправки текста.
- Любые устаревшие подпотоки (`/broadcast queue`, `/broadcast http`, произвольные алиасы) отвергаются с явным ответом «не поддерживается», без попытки перехода в режим рассылки.
- При получении от Telegram `429` или внутреннего лимита бот отправляет администратору fallback с информацией о задержке (сценарий «Волин клик») и логирует событие.
- После изменений, затрагивающих рассылку, обязательно прогонять сценарий «Волин клик» по памятке `docs/telegram-admin-commands.md` и фиксировать результат в журнале.

### `composition/*` и typing-индикация
- `composeWorker` собирает порты из адаптеров или NOOP-реализаций, а `createRateLimitToggle` подключается только при наличии KV.
- `typing-indicator.ts` использует только `MessagingPort.sendTyping`, исключая параллельные индикаторы для одного чата.
- **Критерий:** typing-индикатор появляется не позже старта вызова ИИ и снимается без залипаний, подтверждая ранний тайпинг.
- Тесты: `apps/worker-main/composition/__tests__/compose.test.ts`, `apps/worker-main/http/__tests__/typing-indicator.test.ts`.

### Конфигурация окружения
- `apps/worker-main/index.ts` триммит `OPENAI_MODEL`, проверяет `OPENAI_PROMPT_ID` на префикс `pmpt_` и валидирует JSON-переменные, включая значения, которые Cloudflare отдаёт уже распарсенным объектом.
- Создание адаптеров зависит от наличия соответствующих биндингов (Telegram, D1, KV); перед деплоем обязательно проверяем в Cloudflare UI, что `DB` и `RATE_LIMIT_KV` привязаны и значения `OPENAI_*` не очищены (см. `memory-bank/issues/cloudflare-env-reset.md`).
- Тесты: покрытие через интеграционные тесты роутера и композиции (`npm test`).

## Команда для повторения проверки
- `npm test` — прогоняет витесты для всех перечисленных модулей.

## История запусков
- 2025-11-02 — `npm test` (успешно); запуск выполнен в ходе протокола проверки, см. журнал в `RoadMap.md` от 2025-11-02.
- 2025-11-01 — `npm test` (успешно); полный вывод сохранён в `logs/test-2025-11-01.txt`.
