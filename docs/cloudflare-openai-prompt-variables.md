# Cloudflare: стабильность `OPENAI_PROMPT_VARIABLES`

## Контекст
- Переменная `OPENAI_PROMPT_VARIABLES` пока не используется воркером, но проверяется `/admin/envz` как обязательная: она должна находиться в разделе **Secrets** Cloudflare.
- Cloudflare Dashboard сбрасывает plaintext/JSON-переменные, если они не объявлены в `wrangler.toml`. Поэтому для `OPENAI_PROMPT_VARIABLES` используем только Secrets.
- Хранение пустого объекта `{}` остаётся валидной конфигурацией: адаптер OpenAI передаст пустой `variables`, что эквивалентно отсутствию параметров и не вызывает ошибок `AI_NON_2XX`.

## Как задать значение и не потерять его при деплое
1. Выполнить в репозитории `scripts/bootstrap-cloudflare-secrets.sh` или вручную вызвать `wrangler secret put OPENAI_PROMPT_VARIABLES`.
2. На запрос ввода вставить JSON-объект (plain object), например `{}` или `{ "tone": "calm" }`. Cloudflare сохранит значение в Secrets и не будет сбрасывать его при деплоях.
3. После деплоя проверить `GET /admin/envz`: поле `openai_prompt_variables` должно быть `true`, даже если объект пустой.

## Типичные причины «отвала» переменной
| Причина | Симптомы | Как исправить |
| --- | --- | --- |
| Переменная сохранена в разделе **Vars** как plaintext | Dashboard показывает `OPENAI_PROMPT_VARIABLES` в секции `Text`, а после деплоя значение исчезает | Перенести значение в Secrets через `wrangler secret put` и удалить plaintext-вариант. |
| Значение задано строкой `""` или пробелами | `/admin/envz` показывает `false`, а Cloudflare стирает пустую строку | Сохранить валидный JSON-объект (`{}`), строку не использовать. |
| Деплой запущен из Dashboard → Upload/Versions | После публикации исчезают биндинги и plaintext-переменные, секреты не меняются | Деплоить только через `wrangler deploy`/`npx wrangler deploy` из репозитория. |

## Диагностика
1. Открыть Cloudflare → Workers → `tg-responcer` → Settings → Variables.
2. Убедиться, что `OPENAI_PROMPT_VARIABLES` отображается в секции **Secrets** как JSON (иконка `</>`).
3. После деплоя убедиться, что статус `/admin/envz` → `openai_prompt_variables: true`. Если значение `false`, пересохранить секрет и повторить деплой.
4. При ошибке `AI_NON_2XX` проверить Cloudflare Logs: переменная передаётся в OpenAI только при наличии, поэтому пустой `{}` не изменяет поведение модели.
