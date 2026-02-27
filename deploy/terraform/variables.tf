variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region for all resources"
  type        = string
  default     = "us-central1"
}

variable "schedule" {
  description = "Cron schedule for the digest (UTC)"
  type        = string
  default     = "0 4,16 * * *"
}

variable "image_tag" {
  description = "Docker image tag to deploy"
  type        = string
  default     = "latest"
}

variable "trigger_branch" {
  description = "Branch that triggers Cloud Build"
  type        = string
  default     = "main"
}

variable "create_job" {
  description = "Create the Cloud Run Job and Scheduler (set true after first image push)"
  type        = bool
  default     = false
}

# ── Secrets ──────────────────────────────────────────────────────────

variable "deepseek_api_key" {
  description = "DeepSeek API key"
  type        = string
  sensitive   = true
}

variable "openai_api_key" {
  description = "OpenAI API key"
  type        = string
  sensitive   = true
}

variable "gemini_api_key" {
  description = "Google Gemini API key"
  type        = string
  sensitive   = true
}

variable "telegram_bot_token" {
  description = "Telegram bot token"
  type        = string
  sensitive   = true
}

variable "telegram_chat_id" {
  description = "Telegram chat ID for digest delivery"
  type        = string
  sensitive   = true
}
