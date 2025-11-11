# Инцидент: повторное 400 Bad Request из-за потери точности Telegram ID

**Таймстамп:** 2025-11-16T07:45:00Z (UTC).

## Симптомы
- Telegram API отвечает `400 Bad Request` на исходящие запросы после приёма апдейта.
- Пользователь не видит `typing`-индикатор: `sendTyping` не вызывается после падения пайплайна.
- В логах `http/telegram-webhook` повторяются предупреждения о недопустимом `chat_id`.
- Пакет DIAG-PACKET подтверждает приём входящих апдейтов: webhook продолжает получать события, но отсутствуют исходящие `sendTyping`/`sendMessage`.
- `/admin/selftest` возвращает `AI_NON_2XX`, `/admin/diag` отвечает `Not Found`, что показывает отсутствие рабочей диагностики на воркере.
- По данным Observability (`dash.cloudflare.com`) фиксируются входящие `POST /webhook/...` и сообщения `[telegram-webhook] incoming update`, но в сессии отсутствуют `sendTyping`/`sendMessage` (ни 200, ни 4xx).

## Диагностика (DIAG-PACKET, prod selftests)
1. `/healthz → {"status":"ok"}` — воркер жив.
2. `/admin/selftest?q=utm` возвращает `{ok: true, saveOk: true, readOk: true, utmDegraded: false}` → D1/схема/апсерт UTM в норме.
3. `/admin/selftest?q=ping` даёт `{openAiOk: false, telegramOk: false, errors: ["openai: missing diagnostic marker", "telegram: chatId query parameter is required"], openAiLatencyMs: 4.6–7.5s}` → diag-пинг не валидирует Bot API (ждёт chatId), AI-контур не отдаёт диагностический маркер.
4. `/admin/selftest?q=send-admin&chatId=136326606` выдаёт `{openAiOk: false, telegramOk: false, errors: ["…", "telegram: Bad Request: chat not found"]}` → отправка в Telegram падает, чат с пользователем ранее существовал → вероятна порча `chat_id` на нашей стороне.
5. `/admin/diag?q=telegram.getMe|telegram` отвечает `{"error":"Unsupported diagnostics query"}` → нет базовой проверки Bot API (`getMe`/test-send).
6. `/admin/diag?q=bindings` возвращает `{ok: true, …}`, но токены/секреты (включая `TELEGRAM_BOT_TOKEN`) не подсвечены/не подтверждены явно.
7. `/admin/known-users/clear` отвечает `Not Found` → отсутствует админ-роут для сброса кэша известных пользователей.

## Ретест 2025-11-16
- **Статус:** ❌ провален — рассинхрон `chat_id` сохраняется, бот молчит после self-test.
- Внешний прогон self-test зафиксировал повторение ошибки `openai: missing diagnostic marker` и `telegram: Bad Request: chat not found` после пинга. Подробный журнал шагов, расширенная диагностика и лог Cloudflare — в [external-checks/retest-2025-11-16.md](../external-checks/retest-2025-11-16.md).
- Cloudflare Observability показывает последовательность `telegram.message`/`telegram.typing_update` POST-запросов, завершающихся 200 без последующего `sendMessage`, что подтверждает обрыв цепочки на webhook-ветке.
- Наблюдение: после двойного сообщения «Self-test ping» бот перестаёт отвечать администратору и молчит для обычного пользователя, что подтверждает влияние self-test на кеш идентификаторов.
- Итог-диагноз команды: DIAG-контур жив, но основная ветка webhook рвётся при попытке отправки (`chat_id` в ответе искажается или подменяется), см. раздел «Итог-диагноз 2» в памятке.

