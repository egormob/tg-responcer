# Операционная памятка: выгрузка диалогов с UTM-метками

## Назначение
Инструкция описывает, как выгружать CSV из `/admin/export` с построчной выгрузкой сообщений и базовым набором полей. Документ синхронизирован с шагом М7.Ш8 дорожной карты.

## Формат CSV
Экспорт по умолчанию возвращает заголовки:
`message_id,user_id,username,first_name,last_name,language_code,user_created_at,user_updated_at,user_metadata,chat_id,thread_id,role,text,timestamp,message_metadata`

- `message_id` — идентификатор сообщения в таблице `messages`.
- `user_*` — данные телеграм-пользователя на момент выгрузки.
- `chat_id`/`thread_id` — контекст, из которого пришло сообщение.
- `role` и `text` — содержимое сообщения (бот/пользователь).
- `message_metadata` — дополнительная информация в JSON (`messageId`, служебные теги AI-ответа и т. п.).

## Подготовка
1. Убедись, что токен администратора активен (`ADMIN_EXPORT_TOKEN`) и ты в whitelist (`ADMIN_TG_IDS`).
2. Проверь, что в KV хранится payload для новых пользователей (лог `ADMIN_EXPORT_LOG`).
3. Для новых UTM-ссылок следуй памятке [`memory-bank/references/telegram-deeplink-utm.md`](../references/telegram-deeplink-utm.md).

## Пошаговая выгрузка
1. Выполни запрос: `curl -H "X-Admin-Token: $ADMIN_EXPORT_TOKEN" "https://<worker>/admin/export?from=YYYY-MM-DD&to=YYYY-MM-DD" -o export.csv`.
2. Открой CSV и найди нужные сообщения по фильтрам `timestamp`/`chat_id`.
3. Для новых UTM-ссылок убедись, что первый запрос пользователя записал источник в колонку `utm_source` таблицы `users`. Выполни `wrangler d1 execute $DB --command "SELECT user_id, utm_source FROM users WHERE utm_source IS NOT NULL ORDER BY updated_at DESC LIMIT 5"` и проверь, что нужный `user_id` присутствует.
4. Экспорт сейчас не содержит отдельных колонок `utm_*`. Чтобы BI увидела UTM-значения, используй выгрузку `users.utm_source` или добавь их вручную в копию CSV перед импортом.
5. Зафиксируй результат проверки в журнале прогресса с ссылкой на файл экспорта.

## Контрольные проверки
- `npm run check:roadmap` — убеждаемся, что статус шага М7.Ш8 синхронизирован с памятками.
- Разовый ручной прогон `/export` из админ-чата: payload должен попасть в KV и далее в CSV.
- Ревью колонки аналитикой: импорт в BI не должен падать из-за новых заголовков.

## FAQ
**Как обрабатывать payload длиннее 64 символов?** Сократи метки или используй base64url и собственный словарь соответствий. Длинные payload Telegram обрежет.

**Что делать, если нужно добавить дополнительные UTM-поля?** Добавь их в конце CSV и обнови BI-схему. Всегда документируй изменение формата в этом файле и RoadMap.
