#!/usr/bin/env bash
set -euo pipefail

if ! command -v wrangler >/dev/null 2>&1; then
  echo "wrangler CLI is required but not found in PATH" >&2
  exit 1
fi

secrets=(
  OPENAI_API_KEY
  OPENAI_MODEL
  OPENAI_PROMPT_ID
  OPENAI_PROMPT_VARIABLES
  TELEGRAM_BOT_TOKEN
  TELEGRAM_WEBHOOK_SECRET
  ADMIN_TOKEN
)

echo "==> Starting interactive Wrangler secret configuration"
for secret in "${secrets[@]}"; do
  env_var="CF_SECRET_${secret}"
  if [[ -n "${!env_var-}" ]]; then
    printf 'Setting %s from %s\n' "$secret" "$env_var"
    printf '%s' "${!env_var}" | wrangler secret put "$secret" >/dev/null
  else
    echo "Setting $secret (input will not be echoed):"
    wrangler secret put "$secret"
  fi
  echo
  sleep 0.2
done

echo "==> Secret bootstrap completed"

