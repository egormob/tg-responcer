Если ты Codex, то начни с файла Protocol.md

## Admin diagnostics

Для использования диагностических роутов воркера необходим секрет `ADMIN_TOKEN`.
Его можно передавать через заголовок `X-Admin-Token` или query-параметр `token`.

* `GET /admin/selftest` — выполняет пинг OpenAI-порта и возвращает структуру
  `{ ok: boolean, latency_ms?: number, used_output_text?: boolean, error?: string, snippet?: string }`.
* `GET /admin/envz` — отображает булевы флаги наличия ключевых переменных окружения
  (`TELEGRAM_WEBHOOK_SECRET`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_PROMPT_ID`, `ADMIN_EXPORT_TOKEN`, `ADMIN_TOKEN`, `DB`, `RATE_LIMIT_KV`).

Остальные подробности по запуску и протоколу остаются в `Protocol.md`.

### Переменные окружения OpenAI

`OPENAI_PROMPT_VARIABLES` можно указывать в интерфейсе Cloudflare как JSON-объект (plain object). Также поддерживается строковое значение с JSON, как и раньше.
