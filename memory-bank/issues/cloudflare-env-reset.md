# Инцидент: сброс переменных Cloudflare и сбой биндинга D1

## Симптомы
- После каждого деплоя через Cloudflare Workers Dashboard исчезали plaintext-переменные `OPENAI_MODEL` и `OPENAI_PROMPT_VARIABLES`, приходилось заносить их вручную.
- При загрузке версии через `wrangler versions upload` деплой завершился ошибкой `binding DB of type d1 must have a database that already exists`.

## Диагностика
1. В `wrangler.toml` находился пустой блок `[vars]`, который Wrangler трактует как явное указание очистить все plaintext-переменные. После удаления блока значения перестали пропадать.
2. `OPENAI_PROMPT_VARIABLES` в воркере ожидались строкой, поэтому значения из Cloudflare UI (JSON-объект) игнорировались. Функция `parsePromptVariables` обновлена для поддержки объектов.
3. Ошибка деплоя Cloudflare возникла, когда биндинг `DB` ссылался на D1, которая ещё не создана в целевой среде. Wrangler останавливает публикацию, если база отсутствует.

## Решение
- Хранить значения `OPENAI_MODEL`, `OPENAI_PROMPT_ID`, `OPENAI_PROMPT_VARIABLES` только в Cloudflare UI/Secrets и не переопределять их через `[vars]` в `wrangler.toml`.
- В `apps/worker-main/index.ts` принимать `OPENAI_PROMPT_VARIABLES` как `unknown` и обрабатывать уже распарсенный объект (Cloudflare JSON), сохраняя поддержку строк.
- Перед каждым деплоем проверять, что D1 `tg-responcer-db` создана и привязана как `DB`; при необходимости выполнить `wrangler d1 create` и `wrangler d1 migrations apply`.

## Процедура ретеста
1. До деплоя открыть Cloudflare Workers → `tg-responcer` → Settings → Variables и зафиксировать значения `OPENAI_MODEL`, `OPENAI_PROMPT_VARIABLES`.
2. Выполнить `npx wrangler versions upload`. Убедиться, что предупреждение об изменениях подтверждено автоматически.
3. После деплоя снова проверить Variables (plaintext и JSON) и раздел Bindings (`DB`, `RATE_LIMIT_KV`). Значения должны сохраниться.
4. Зайти на `/admin/envz` с `ADMIN_TOKEN` и убедиться, что `OPENAI_*`, `DB`, `RATE_LIMIT_KV` отмечены как `OK`.
5. Задокументировать результат в журнале RoadMap и приложить вывод команд к verification-протоколу.

## Статус
- Обновление конфигурации и кода выполнено.
- Ретест ожидает запуска в боевой среде Cloudflare.
