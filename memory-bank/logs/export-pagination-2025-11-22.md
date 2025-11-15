# `/admin/export` с пагинацией — 2025-11-22

- **Сценарий:** запуск `/admin/export` на продовом воркере (после шагов 5.1–5.2) с дефолтным диапазоном и последующей итерацией `x-next-cursor`.
- **Цель шага 5.3:** подтвердить склейку всех CSV-страниц, ограничение 5 000 строк и сбор UTM-меток со всех страниц.
- **Метрики:**
  - `rowCount:1849` (полная выборка текущей базы), `cursorPages:2`, `utm_sources=["src_DIAG","src_TEST-GREETING","stress_test"]`.
  - `truncationWarning:false` (лимит 5 000 не достигнут), сообщение «CSV содержит только заголовок» не появлялось.
  - `max_retries_exceeded:0`, `ai_queue_active≤1`, `ai_queue_queued=0`, `ai_queue_dropped=0`.
  - `utm_rows=1849` подтверждены сверкой CSV и D1.
- **Логи:** Cloudflare tail содержит `admin export cursor` для каждой страницы и `sendText status=200`; предупреждений `admin export cooldown` нет.
- **Артефакты:** итоговый CSV и расшифровка логов задокументированы в [`reports/REPORT-limits-export-cooldown-20251123.md`](../../reports/REPORT-limits-export-cooldown-20251123.md) (раздел «Экспорт /export под админом»).
