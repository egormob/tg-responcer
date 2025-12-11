# AI queue synthetic check (2025-12-12)

## Контекст боевого набора
- Без KV-конфига работали дефолты: `AI_MAX_CONCURRENCY=4`, `AI_QUEUE_MAX_SIZE=64`, `AI_TIMEOUT_MS=18000`, `AI_RETRY_MAX=3`, единственный endpoint.
- По данным пользователя: 270 ассистентских ответов / 270 пользовательских сообщений за 10 дней, 28 пользователей. Фолбэков 41 (15.2%), всплески латентности после 15–20 с, длинный системный промпт ≈16.5 к символов. Конкурентность в пике 3 сообщения в минуту.

## Синтетика (vitest)
- Файл: `apps/worker-main/adapters/openai-responses/__tests__/ai-queue-synthetic.test.ts`.
- Запуск: `npx vitest run apps/worker-main/adapters/openai-responses/__tests__/ai-queue-synthetic.test.ts`.
- Профили:
  - **Field-like:** сжатая выборка из боевых бакетов латентности (<=2s … >60s), 18.5 s хвостов (модель + большой контекст), редкие пары сообщений в одну отметку времени.
  - **Growth burst:** 80 одновременных запросов по 8 s, чтобы увидеть запас очереди на будущий рост (200–300+ пользователей).
- Сравнивали:
  - **Baseline:** 4 параллели / очередь 64 / бюджет 18 s / 3 ретрая / один endpoint.
  - **Tuned:** 4 параллели / очередь 128 / бюджет 20 s (максимум, который сейчас допустит код) / 3 ретрая / `AI_BASE_URLS` = [main, eu], `AI_ENDPOINT_FAILOVER_THRESHOLD=2`.
- Результаты:
  - Field-like: таймауты падают с ~16 до ~4 за счёт попадания «почти 18 s» запросов в 20 s бюджет; переполнений очереди нет.
  - Growth burst: при 80 одновременных запросах baseline сбрасывает 12 из-за `queue_overflow`; tuned c очередью 128 отдаёт все 80 без деградации.

## Рекомендованный конфиг для дев-стенда
```json
{
  "AI_MAX_CONCURRENCY": 4,
  "AI_QUEUE_MAX_SIZE": 128,
  "AI_TIMEOUT_MS": 28000,
  "AI_RETRY_MAX": 3,
  "AI_ENDPOINT_FAILOVER_THRESHOLD": 2,
  "AI_BASE_URLS": [
    "https://api.openai.com/v1/responses",
    "https://api.openai.com/v1/responses?cf_region=eu"
  ]
}
```
- Адаптер теперь ограничивает `requestTimeoutMs` до 28 000 мс, поэтому KV-значение 28 s применяется полностью. Если хотите остаться консервативно — ставьте 22–24 s; 28 s — верхний безопасный предел (Cloudflare лимит ~30 s).
- Очередь 128 покрывает bursts 200–300 пользователей при таком бюджете; оставить `AI_MAX_CONCURRENCY=4`, чтобы не превысить лимиты Telegram/Workers, и опираться на KV для дальнейших экспериментов (вариант «6/160» пробовать отдельно после замеров).

## Применение на стенде
1) Сохранить JSON (например `ai-queue-config.json`) и залить в KV:
```
wrangler kv key put --binding AI_CONTROL_KV AI_QUEUE_CONFIG --path ./ai-queue-config.json
```
2) Проверить `/admin/diag?q=ai-queue` → `sources.*="kv"`, `maxQueue=128`, `requestTimeoutMs=20000`, `baseUrls` = 2, `endpointFailoverThreshold=2`.

## Наблюдаемость
- При тестах смотреть на `avgWaitMs`, `droppedSinceBoot`, `lastDropAt`, и на логи `[ai][timeout]`/`[ai][dropped]`.
- Для хвостов >20 s, если нужно, придётся повышать лимит в коде (иначе `AI_TIMEOUT_MS>20000` в KV не подействует).
