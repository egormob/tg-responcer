# 7. 🧹 Удалить устаревшие модули отложенной рассылки — отчёт проверки

- Дата: 10.11.2025, 19:18
- Worker: https://tg-responcer.egormob.workers.dev

## Runtime-сводка
- HTTP suite: OK • [2m Test Files [22m [1m[32m7 passed[39m[22m[90m (7)[39m •  • 
- Broadcast suite: OK • [2m Test Files [22m [1m[32m2 passed[39m[22m[90m (2)[39m •  • 

## Поиск следов legacy-модулей (директории/файлы)
- Найдено: 0

## Поиск следов legacy-символов/импортов (sendLater|scheduleAt|delayMs|…)
- Найдено: 3
- ./apps/worker-main/http/__tests__/router.test.ts:632:    const deferred = createDeferred<{ delivered: number; failed: number; deliveries: unknown[] }>();
- ./apps/worker-main/http/__tests__/router.test.ts:633:    const sendBroadcast = vi.fn().mockReturnValue(deferred.promise);
- ./apps/worker-main/http/__tests__/router.test.ts:733:    deferred.resolve({ delivered: 2, failed: 0, deliveries: [] });

## Артефакты
- logs/test-http-latest.zip
- logs/test-broadcast-latest.zip
- logs/test-http-20251110-191714.log
- logs/test-broadcast-20251110-191714.log

## Итог
⚠️ Требуется внимание. http=OK, broadcast=OK, legacy_scan=WARN.
   Проверьте списки выше: удалить найденные legacy-директории/символы или добавить их в allow-лист, если это валидные новые модули.
