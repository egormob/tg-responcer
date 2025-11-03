# Cloudflare Resources Checklist

## Текущее состояние
- База Cloudflare D1 `tg-responcer-db` создана и должна быть привязана к воркеру под биндингом `DB` (database_id `d9f40a7d-5f9f-4b8b-9e61-cf96a94d3b86`). Cloudflare блокирует деплой, если база отсутствует в целевом аккаунте.
- KV namespace для лимитов создаётся как `RATE_LIMIT`, привязывается к воркеру под `RATE_LIMIT_KV`.
- Актуальный Namespace ID для `RATE_LIMIT_KV`: `d03442f14f7e4a64bb1d7896244a0d3f` (проверено в [Cloudflare Dashboard → Workers → tg-responcer → Settings → KV Namespaces](https://dash.cloudflare.com/?to=/:account/workers-and-pages/view/tg-responcer/settings#kv-namespaces)).
- Модуль `DialogEngine` и контракты портов работают на заглушках, внешние ресурсы не требуются для локальных тестов.
- Подготовлена миграция D1 `apps/worker-main/migrations/0001_init_dialog_tables.sql` для таблиц `users` и `messages`.

## Минимальные требования к окружению воркера
- **Обязательные переменные окружения:**
  - `OPENAI_MODEL` и `OPENAI_API_KEY` — используются при инициализации `createOpenAIResponsesAdapter`, их отсутствие приводит к немедленному завершению `validateRuntimeConfig` с ошибкой ещё до сборки портов. См. `apps/worker-main/index.ts`.
  - `TELEGRAM_BOT_TOKEN` — передаётся в `createTelegramMessagingAdapter` и требуется для отправки любых ответов в Telegram. См. `apps/worker-main/index.ts` и адаптер `apps/worker-main/adapters/telegram`.
  - `TELEGRAM_WEBHOOK_SECRET` — проверяется роутером при каждом запросе `POST /webhook/...`; без значения воркер возвращает `500 Webhook secret is not configured`. См. `apps/worker-main/http/router.ts`.
- **Обязательные биндинги:**
  - `DB` — подключается к `createD1StorageAdapter`; без привязки база не используется, а экспорт и хранение истории недоступны. См. `apps/worker-main/index.ts` и адаптер `apps/worker-main/adapters/d1-storage`.
  - `RATE_LIMIT_KV` — требуется `createKvRateLimitAdapter` и `createRateLimitNotifier` для подсчёта и уведомлений о лимитах. См. `apps/worker-main/index.ts` и адаптер `apps/worker-main/adapters/kv-rate-limit`.

### Процедура проверки наличия значений
1. После раскатки секретов выполните `GET /admin/envz` с валидным `x-admin-token`: маршрут `createEnvzRoute` отображает факты наличия (`true/false`) для ключевых переменных и биндингов, в том числе `telegram_bot_token`, `openai_model`, `db_bound`, `rate_limit_kv_bound`.
2. Сразу после `wrangler deploy` проверьте блок `Bindings:` в выводе CLI либо в разделе Cloudflare Workers → Settings → Variables, убеждаясь, что присутствуют `DB` и `RATE_LIMIT_KV` с ожидаемыми ресурсами.

### Диагностика отказа
- Если `OPENAI_API_KEY`, `OPENAI_MODEL` или `TELEGRAM_BOT_TOKEN` отсутствуют либо содержат пустые строки, `validateRuntimeConfig` логирует `[config] ... is required` и выбрасывает `Missing ... environment variable`. Из-за этого `createRequestHandler` не доходит до `createTypingIndicator`, а вызов `/webhook/...` завершится `500 Internal Error` ещё до попытки отправки `typing` в Telegram. Проверяйте логи воркера: `console.error('[config] OPENAI_API_KEY is required')`, `console.error('[config] OPENAI_MODEL is required')`, `console.error('[config] TELEGRAM_BOT_TOKEN is required')`.
- Отсутствующий `TELEGRAM_WEBHOOK_SECRET` приводит к ответу `500 Webhook secret is not configured` на входящий webhook до обработки сообщения, что фиксируется в логах маршрута.

## Предстоящие действия
- При реализации адаптера Telegram (`Майлстоун 3`) потребуется подготовить секреты `TELEGRAM_BOT_TOKEN`, `WEBHOOK_SECRET`.
- Для подключения OpenAI Responses (`Майлстоун 4`) понадобятся секреты `OPENAI_API_KEY`, `OPENAI_MODEL`, опционально `OPENAI_PROMPT_ID` (`pmpt_…`) и `OPENAI_PROMPT_VARIABLES` (JSON). Перед деплоем проверить, что значения обрезаны (`trim()`) и валидируются на стороне воркера.
- Перед стартом `Майлстоун 5` (D1 Storage Adapter) необходимо создать базу D1 и выполнить миграции согласно спецификации хранения диалогов (`wrangler d1 migrations apply DB`).
- Лимиты (`Майлстоун 6`) потребуют KV namespace `RATE_LIMIT_KV` и флаг `LIMITS_ENABLED`.
- **М1.Шаг 3 — План ревизии модулей:**
  - `apps/worker-main/adapters/d1-storage`
    - *Риски:* несохранённый `previous_response_id`, расхождение схемы хранения сообщений с форматом Responses.
    - *Проверки перед активацией:* ревью миграций D1, прогон интеграционных тестов экспорта истории, подтверждение, что `response_id` попадает в таблицу сообщений и используется в `StoragePort`.
  - `apps/worker-main/features/export`
    - *Риски:* CSV без `response_id`/`model`, отсутствие экранирования при длинных ответах.
    - *Проверки:* smoke `/admin/export` с длинными сообщениями, сверка колонок с требованиями Responses-only, фиксация успешного результата в журнале деплоя.
  - `apps/worker-main/features/limits` и `apps/worker-main/adapters/kv-rate-limit`
    - *Риски:* рассинхронизация уведомлений об ошибках лимитов с новым AI-контуром, появление прямых зависимостей от конкретного промпта.
    - *Проверки:* ревью шаблонов уведомлений, тесты на ветку `LIMITS_ENABLED=true`, подтверждение отсутствия зависимостей от `assistantId` в коде и тестах.
  - `apps/worker-main/features/broadcast`
    - *Риски:* массовые рассылки без троттлинга, неподготовленный KV-флаг `BROADCAST_ENABLED`, нераспределённые токены `ADMIN_BROADCAST_TOKEN`.
    - *Проверки:* модульные тесты на раздачу батчей, ручной прогон на staging с 2–3 пользователями, контроль `retry_after`, проверка включения флага и выдачи токена.
  - `apps/worker-main/features/observability` и админ-диагностика (`apps/worker-main/http/admin/*`)
    - *Риски:* метрики, завязанные на старые поля (`assistantId`, `completion_id`), отсутствие requestId в логах.
    - *Проверки:* smoke `npm run test -- logger`, ручная проверка логов `wrangler tail`, обновление документации по алертам.
  - Документация (`memory-bank/openai-responses-prompt.md`, `memory-bank/operations.md`)
    - *Риски:* устаревшие чек-листы деплоя, отсутствие сценария отката.
    - *Проверки:* ревью памяток перед деплоем Responses-only, фиксация чек-листа в `logs/`.

Обновляй чек-лист по мере продвижения и сообщай менеджеру, когда возникает потребность в конкретном ресурсе для проверки или деплоя.

## Журнал секретов
- 2025-11-04 — попытка добавить `OPENAI_MODEL` и `OPENAI_PROMPT_VARIABLES` через `wrangler secret put` (ответственный: gpt-5-codex). Заблокировано политикой npm (`403 Forbidden` на пакет `wrangler`), секреты не созданы; требуется доступ к Cloudflare окружению и разрешение на установку `wrangler`.

## Журнал Cloudflare D1
- 2025-11-05 — создана база `tg-responcer-db` (database_id `d9f40a7d-5f9f-4b8b-9e61-cf96a94d3b86`), привязана к воркеру как binding `DB` (ответственный: gpt-5-codex). Проверка доступности `wrangler d1 execute DB --command "SELECT 1"` не выполнена: отсутствуют учётные данные Cloudflare в изолированной среде, требуется повторить команду в рабочем окружении.
- 2025-11-05 — при деплое через `wrangler versions upload` получена ошибка `binding DB of type d1 must have a database that already exists`. Решение: создать или подтвердить существование `tg-responcer-db` в целевой среде перед публикацией (см. `memory-bank/issues/cloudflare-env-reset.md`).
