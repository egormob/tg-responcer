# 2025-11-10 — Восстановить цепочку chat_id без потерь: локальный прогон HTTP-юнитов

- **Исполнитель:** локальный терминал на macOS (`runner: local terminal on macOS`).
- **Контекст:** репозиторий `egormob/tg-responcer`, база воркера `https://tg-responcer.egormob.workers.dev`, админ-токен `devadmintoken`.
- **Цель:** подтвердить, что lossless-цепочка `chat_id` закрыта на уровне HTTP-юнитов и смежных маршрутов (`safeWebhook`, UTM, маршрутизация `/export` и админ-команды).
- **Дата запуска:** 2025-11-10.

## Шаги прогона
1. `git clone https://github.com/egormob/tg-responcer.git`
2. `cd tg-responcer`
3. `export WORKER_BASE_URL="https://tg-responcer.egormob.workers.dev"`
4. `export ADMIN_TOKEN="devadmintoken"`
5. `npm install` *(`npm ci` не сработал из-за отсутствия `package-lock.json`)*
6. `mkdir -p logs`
7. `npm run test -- http | tee logs/test-http-YYYYMMDD-HHMMSS.log`

## Результат
- `vitest 1.6.1`
- старт тестов: 19:59:29 (+03)
- длительность: 429 мс
- пройдено файлов: 7
- пройдено тестов: 77
- код выхода: 0

## Ключевые наблюдения
- UTM-пути и сохранение 64-битных `chat_id` покрыты и проходят (включая ветки `+`/`.` и mini-app `initData`).
- `safeWebhook` и typing-indicator выполняют fallback и возвращают ожидаемые ответы.
- Маршрутизация `/export` и админ-команд зелёная на уровне unit HTTP.

## Предупреждения
- `npm ci` завершился `EUSAGE` из-за отсутствия `package-lock.json`; использован `npm install`.
- Deprecation notice от eslint/vite CJS API не блокирует прогон.
- После прогона в watch-режиме появился интерактивный prompt и ошибка RegExp — нерелевантно. Для повторов запускать с `CI=1` или `--run`.

## Артефакты
- `logs/test-http-YYYYMMDD-HHMMSS.log`

## Вывод
Юнит-слой HTTP зелёный. Если на проде сохраняется «тишина», причину ищем в рантайме (webhook, идентификаторы, кэш, маршрутизация), а не в этих тестах.
