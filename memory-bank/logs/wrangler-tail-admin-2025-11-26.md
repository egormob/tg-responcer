# `wrangler tail` — `/admin` после очистки лимита (26.11.2025)

Сессия `wrangler tail --format=pretty --sampling=1` (UTC 08:44–08:46). Зафиксированы три последовательных события.

## 1. Команда `/admin`
```
2025-11-26T08:44:12.019Z [router][admin][info] route="/admin" requestId="req-a1d13f" status=200 userId=136236606 chatId=136236606
2025-11-26T08:44:12.022Z [admin.help][info] admin help sent { requestId="req-a1d13f", buttons=["/admin status","/admin export","/admin access"] }
2025-11-26T08:44:12.190Z [telegram][sendText][ok] messageId=9831 latencyMs=168
```

## 2. Команда `/admin status`
```
2025-11-26T08:45:03.501Z [router][admin][info] route="/admin/status" requestId="req-a1d182" status=200 userId=136236606 chatId=136236606
2025-11-26T08:45:03.505Z [system_admin_status][info] report sent { requestId="req-a1d182", aiFallback=false, aiQueue={active:0,queued:0} }
2025-11-26T08:45:03.677Z [telegram][sendText][ok] messageId=9832 latencyMs=172
```

## 3. Safe-сообщение (диагностика `/admin/access`)
```
2025-11-26T08:45:48.114Z [router][admin][info] route="/admin/access" requestId="req-a1d1b7" status=200 invalidate="none"
2025-11-26T08:45:48.118Z [admin.access][safe][info] admin help sent { requestId="req-a1d1b7", safeMessage="Access diagnostics ping. Please ignore this message." }
2025-11-26T08:45:48.271Z [telegram][sendText][ok] messageId=9833 latencyMs=153 note="[safe] done"
```

> Все три события отработали с `HTTP 200`, что подтверждает отсутствие повторных 429 и доставку как основных, так и safe-пинг сообщений.
