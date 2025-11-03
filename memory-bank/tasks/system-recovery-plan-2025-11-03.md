# План восстановления продовой сборки (Cloudflare Workers)

## Цель
Восстановить стабильный деплой воркера `tg-responcer` с Responses-only контуром так, чтобы переменные окружения и биндинги Cloudflare сохранялись после публикации, а миграции D1 были применены.

## Последовательность шагов
1. **Инвентаризация Cloudflare ресурсов**
   - Проверить в Dashboard наличие D1 `tg-responcer-db` и KV namespace, привязанных как `DB` и `RATE_LIMIT_KV`.
   - Если ресурсы отсутствуют, создать их через `wrangler d1 create` / `wrangler kv:namespace create RATE_LIMIT` и привязать к воркеру.
   - Зафиксировать идентификаторы в `wrangler.toml` и `memory-bank/infrastructure.md`.

2. **Проверка и фиксация переменных окружения**
   - На странице Settings → Variables убедиться, что заполнены `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_PROMPT_ID`, `OPENAI_PROMPT_VARIABLES`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `ADMIN_TOKEN` и другие обязательные параметры.
   - Сохранить скриншот/экспорт значений и приложить ссылку в журнал проверки (`verification-protocol.md`).
   - Убедиться, что `OPENAI_PROMPT_VARIABLES` хранится как JSON-объект (Cloudflare UI) и что воркер его принимает (см. `apps/worker-main/index.ts`).

3. **Применение миграций на чистой базе**
   - Выполнить `wrangler d1 migrations apply DB` в рабочем окружении, убедиться в успешном создании таблиц `users` и `messages`.
   - Проверить наличие индекса `idx_messages_dialog_time` и каскадного удаления.
   - Сохранить вывод команды в журнал RoadMap.

4. **Проверка кода и конфигурации перед деплоем**
   - Запустить `npm install`, `npm run lint`, `npm test` и `npm run typecheck`.
   - Убедиться, что в `wrangler.toml` отсутствуют пустые блоки `[vars]`, а `database_id` совпадает с фактической D1.
   - Просмотреть `memory-bank/issues/cloudflare-env-reset.md` и подтвердить, что все рекомендации учтены.

5. **Деплой через Wrangler**
   - Выполнить `npx wrangler versions upload` или `wrangler deploy` из ветки `work`.
   - При предупреждении о несохранённых изменениях подтвердить публикацию (неинтерактивный режим уже настроен).
   - При ошибках Cloudflare повторить шаги 1–4 и обновить журнал дефектов.

6. **Пост-деплойный аудит**
   - Проверить сохранность переменных и биндингов в Cloudflare UI, выполнить `/admin/envz` и зафиксировать статус `OK` для `OPENAI_*`, `DB`, `RATE_LIMIT_KV`.
   - Сделать тестовый запрос в Telegram ( smoke ), убедиться в записи сообщений в D1.
   - Обновить `memory-bank/stable-builds.md` и журнал RoadMap с итогами.

7. **Мониторинг и ретест**
   - Через 24 часа подтвердить, что переменные не были очищены автоматически (сравнить со скриншотом).
   - При повторении проблемы открыть новую запись в `memory-bank/issues/` с ссылкой на текущий план и результаты ретеста.

## Ссылки
- Инцидент и диагностика: `memory-bank/issues/cloudflare-env-reset.md`.
- Чек-листы: `memory-bank/verification-protocol.md`, `memory-bank/active-stack-checks.md`, `memory-bank/infrastructure.md`.
- Дорожная карта: `RoadMap.md` (раздел «Протокол проверки»).
