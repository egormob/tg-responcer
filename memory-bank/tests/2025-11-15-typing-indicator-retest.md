# 2025-11-15 — Ретест устранения паузы typing → ответ

- **Сценарий:** ручной диалог в Telegram после деплоя фикса М3.Ш5; последовательность «ping», «long task», «final».
- **Наблюдения:** `sendTyping` оставался активным до отправки каждого ответа, визуальная пауза после отключения индикатора отсутствует.
- **Подтверждение логов:** `wrangler tail` показывает пары `typing:start`/`typing:stop` c разницей <200 мс до `sendText` (см. локальный лог `wrangler tail` 2025-11-15 12:14 UTC).
- **Ссылки:** фиксация изменений и автотестов — [memory-bank/issues/typing-indicator-delay.md](../issues/typing-indicator-delay.md), покрытие `apps/worker-main/http/__tests__/typing-indicator.test.ts`.
