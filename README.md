Если ты Codex, то начни с файла Protocol.md

## Admin diagnostics

Для использования диагностических роутов воркера необходим секрет `ADMIN_TOKEN`.
Его можно передавать через заголовок `X-Admin-Token` или query-параметр `token`.

* `GET /admin/selftest` — выполняет пинг OpenAI-порта и возвращает структуру
  `{ ok: boolean, latency_ms?: number, used_output_text?: boolean, error?: string, snippet?: string }`.
* `GET /admin/envz` — отображает булевы флаги наличия ключевых переменных окружения
  (`TELEGRAM_WEBHOOK_SECRET`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_PROMPT_ID`, `ADMIN_EXPORT_TOKEN`, `ADMIN_TOKEN`, `DB`, `RATE_LIMIT_KV`).

## Админ-команды в Telegram

* `/admin` — выводит краткую справку по доступным операциям и дублирует ссылки на экспорт и рассылки.
* `/admin status` — проверяет whitelisting текущего пользователя и отправляет ответ `admin-ok` (если доступ есть) или `forbidden` в тот же чат.
* `/export [from] [to]` — выгружает CSV с диалогами. Даты передаются в формате `YYYY-MM-DD` и опциональны. Команду можно вызывать напрямую или через `/admin export`.
* `/broadcast help` — показывает подсказку по параметрам рассылок и напоминает про HTTP POST `/admin/broadcast`.
* `/broadcast preview <текст>` — отправляет пробное сообщение только в текущий чат, чтобы проверить формат перед запуском рассылки.
* `/broadcast send [--chat=<id>] [--user=<id>] [--lang=<code>] <текст>` — валидирует входные параметры и подготавливает payload для HTTP запроса к `/admin/broadcast`. Без фильтра команда вернёт ошибку.

Команды `/broadcast …` также доступны через пространство имён `/admin broadcast …` для совместимости с существующими сценариями. Остальные подробности по запуску и протоколу остаются в `Protocol.md`.

### Переменные окружения OpenAI

`OPENAI_PROMPT_VARIABLES` можно указывать в интерфейсе Cloudflare как JSON-объект (plain object). Также поддерживается строковое значение с JSON, как и раньше.
