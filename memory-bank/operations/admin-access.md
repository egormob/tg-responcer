# Админ-доступ и диагностика

- Баррель `apps/worker-main/features/index.ts` обязан реэкспортировать публичный API `features/admin-access`, включая `createAdminCommandErrorRecorder`, `readAdminMessagingErrors`, `extractTelegramErrorDetails`, `shouldInvalidateAdminAccess` и связанные типы.
- Diagnostics-роут `/admin/access` использует `readAdminMessagingErrors` и должен продолжать отображать блок `adminMessagingErrors` после обновлений экспорта.
- При изменениях в `admin-messaging-errors` проверяй сборку воркера (`npx wrangler deploy --dry-run`) и запускай профильные тесты `npm test`, чтобы подтвердить, что диагностические записи продолжают собираться.
