# OpenAI Responses: Missing `model` parameter diagnostic

## Симптомы
- API `POST /v1/responses` возвращает ошибку `Missing required parameter: 'model'`.
- В логах воркера появляются ошибки `OpenAI assistant model is missing` или сообщения о невозможности получить конфигурацию ассистента.
- Ответы ассистента перестают приходить сразу после обновления ассистента в OpenAI.

## Причина
OpenAI требует явного указания идентификатора модели при вызове `/v1/responses`. Если ассистент не содержит поле `model` или воркер не кеширует его перед вызовом, OpenAI отклоняет запрос.

## Диагностика
1. Запустить модульные тесты адаптера: `npm run test -- openai-responses` — проверяет ленивую загрузку модели и ошибки.
2. Проверить запрос `GET https://api.openai.com/v1/assistants/{ASSISTANT_ID}`:
   - Убедиться, что поле `model` присутствует и соответствует доступной модели.
   - При необходимости очистить кеш адаптера, перезапустив воркер или invalidate, чтобы он повторно загрузил ассистента.
3. Проанализировать логи воркера (`wrangler tail`): ищите события `openai-assistant fetch failed` или `openai-assistant missing model`.

## Фикс
- Настроить адаптер OpenAI Responses на ленивое получение и кеширование поля `model` через `GET /v1/assistants/{assistantId}`.
- При отсутствии поля `model` в ассистенте — задать модель в кабинете OpenAI и деплоить воркер после подтверждения.
- После исправления убедиться, что POST-запросы содержат и `assistant_id`, и `model`.

## Проверка после фикса
- Повторный запуск `npm run test -- openai-responses`.
- Тестовый диалог через Telegram: ответ должен вернуться без ошибки `Missing required parameter: 'model'`.
