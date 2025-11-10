# 2025-11-16 — Telegram сохраняет длинные идентификаторы как строки

- **Сценарий:** автотест прогоняет webhook через `router.handle` и `createTelegramWebhookHandler`, используя `chat.id` и `message_thread_id` длиной 19 символов.
- **Покрытие:**
  - `apps/worker-main/http/__tests__/parse-json-with-large-integers.test.ts` — парсер оборачивает `9223372036854775807`, `-1002003004005006007` и вложенные массивы в строки, не затрагивая дробные и экспоненциальные числа.
  - `apps/worker-main/http/__tests__/router.test.ts` — rate limit fallback и typing indicator получают те же строковые `chatId`/`threadId`.
  - `apps/worker-main/features/utm-tracking/__tests__/create-telegram-webhook-handler.test.ts` — UTM-кеш сохраняет `userId` как строку и повторно использует её без преобразования в число.
- **Результат:** `messaging.sendText` и `storage.saveUser` получают идентификаторы без потери точности; `parseJsonWithLargeIntegers` гарантирует корректное чтение JSON с числами ≥15 символов.
