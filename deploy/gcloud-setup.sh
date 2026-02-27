#!/usr/bin/env bash
# One-time setup for Google Cloud Run Jobs + Cloud Scheduler.
#
# Prerequisites:
#   1. Google Cloud account (free tier): https://cloud.google.com/free
#   2. gcloud CLI installed: https://cloud.google.com/sdk/docs/install
#   3. Logged in: gcloud auth login
#
# Usage:
#   ./deploy/gcloud-setup.sh

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────
PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID env var}"
REGION="${GCP_REGION:-us-central1}"
JOB_NAME="intel-digest"
REPO_NAME="intel"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/${JOB_NAME}"
SCHEDULE="${DIGEST_SCHEDULE:-0 6,18 * * *}"  # 6 AM and 6 PM UTC

echo "==> Project: ${PROJECT_ID}"
echo "==> Region:  ${REGION}"
echo "==> Image:   ${IMAGE}"
echo "==> Schedule: ${SCHEDULE}"
echo ""

# ── Enable APIs ────────────────────────────────────────────────────
echo "==> Enabling APIs..."
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudscheduler.googleapis.com \
  cloudbuild.googleapis.com \
  --project="${PROJECT_ID}"

# ── Create Artifact Registry repo ─────────────────────────────────
echo "==> Creating Artifact Registry repo..."
gcloud artifacts repositories create "${REPO_NAME}" \
  --repository-format=docker \
  --location="${REGION}" \
  --project="${PROJECT_ID}" \
  2>/dev/null || echo "    (repo already exists)"

# ── Configure Docker auth ─────────────────────────────────────────
echo "==> Configuring Docker auth for ${REGION}-docker.pkg.dev..."
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

# ── Build and push image ──────────────────────────────────────────
echo "==> Building and pushing Docker image..."
docker build -t "${IMAGE}:latest" .
docker push "${IMAGE}:latest"

# ── Create Cloud Run Job ──────────────────────────────────────────
echo "==> Creating Cloud Run Job..."
gcloud run jobs create "${JOB_NAME}" \
  --image="${IMAGE}:latest" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --memory=512Mi \
  --cpu=1 \
  --max-retries=1 \
  --task-timeout=10m \
  --set-env-vars="PYTHONUNBUFFERED=1" \
  --set-secrets="\
DEEPSEEK_API_KEY=DEEPSEEK_API_KEY:latest,\
OPENAI_API_KEY=OPENAI_API_KEY:latest,\
GEMINI_API_KEY=GEMINI_API_KEY:latest,\
TELEGRAM_BOT_TOKEN=TELEGRAM_BOT_TOKEN:latest,\
TELEGRAM_CHAT_ID=TELEGRAM_CHAT_ID:latest" \
  2>/dev/null || \
gcloud run jobs update "${JOB_NAME}" \
  --image="${IMAGE}:latest" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --memory=512Mi \
  --cpu=1 \
  --max-retries=1 \
  --task-timeout=10m \
  --set-env-vars="PYTHONUNBUFFERED=1" \
  --set-secrets="\
DEEPSEEK_API_KEY=DEEPSEEK_API_KEY:latest,\
OPENAI_API_KEY=OPENAI_API_KEY:latest,\
GEMINI_API_KEY=GEMINI_API_KEY:latest,\
TELEGRAM_BOT_TOKEN=TELEGRAM_BOT_TOKEN:latest,\
TELEGRAM_CHAT_ID=TELEGRAM_CHAT_ID:latest"

# ── Create Cloud Scheduler trigger ────────────────────────────────
echo "==> Creating Cloud Scheduler trigger..."
gcloud scheduler jobs create http "${JOB_NAME}-schedule" \
  --location="${REGION}" \
  --project="${PROJECT_ID}" \
  --schedule="${SCHEDULE}" \
  --time-zone="UTC" \
  --uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB_NAME}:run" \
  --http-method=POST \
  --oauth-service-account-email="${PROJECT_ID}-compute@developer.gserviceaccount.com" \
  2>/dev/null || \
gcloud scheduler jobs update http "${JOB_NAME}-schedule" \
  --location="${REGION}" \
  --project="${PROJECT_ID}" \
  --schedule="${SCHEDULE}" \
  --time-zone="UTC" \
  --uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB_NAME}:run" \
  --http-method=POST \
  --oauth-service-account-email="${PROJECT_ID}-compute@developer.gserviceaccount.com"

echo ""
echo "==> Done! Your digest will run on schedule: ${SCHEDULE} (UTC)"
echo ""
echo "Useful commands:"
echo "  Run now:     gcloud run jobs execute ${JOB_NAME} --region=${REGION}"
echo "  View logs:   gcloud run jobs executions list --job=${JOB_NAME} --region=${REGION}"
echo "  Update image: docker build -t ${IMAGE}:latest . && docker push ${IMAGE}:latest && gcloud run jobs update ${JOB_NAME} --image=${IMAGE}:latest --region=${REGION}"
