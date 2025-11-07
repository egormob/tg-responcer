# Операционная памятка: выгрузка диалогов с UTM-метками

## Назначение
Инструкция описывает, как выгружать CSV из `/admin/export` так, чтобы каждая запись содержала источник трафика (payload deeplink). Документ синхронизирован с шагом М7.Ш8 дорожной карты.

## Формат CSV
Экспорт по умолчанию возвращает заголовки:
`dialog_id,user_id,started_at,finished_at,message_count,utm_label,utm_source,utm_medium,utm_campaign,utm_content`

- `utm_label` — исходный payload, полученный из deeplink (`start`/`startapp`).
- `utm_source`, `utm_medium`, `utm_campaign`, `utm_content` — разбивка `utm_label` по сегментам (`src.medium.campaign[.content]`). Пустые значения оставляем пустыми.

## Подготовка
1. Убедись, что токен администратора активен (`ADMIN_EXPORT_TOKEN`) и ты в whitelist (`ADMIN_TG_IDS`).
2. Проверь, что в KV хранится payload для новых пользователей (лог `ADMIN_EXPORT_LOG`).
3. Для новых UTM-ссылок следуй памятке [`memory-bank/references/telegram-deeplink-utm.md`](../references/telegram-deeplink-utm.md).

## Пошаговая выгрузка
1. Выполни запрос: `curl -H "X-Admin-Token: $ADMIN_EXPORT_TOKEN" "https://<worker>/admin/export?from=YYYY-MM-DD&to=YYYY-MM-DD" -o export.csv`.
2. Открой CSV и проверь наличие колонок `utm_*`.
3. Убедись, что `utm_label` заполнен для новых пользователей, а производные поля соответствуют разбиению:
   - `ads.meta.black-friday+retargeting` → `utm_source=ads`, `utm_medium=meta`, `utm_campaign=black-friday`, `utm_content=retargeting`.
4. Если `utm_label` пустой, проверь процесс регистрации пользователя и наличие payload в логах.
5. Зафиксируй результат проверки в журнале прогресса с ссылкой на файл экспорта.

## Контрольные проверки
- `npm run check:roadmap` — убеждаемся, что статус шага М7.Ш8 синхронизирован с памятками.
- Разовый ручной прогон `/export` из админ-чата: payload должен попасть в KV и далее в CSV.
- Ревью колонки аналитикой: импорт в BI не должен падать из-за новых заголовков.

## FAQ
**Как обрабатывать payload длиннее 64 символов?** Сократи метки или используй base64url и собственный словарь соответствий. Длинные payload Telegram обрежет.

**Что делать, если нужно добавить дополнительные UTM-поля?** Добавь их в конце CSV и обнови BI-схему. Всегда документируй изменение формата в этом файле и RoadMap.
