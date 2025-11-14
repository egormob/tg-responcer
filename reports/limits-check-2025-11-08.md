# 2025-11-08 LIMITS CHECK

- `npx vitest run apps/worker-main/features/export/__tests__/telegram-export-command.test.ts`
  - Result: PASS (21 tests) including the cooldown resend messaging scenario.
- `npx vitest run apps/worker-main/composition/__tests__/compose.test.ts`
  - Result: PASS (5 tests) confirming LIMITS_ENABLED=0 keeps admin/export limiter enforced.
