#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_command wrangler
require_command curl
require_command jq

WORKER_BASE_URL=${WORKER_BASE_URL:-}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN:-}
TELEGRAM_WEBHOOK_SECRET=${TELEGRAM_WEBHOOK_SECRET:-}

if [[ -z "$WORKER_BASE_URL" || -z "$TELEGRAM_BOT_TOKEN" || -z "$TELEGRAM_WEBHOOK_SECRET" ]]; then
  cat >&2 <<'MSG'
Environment variables WORKER_BASE_URL, TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET are required.
Example:
  export WORKER_BASE_URL="https://tg-responcer.egormob.workers.dev"
  export TELEGRAM_BOT_TOKEN="123456:ABC"
  export TELEGRAM_WEBHOOK_SECRET="super-secret"
MSG
  exit 1
fi

trimmed_base=${WORKER_BASE_URL%/}
webhook_url="${trimmed_base}/webhook/${TELEGRAM_WEBHOOK_SECRET}"

log "Checking TELEGRAM_WEBHOOK_SECRET presence via wrangler secret list"
secret_json=$(wrangler secret list --json)
if echo "$secret_json" | jq -e '.[] | select(.name == "TELEGRAM_WEBHOOK_SECRET")' >/dev/null; then
  log "Secret already configured in Cloudflare Worker"
else
  log "Secret missing. Uploading value from TELEGRAM_WEBHOOK_SECRET"
  printf '%s' "$TELEGRAM_WEBHOOK_SECRET" | wrangler secret put TELEGRAM_WEBHOOK_SECRET >/dev/null
  log "Secret stored. Run 'wrangler deploy' afterwards to propagate the new value."
fi

log "Ensure worker is deployed after rotating secrets (script does not run deploy automatically)."
log "Setting Telegram webhook to ${webhook_url}"
set_webhook_response=$(curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=${webhook_url}" \
  -d "drop_pending_updates=true")
log "Telegram setWebhook response: ${set_webhook_response}"

log "Fetching webhook info"
webhook_info=$(curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo")
log "Telegram getWebhookInfo response: ${webhook_info}"

if echo "$webhook_info" | jq -e '.ok == true and .result.url == "'"${webhook_url}"'" and (.result.last_error_message == null or .result.last_error_message == "")' >/dev/null; then
  log "Webhook URL matches worker endpoint and no last_error_message is reported."
else
  log "Webhook info indicates mismatch or error. Investigate manually."
fi
