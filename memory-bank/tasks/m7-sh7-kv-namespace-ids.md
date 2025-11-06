# Задача: восстановить биндинги KV для админ-модуля (М7.Ш7)

> **Статус:** открыто — деплой 2025-11-06 упал из-за отсутствующего Namespace ID (`ADMIN_EXPORT_LOG`).

## Контекст
Шаг М7.Ш7 требует whitelist администраторов и журнал выгрузок в Cloudflare KV. После пересоздания namespaces в Dashboard ID изменились, но `wrangler.toml` продолжил ссылаться на старые значения, из-за чего публикация воркера завершается ошибкой `KV namespace ... not found`. Необходимо восстановить конфигурацию и зафиксировать процесс в памятках.

## Требования
1. Получить у менеджера актуальные namespace ID для `ADMIN_TG_IDS` и `ADMIN_EXPORT_LOG` (Dashboard → Workers → Settings → KV Namespaces).
2. Обновить `wrangler.toml`, подставив новые значения вместо `REPLACE_WITH_...`. Зафиксировать изменение в Git.
3. Выполнить `npx wrangler deploy --dry-run` либо `wrangler versions upload` в CI и убедиться, что в секции `Bindings` перечислены оба KV, и публикация проходит без ошибки 10041.
4. Прогнать `/admin status` и `/admin export` на стейдже: подтвердить, что whitelist и журнал (TTL 30 дней) работают. Проверить появление записи `log:<timestamp>:<userId>` в `ADMIN_EXPORT_LOG`.
5. Обновить `memory-bank/infrastructure.md` и `memory-bank/verification-protocol.md`, добавив правило запрашивать namespace ID перед стартом задач, использующих новые KV.
6. После успешного ретеста закрыть задачу и отметить прогресс в RoadMap (М7.Ш7).

## Артефакты
- Логи `wrangler deploy`/`wrangler versions upload` с успешным перечислением биндингов.
- Скриншот Dashboard с namespace ID (по запросу менеджера).
- Ответ `/admin status` (`admin-ok`) и запись в KV (`log:…`).
- Обновлённые документы (инфраструктурная памятка, быстрый протокол).
