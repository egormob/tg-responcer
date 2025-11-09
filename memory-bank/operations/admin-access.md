# Админ-доступ и диагностика

- Баррель `apps/worker-main/features/index.ts` обязан реэкспортировать публичный API `features/admin-access`, включая `createAdminCommandErrorRecorder`, `readAdminMessagingErrors`, `extractTelegramErrorDetails`, `shouldInvalidateAdminAccess` и связанные типы.
- Diagnostics-роут `/admin/access` использует `readAdminMessagingErrors` и должен продолжать отображать блок `adminMessagingErrors` после обновлений экспорта.
- При изменениях в `admin-messaging-errors` проверяй сборку воркера (`npx wrangler deploy --dry-run`) и запускай профильные тесты `npm test`, чтобы подтвердить, что диагностические записи продолжают собираться.
- `/admin/selftest?q=utm` выполняет быструю проверку сохранения UTM-меток через `StoragePort.saveUser` и чтения истории (`getRecentMessages`); успешный ответ — `200` с `{ test: 'utm', ok: true, utmDegraded: false }`.
- `/admin/diag?q=bindings` отображает подготовленные биндинги для `saveUser` и `getRecentMessages`, используя тот же `StoragePort`; при недоступности хранилища возвращает `500` с описанием ошибки.
