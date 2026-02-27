terraform {
  required_version = ">= 1.3"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# ── Data Sources ─────────────────────────────────────────────────────

data "google_project" "current" {
  project_id = var.project_id
}

# ── Locals ───────────────────────────────────────────────────────────

locals {
  apis = [
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudscheduler.googleapis.com",
    "cloudbuild.googleapis.com",
    "secretmanager.googleapis.com",
    "storage.googleapis.com",
    "iamcredentials.googleapis.com",
  ]

  secrets = {
    DEEPSEEK_API_KEY   = var.deepseek_api_key
    OPENAI_API_KEY     = var.openai_api_key
    GEMINI_API_KEY     = var.gemini_api_key
    TELEGRAM_BOT_TOKEN = var.telegram_bot_token
    TELEGRAM_CHAT_ID   = var.telegram_chat_id
  }

  image = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.intel.repository_id}/intel-digest:${var.image_tag}"
}

# ── Enable APIs ──────────────────────────────────────────────────────

resource "google_project_service" "apis" {
  for_each = toset(local.apis)

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# ── Artifact Registry ────────────────────────────────────────────────

resource "google_artifact_registry_repository" "intel" {
  repository_id = "intel"
  location      = var.region
  format        = "DOCKER"
  description   = "Docker images for intel-digest pipeline"

  depends_on = [google_project_service.apis["artifactregistry.googleapis.com"]]
}

# ── Secret Manager ───────────────────────────────────────────────────

resource "google_secret_manager_secret" "secrets" {
  for_each = local.secrets

  secret_id = each.key

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis["secretmanager.googleapis.com"]]
}

resource "google_secret_manager_secret_version" "secrets" {
  for_each = local.secrets

  secret      = google_secret_manager_secret.secrets[each.key].id
  secret_data = each.value
}

resource "google_secret_manager_secret" "config" {
  secret_id = "intel-digest-config"

  replication {
    auto {}
  }

  depends_on = [google_project_service.apis["secretmanager.googleapis.com"]]
}

resource "google_secret_manager_secret_version" "config" {
  secret      = google_secret_manager_secret.config.id
  secret_data = file("../../config.yaml")
}

# ── Service Account ──────────────────────────────────────────────────

resource "google_service_account" "intel_digest" {
  account_id   = "intel-digest"
  display_name = "Intel Digest Cloud Run Job"

  depends_on = [google_project_service.apis["run.googleapis.com"]]
}

resource "google_project_iam_member" "run_invoker" {
  project = var.project_id
  role    = "roles/run.invoker"
  member  = "serviceAccount:${google_service_account.intel_digest.email}"
}

resource "google_project_iam_member" "secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.intel_digest.email}"
}

resource "google_project_iam_member" "ar_writer" {
  project = var.project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${google_service_account.intel_digest.email}"
}

resource "google_project_iam_member" "log_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.intel_digest.email}"
}

resource "google_project_iam_member" "run_admin" {
  project = var.project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.intel_digest.email}"
}

resource "google_project_iam_member" "sa_user" {
  project = var.project_id
  role    = "roles/iam.serviceAccountUser"
  member  = "serviceAccount:${google_service_account.intel_digest.email}"
}

# ── GCS Bucket (private — HTML digests accessed via signed URLs) ─────

resource "google_storage_bucket" "digest_html" {
  name          = var.gcs_digest_bucket
  location      = var.region
  force_destroy = false

  uniform_bucket_level_access = true

  lifecycle_rule {
    condition {
      age = 30
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.apis["storage.googleapis.com"]]
}

# SA can upload objects
resource "google_storage_bucket_iam_member" "digest_writer" {
  bucket = google_storage_bucket.digest_html.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.intel_digest.email}"
}

# SA can sign blobs (required for V4 signed URLs via IAM signBlob API)
resource "google_project_iam_member" "sa_sign_blob" {
  project = var.project_id
  role    = "roles/iam.serviceAccountTokenCreator"
  member  = "serviceAccount:${google_service_account.intel_digest.email}"
}

# ── Cloud Run Job ────────────────────────────────────────────────────

resource "google_cloud_run_v2_job" "intel_digest" {
  count = var.create_job ? 1 : 0

  name     = "intel-digest"
  location = var.region

  template {
    template {
      containers {
        image = local.image

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        env {
          name  = "PYTHONUNBUFFERED"
          value = "1"
        }

        env {
          name  = "CONFIG_PATH"
          value = "/etc/intel/config.yaml"
        }

        env {
          name  = "GCS_DIGEST_BUCKET"
          value = google_storage_bucket.digest_html.name
        }

        dynamic "env" {
          for_each = local.secrets
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.secrets[env.key].secret_id
                version = "latest"
              }
            }
          }
        }

        volume_mounts {
          name       = "config"
          mount_path = "/etc/intel"
        }
      }

      volumes {
        name = "config"
        secret {
          secret       = google_secret_manager_secret.config.secret_id
          default_mode = 292 # 0444
          items {
            path    = "config.yaml"
            version = "latest"
          }
        }
      }

      timeout         = "600s"
      max_retries     = 1
      service_account = google_service_account.intel_digest.email
    }
  }

  depends_on = [
    google_project_service.apis["run.googleapis.com"],
    google_secret_manager_secret_version.secrets,
    google_secret_manager_secret_version.config,
    google_project_iam_member.secret_accessor,
  ]
}

# ── Cloud Build ──────────────────────────────────────────────────────
# The Cloud Build trigger is created manually in the GCP console because
# it requires a GitHub App connection (OAuth authorization flow).
# See: Console > Cloud Build > Triggers > Connect Repository

# Cloud Build uses the default Compute Engine SA in newer GCP projects
locals {
  cloudbuild_sa = "serviceAccount:${data.google_project.current.number}-compute@developer.gserviceaccount.com"
}

# Grant Cloud Build SA permission to push images to Artifact Registry
resource "google_project_iam_member" "cloudbuild_ar_writer" {
  project = var.project_id
  role    = "roles/artifactregistry.writer"
  member  = local.cloudbuild_sa
}

# Grant Cloud Build SA permission to update Cloud Run Jobs
resource "google_project_iam_member" "cloudbuild_run_admin" {
  project = var.project_id
  role    = "roles/run.admin"
  member  = local.cloudbuild_sa
}

# Grant Cloud Build SA permission to act as the job's service account
resource "google_project_iam_member" "cloudbuild_sa_user" {
  project = var.project_id
  role    = "roles/iam.serviceAccountUser"
  member  = local.cloudbuild_sa
}

# ── Cloud Scheduler ──────────────────────────────────────────────────

resource "google_cloud_scheduler_job" "intel_digest" {
  count = var.create_job ? 1 : 0

  name      = "intel-digest-schedule"
  schedule  = var.schedule
  time_zone = "UTC"
  region    = var.region

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/intel-digest:run"

    oauth_token {
      service_account_email = google_service_account.intel_digest.email
    }
  }

  depends_on = [
    google_project_service.apis["cloudscheduler.googleapis.com"],
    google_cloud_run_v2_job.intel_digest,
  ]
}
