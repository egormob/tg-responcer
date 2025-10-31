# Stable Production Snapshots

## prod-2025-10-31-pr38
- **Commit**: 3aaaf6fb081e131b56de2bc3b9a633fbb23ebaed
- **Description**: Known-good prod. Workers Builds: PR #38 (lazy model retrieval).
- **Checks**:
  - Healthz: https://tg-responcer.egormob.workers.dev/healthz → {"status":"ok"}
  - Self-test ping: https://tg-responcer.egormob.workers.dev/admin/selftest?token=devadmintoken&q=ping → {"ok":false,"error":"OpenAI Responses request failed: OpenAI Responses request failed: AI_NON_2XX","snippet":"Error: OpenAI Responses request failed: OpenAI Responses request failed: AI_NON_2XX\n    at createWrappedError (index.js:673:17)\n    at Object.reply (index.js:813:19)\n    at async Object.selfTest (index.js:1433:21)"}
  - Diagnostics: https://tg-responcer.egormob.workers.dev/admin/diag?token=devadmintoken → Not Found
  - Telegram webhook: https://api.telegram.org/bot<token>/getWebhookInfo → {"ok":true,"result":true,"description":"Webhook is already set"}

Use this tag as the baseline for future recoveries and production deploys.
