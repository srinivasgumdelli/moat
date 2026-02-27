#!/usr/bin/env bash
# Store API keys in Google Secret Manager (one-time).
#
# Reads from your local .env file and creates secrets in GCP.
#
# Usage:
#   ./deploy/gcloud-secrets.sh

set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID env var}"

echo "==> Enabling Secret Manager API..."
gcloud services enable secretmanager.googleapis.com --project="${PROJECT_ID}"

ENV_FILE="${1:-.env}"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Error: ${ENV_FILE} not found"
  exit 1
fi

SECRETS=(DEEPSEEK_API_KEY OPENAI_API_KEY GEMINI_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID)

for key in "${SECRETS[@]}"; do
  value=$(grep "^${key}=" "${ENV_FILE}" | cut -d'=' -f2- | tr -d "'\"")
  if [[ -z "${value}" ]]; then
    echo "    Skipping ${key} (empty or not found in ${ENV_FILE})"
    continue
  fi

  echo "==> Creating secret: ${key}"
  printf '%s' "${value}" | gcloud secrets create "${key}" \
    --data-file=- \
    --project="${PROJECT_ID}" \
    2>/dev/null || \
  printf '%s' "${value}" | gcloud secrets versions add "${key}" \
    --data-file=- \
    --project="${PROJECT_ID}"

  echo "    ${key} ✓"
done

echo ""
echo "==> Done. Now run: ./deploy/gcloud-setup.sh"
