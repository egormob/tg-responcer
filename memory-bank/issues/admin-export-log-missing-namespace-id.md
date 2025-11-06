# Инцидент: деплой сорвался из-за отсутствия Namespace ID `ADMIN_EXPORT_LOG`

## Симптомы
- 2025-11-06 `wrangler deploy` завершился ошибкой `KV namespace 'c1f1f219f9554f0a91ce0ed6f246d106' not found` (Cloudflare Build Log 11:35:04Z).
- В секции `Bindings` CLI отсутствует `ADMIN_TG_IDS`, а `ADMIN_EXPORT_LOG` ссылается на несуществующий namespace.
- Воркeр отображается «красным» в Dashboard, webhook недоступен.

## Диагностика
1. В `wrangler.toml` прописан устаревший Namespace ID `c1f1f219f9554f0a91ce0ed6f246d106`. После пересоздания KV в Dashboard ID изменился, но конфигурация в репозитории не обновлена.
2. `ADMIN_TG_IDS` добавлен как биндинг с заглушкой `REPLACE_WITH_ADMIN_TG_IDS_NAMESPACE_ID`. Пока значение не подставлено, воркер теряет whitelist администраторов и 30-секундный cooldown.
3. Документация не содержит инструкции требовать и фиксировать namespace ID при добавлении новых KV, поэтому инцидент повторяет ситуацию с `RATE_LIMIT_KV` (см. `memory-bank/issues/cloudflare-env-reset.md`).

## Решение
- Обновить `wrangler.toml`, подставив фактические namespace ID для `ADMIN_EXPORT_LOG` и `ADMIN_TG_IDS` из Cloudflare Dashboard → Workers → Settings → KV Namespaces. При отсутствии ID договориться с менеджером и заблокировать деплой до обновления.
- После обновления выполнить `npx wrangler deploy --dry-run` и убедиться, что CLI перечисляет оба KV в секции `Bindings`.
- Дополнить инфраструктурные памятки и быстрый протокол требованием фиксировать namespace ID перед стартом задач, затрагивающих KV.

## Ретест
1. Запросить у менеджера актуальные namespace ID и внести их в `wrangler.toml`.
2. Запустить `npx wrangler deploy` из CI/Cloudflare Build. В логах должна появиться строка `env.ADMIN_EXPORT_LOG (...) KV Namespace` без ошибок.
3. Отправить боту `/admin status` и `/admin export` — убедиться, что cooldown и логирование работают (запись появляется в `ADMIN_EXPORT_LOG`).
4. Зафиксировать результат в RoadMap (шаг М7.Ш7) и приложить лог `wrangler` к Verification Protocol.

## Статус
- Инцидент открыт.
- Требуется обновить namespace ID и повторить деплой.