## Обновление 2025-11-19 — PASS_WITH_CAVEAT
- Внешний консультант подтвердил: пользовательский и админский маршруты отвечают мгновенно, `typing` виден; Cloudflare-лог за 15 минут чист от `400 Bad Request`.
- Снапшоты вебхука фиксируют стабильные поля `chatIdRawType`, `chatIdNormalizedHash`, значение `chatIdUsed` совпадает с `chatIdNormalizedHash` (см. `lastWebhookSnapshot`).
- `/admin/selftest` теперь отдаёт `200` даже без диагностического маркера, помечая состояние как `openAiOk:false` с `openAiReason='missing_diagnostic_marker'` и сэмплом ответа. Маркер нужно вернуть на стороне OpenAI.
- В логах появились инфо-записи вида `[telegram] sendTyping status=<code>` / `[telegram] sendText status=<code>` с `route`, `chatIdRawType`, `chatIdNormalizedHash` — использовать для наблюдаемости после деплоев.
- Дополнительная проверка: `npm run test -- apps/worker-main/features/admin-diagnostics/__tests__/self-test-route.test.ts` подтверждает мягкий сценарий self-test и регрессию на `missing_diagnostic_marker`.

### Зависимые задачи
- Lossless-парсер Telegram ID в HTTP-слое (`http/parse-json-with-large-integers.ts`, `http/telegram-webhook.ts`).
- Диагностика вебхука: расширенные логи `chat_id_raw/chat_id_used`, статус отправок и маршруты `/admin/selftest`, `/admin/diag`.
- Очистка/синхронизация кэша `knownUsers`, чтобы админ-роуты и webhook использовали единый источник.
- Контроль рассылки: защита от рассылок с усечёнными ID и ретесты после фиксов (smoke рассылки/диалогов).

## Диагноз (рабочая версия)
- Диалог падает до safe-ветки на первом `messaging.sendTyping` из-за испорченного `chat_id`.
- Корень: lossy-парсинг ID (эвристики + `Math.trunc` в `toIdString`). Любой Telegram ID, прошедший через helper, уходит в Bot API искажённым → 400 → «тишина».
- Тот же helper используется в UTM-снапшоте/кэше, закрепляя неверный ID.

## Затронутые файлы
- `http/parse-json-with-large-integers.ts` — текущий парсер не гарантирует сохранение 64-битных идентификаторов.
- `http/telegram-webhook.ts` — преобразование идентификаторов перед вызовом Telegram.
- `features/utm-tracking/create-telegram-webhook-handler.ts` — использует результат парсинга в критическом пути.
- `core/DialogEngine.ts` — полагается на корректность `userId`/`chat_id` при отправке ответа.

## Несработавшие гипотезы
- [issues/2025-11-11-telegram-id-truncation.md](2025-11-11-telegram-id-truncation.md) — фокус на устранении `Number()` без полноценного lossless-парсера; повторные 400 подтверждают, что подход не закрывает проблему.
- [issues/2025-11-09-dialog-freeze.md](2025-11-09-dialog-freeze.md) — перенос UTM-логики вне критического пути не устранил сброс `chat_id`, симптомы вернулись.
- Обе гипотезы признаны несработавшими: числовой парсинг и перераспределение побочных операций не восстанавливают идентификаторы после усечения. Текущая стратегия строится на полном отказе от любых числовых преобразований Telegram ID.

## Новая стратегия
Lossless-парсер и жёсткие guard'ы должны сохранять идентификаторы Telegram без эвристик по длине. Стратегия строится на полном отказе от числового парсинга: любые промежуточные `Number()`/`parseInt()` считаются дефектом, даже если длина идентификатора совпадает с ожидаемой. Текущие проверки на количество цифр и диапазоны не гарантируют корректность: при `JSON.parse` → `number` мы теряем значимые разряды, даже если длина совпадает. Требуется конвейер, который:
1. Считывает идентификаторы как строки/BigInt-совместимые значения без промежуточного преобразования к `number`.
2. Проводит валидацию через строгие предикаты (префиксы `-100`, диапазон `>=0` для приватных чатов) до передачи в `DialogEngine`.
3. Отбрасывает апдейты с несовместимыми значениями до выхода из HTTP-уровня, чтобы не ломать ядро.

## ЧТО ЧИНИТЬ
**A) Идентификаторы Telegram (КРИТИЧНО)**
- Трактовать все ID как «непрозрачные строки» 1:1 из webhook (`chat_id`, `user.id`, `sender_chat.id`, `migrate_to_chat_id` и т. д.).
