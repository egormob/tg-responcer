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
   - Проверка whitelisting: `curl -H "X-Admin-Token: $ADMIN_TOKEN" https://<worker>/admin/access` — убедись, что твой `userId` попадает в `whitelist`, а `health` показывает `status: "ok"`.
2. Проверь, что в KV хранится payload для новых пользователей (лог `ADMIN_EXPORT_LOG`).
3. Для новых UTM-ссылок следуй памятке [`memory-bank/references/telegram-deeplink-utm.md`](../references/telegram-deeplink-utm.md) — парсер `/start` ожидает `src_`/`src.` и символы `a-zA-Z0-9._+-`, сохраняя регистр.

## Telegram-команды администратора
В админ-чате доступны команды:

- `/admin status` — проверка whitelisting (ожидай `admin-ok`).
- `/broadcast` — минимальная рассылка: бот запросит текст (≤4096 символов) и отправит его мгновенно при наличии прав администратора.
- `/export [from] [to]` — выгружает CSV за указанный период (формат `YYYY-MM-DD`). Команда ограничена cooldown'ом: не чаще одного раза в 30 секунд.

## Пошаговая выгрузка
1. Выполни запрос: `curl -H "X-Admin-Token: $ADMIN_EXPORT_TOKEN" "https://<worker>/admin/export?from=YYYY-MM-DD&to=YYYY-MM-DD" -o export.csv`.
2. Открой CSV и найди нужные сообщения по фильтрам `timestamp`/`chat_id`.
3. Для новых UTM-ссылок убедись, что первый запрос пользователя записал источник в колонку `utm_source` таблицы `users`. Выполни `wrangler d1 execute $DB --command "SELECT user_id, utm_source FROM users WHERE utm_source IS NOT NULL ORDER BY updated_at DESC LIMIT 5"` и проверь, что нужный `user_id` присутствует.
4. Если колонка временно пропадала, проверь журналы воркера: после нескольких fallback-записей должен появиться лог `[d1-storage] utm_source column restored, re-enabling usage`. Адаптер автоматически опрашивает `PRAGMA table_info(users)` раз в пять резервных сохранений и сам возвращается к штатной схеме при успешной проверке.
5. Экспорт сейчас не содержит отдельных колонок `utm_*`. Чтобы BI увидела UTM-значения, используй выгрузку `users.utm_source` или добавь их вручную в копию CSV перед импортом.
6. Зафиксируй результат проверки в журнале прогресса с ссылкой на файл экспорта.

## Контрольные проверки
- `npm run check:roadmap` — убеждаемся, что статус шага М7.Ш8 синхронизирован с памятками.
- Разовый ручной прогон `/export` из админ-чата: payload должен попасть в KV и далее в CSV.
- Ревью колонки аналитикой: импорт в BI не должен падать из-за новых заголовков.

## Последние проверки
- 2025-11-09: `npx vitest run apps/worker-main/features/utm-tracking/__tests__/parse-start-payload.test.ts apps/worker-main/http/__tests__/telegram-webhook.test.ts` — подтверждена поддержка `src.`-payload и сохранения регистра в `utm_source`.

### Диагностика ошибок отправки админ-команд
- При ошибках доставки `/admin`-ответов бот логирует `failed to send admin help response` или `failed to send admin status response` с полями `status` и `description`. Значения берутся из ответа Telegram API (например, `403` + `Forbidden: bot was blocked by the user`).
- Для статусов `400/403/429/5xx` кеш whitelist-а принудительно инвалидируется, а в KV (`ADMIN_TG_IDS`, либо резервный биндинг при его отсутствии) сохраняется запись `admin-error:<userId>:<yyyymmddHHmmss>` с JSON `{ "user_id", "cmd", "code", "desc?", "when" }` и TTL 10 дней. Отдельный ключ `admin-error-rate:<userId>:<cmd>` ограничивает частоту до одной записи в минуту.
- Диагностический маршрут `/admin/access` возвращает агрегированный блок `adminMessagingErrors` с последними записями, суммарным количеством, топом кодов и признаком источника (`primary` или `fallback`). Используйте его, чтобы понять, когда последний раз получали ошибку и что именно вернул Telegram.

## FAQ
**Как обрабатывать payload длиннее 64 символов?** Сократи метки или используй base64url и собственный словарь соответствий. Длинные payload Telegram обрежет.

**Что делать, если нужно добавить дополнительные UTM-поля?** Добавь их в конце CSV и обнови BI-схему. Всегда документируй изменение формата в этом файле и RoadMap.
