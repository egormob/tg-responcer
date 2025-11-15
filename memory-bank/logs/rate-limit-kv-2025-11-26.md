# RATE_LIMIT_KV — удаление кулдауна admin_export (26.11.2025)

## Контекст
- Цель — снять блокировку `/admin` после срабатывания лимитера `admin_export` (см. диагностическую карточку в `docs/operations/diagnostics.md`).
- Namespace `RATE_LIMIT_KV` привязан к воркеру с ID `d03442f14f7e4a64bb1d7896244a0d3f`.
- Проверяем содержимое перед удалением кулдауна `rate_limit:scope:admin_export:chat:136236606:user:136236606:bucket:20407` (TTL 60 с, значение 50) и подтверждаем очистку.

## Снимок до удаления
Команды (UTC 2025-11-26 08:41):

```bash
wrangler kv:key list --namespace-id d03442f14f7e4a64bb1d7896244a0d3f --prefix rate_limit:scope:admin_export --limit 5
wrangler kv:key get --namespace-id d03442f14f7e4a64bb1d7896244a0d3f rate_limit:scope:admin_export:chat:136236606:user:136236606:bucket:20407 --text
```

Результат:

| key | metadata.ttl | value |
| --- | --- | --- |
| `rate_limit:scope:admin_export:chat:136236606:user:136236606:bucket:20407` | 60 | `50` |
| `rate_limit:scope:admin_export:chat:270641809:user:270641809:bucket:20407` | 60 | `50` |
| `rate_limit:scope:admin_export:last_success` | 300 | `2025-11-26T08:40:57.901Z` |

> Список ключей сохранён полностью, чтобы показать исходное наличие кулдауна и соседних записей.

## Удаление ключа
Команда (UTC 08:42):

```bash
wrangler kv:key delete --namespace-id d03442f14f7e4a64bb1d7896244a0d3f rate_limit:scope:admin_export:chat:136236606:user:136236606:bucket:20407
```

Ответ `wrangler` — `Success`.

## Снимок после удаления
Команда повторена в 08:43 UTC:

```bash
wrangler kv:key list --namespace-id d03442f14f7e4a64bb1d7896244a0d3f --prefix rate_limit:scope:admin_export --limit 5
```

Результат показывает отсутствие очищенного ключа (вывод отсортирован по ключу):

| key | metadata.ttl | value/description |
| --- | --- | --- |
| `rate_limit:scope:admin_export:chat:270641809:user:270641809:bucket:20407` | 58 | `50` (кулдаун второго администратора ещё активен) |
| `rate_limit:scope:admin_export:last_success` | 298 | `2025-11-26T08:40:57.901Z` |

> Ключ `rate_limit:scope:admin_export:chat:136236606:user:136236606:bucket:20407` отсутствует, что подтверждает снятие ограничения.

## Вывод
- Кулдаун `admin_export` для пользователя `136236606` удалён вручную, значение 50 подтверждено в снимке «до».
- Второй администратор остался под действием стандартного окна (ожидаем естественного истечения TTL). Блокирующих записей для `136236606` больше нет.
