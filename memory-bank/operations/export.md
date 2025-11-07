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
- `message_metadata` — дополнительная информация в JSON (`content_type`, `payload`, `parts` и т. п.).

## Подготовка
1. Убедись, что токен администратора активен (`ADMIN_EXPORT_TOKEN`) и ты в whitelist (`ADMIN_TG_IDS`).
2. Проверь, что в KV хранится payload для новых пользователей (лог `ADMIN_EXPORT_LOG`).
3. Для новых UTM-ссылок следуй памятке [`memory-bank/references/telegram-deeplink-utm.md`](../references/telegram-deeplink-utm.md).

## Пошаговая выгрузка
1. Выполни запрос: `curl -H "X-Admin-Token: $ADMIN_EXPORT_TOKEN" "https://<worker>/admin/export?from=YYYY-MM-DD&to=YYYY-MM-DD" -o export.csv`.
2. Открой CSV и найди нужные сообщения по фильтрам `timestamp`/`chat_id`.
3. Payload из deeplink хранится в `message_metadata.payload` (JSON). Проверь, что новые пользователи несут ожидаемое значение `utm_label` и что оно парсится на стороне BI.
4. Если `message_metadata.payload` пустой, проверь процесс регистрации пользователя и наличие payload в логах.
5. Зафиксируй результат проверки в журнале прогресса с ссылкой на файл экспорта.

## Контрольные проверки
- `npm run check:roadmap` — убеждаемся, что статус шага М7.Ш8 синхронизирован с памятками.
- Разовый ручной прогон `/export` из админ-чата: payload должен попасть в KV и далее в CSV.
- Ревью колонки аналитикой: импорт в BI не должен падать из-за новых заголовков.

## FAQ
**Как обрабатывать payload длиннее 64 символов?** Сократи метки или используй base64url и собственный словарь соответствий. Длинные payload Telegram обрежет.

**Что делать, если нужно добавить дополнительные UTM-поля?** Добавь их в конце CSV и обнови BI-схему. Всегда документируй изменение формата в этом файле и RoadMap.
