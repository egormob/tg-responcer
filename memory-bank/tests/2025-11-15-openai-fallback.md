# 2025-11-15 — Проверка деградации Responses и fallback

- **Методика:** локальный прогон `npm test -- --run apps/worker-main/adapters/openai-responses/__tests__/openai-responses.test.ts` с моками `500` и ручной сценарий через `wrangler dev` с форсированным исключением адаптера.
- **Наблюдения:** при ошибке Responses ядро возвращает сообщение из `createRateLimitNotifier` без падения, лог содержит `ai_response_failure` и `requestId`.
- **Вывод:** fallback работает по требованиям М4.Ш4, автотесты и ручная проверка покрывают сценарий деградации.
