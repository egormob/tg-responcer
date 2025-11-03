# 2025-11-13 — Проверка envz после перевода OPENAI_MODEL в Secrets

- **Стенд:** Cloudflare Workers Dashboard → tg-responcer → Settings → Variables.
- **Действия:** переменная `OPENAI_MODEL` удалена из раздела Text, создан Secret со значением `gpt-5-nano`.
- **Деплой:** выполнен через Dashboard (Create version from Git), предупреждение об override подтверждено автоматически.
- **Результат:** сразу после публикации `/admin/envz` показывает `openai_model: true`, `rate_limit_kv_bound: true`, `db_bound: true`.
- **Вывод:** секрет `OPENAI_MODEL` больше не сбрасывается; ручное вмешательство не требуется.
