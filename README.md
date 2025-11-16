Если ты Codex, то начни с файла Protocol.md

## Admin diagnostics

Для использования диагностических роутов воркера необходим секрет `ADMIN_TOKEN`.
Его можно передавать через заголовок `X-Admin-Token` или query-параметр `token`.

* `GET /admin/selftest` — выполняет пинг OpenAI и Telegram, всегда отвечает `200`
    и возвращает:
    * бинарные статусы `openAiOk`/`telegramOk` и строку `reason` при значении `false`;
    * коды причин (`openAiReason`, `telegramReason`), телеметрию (`openAiLatencyMs`,
      `telegramStatus`, `telegramDescription`);
    * `lastWebhookSnapshot` с полями маршрута (`route`), чата (`chat_id`, `chatIdRaw`,
      `chatIdNormalized`) и типом исходного значения;
    * диагностический маркер OpenAI (`openAiMarkerPresent`) — его отсутствие оставляет
      ответ в состоянии `openAiOk: false`, но не приводит к `500`.
* `GET /admin/envz` — отображает булевы флаги наличия ключевых переменных окружения
  (`TELEGRAM_WEBHOOK_SECRET`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_PROMPT_ID`, `ADMIN_EXPORT_TOKEN`, `ADMIN_TOKEN`, `DB`, `RATE_LIMIT_KV`, `AI_CONTROL_KV`).

## Админ-команды в Telegram

* `/admin` — выводит краткую справку по доступным операциям и дублирует ссылку на экспорт.
* `/admin status` — проверяет whitelisting текущего пользователя и отправляет ответ `admin-ok` (если доступ есть) или `forbidden` в тот же чат.
* `/export [from] [to]` — выгружает CSV с диалогами. Даты передаются в формате `YYYY-MM-DD` и опциональны. Команду можно вызывать напрямую или через `/admin export`.
* `/broadcast` — минимальная модель рассылки: бот проверяет whitelisting администратора, просит текст сообщения (≤4096 символов) и отправляет его всем подключённым получателям напрямую через Telegram.

#### Настройка получателей рассылки

Реестр рассылок хранится в таблице `broadcast_recipients` (миграция `0003_create_broadcast_recipients.sql`) и кэшируется в
`BROADCAST_RECIPIENTS_KV`. Каждая запись содержит `chatId`, `username`, `languageCode`, дату создания и флаг активности. Реестр
можно обслуживать через защищённые HTTP-эндпоинты:

- `GET /admin/broadcast/recipients?token=…` — возвращает активных получателей, поддерживает фильтры `chatId`, `userId`,
  `language` в query-параметрах;
- `POST /admin/broadcast/recipients` — добавляет или обновляет запись (тело: `{"chatId":"…","username":"…","languageCode":"ru"}`);
- `DELETE /admin/broadcast/recipients/{chatId}` — деактивирует получателя без удаления истории.

При отсутствии D1/kv в dev-среде можно задать переменную окружения `BROADCAST_RECIPIENTS`; она поддерживает JSON-массивы, строки
через запятую/точку с запятой/переводы строк и пары `@username=chatId`. Значение используется как fallback, если реестр недоступен.

Команда `/broadcast` сначала запрашивает аудиторию: ответьте `all` для всех или, например, `lang=ru`/`chat=123456`. Если на этом
шаге сразу отправить текст, бот воспримет сообщение как рассылку «для всех». После выбора сегмента придёт второе сообщение с
напоминанием про `/cancel` и ограничение 4096 символов.

### Cloudflare Logs

Self-test и диалоговый контур логируют ключевые поля для внешней проверки Cloudflare:

* `route=<...>` — выбранный маршрут обработки запроса.
* `chatIdRawType=<...>` и `chatIdNormalizedHash=<...>` — тип исходного `chat_id` и хэш нормализованного значения (подтверждение lossless-парсера).
* `sendTyping status=<...>` и `sendText status=<...>` — статусы последних вызовов Telegram API.

### Внешний протокол проверки диагностики

1. Вручную отправить `/start` в продового бота и убедиться, что сообщение обрабатывается без 400-ответов от Bot API.
2. Вызвать `GET /admin/selftest?token=…` и зафиксировать `200` с актуальными полями `openAiOk`/`telegramOk`, `reason`, снэпшотом маршрута и `chat_id`.
3. Просмотреть Cloudflare-логи (`wrangler tail` или Dashboard) и подтвердить наличие ключей `route=`, `chatIdRawType`, `chatIdNormalizedHash`, `sendTyping` и `sendText`.
4. Поискать `400 Bad Request` в логах Telegram; отсутствие записей подтверждает устойчивость guards и lossless-парсера.

### Переменные окружения OpenAI

`OPENAI_PROMPT_VARIABLES` можно указывать в интерфейсе Cloudflare как JSON-объект (plain object). Также поддерживается строковое значение с JSON, как и раньше. Значение хранится в секции **Secrets** и должно быть валидным JSON-объектом. Если опубликованный промпт не требует переменных, запишите пустой объект `{}` — это позволит Cloudflare сохранить секрет и пройти проверку `/admin/envz`, а адаптер передаст OpenAI пустой набор переменных (эквивалент отсутствию дополнительных параметров). Подробнее о причинах сброса переменной и способах её закрепить описано в [docs/cloudflare-openai-prompt-variables.md](docs/cloudflare-openai-prompt-variables.md).
