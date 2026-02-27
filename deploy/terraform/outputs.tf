output "job_name" {
  description = "Cloud Run Job name"
  value       = var.create_job ? google_cloud_run_v2_job.intel_digest[0].name : null
}

output "image_url" {
  description = "Artifact Registry image URL"
  value       = local.image
}

output "scheduler_job" {
  description = "Cloud Scheduler job name"
  value       = var.create_job ? google_cloud_scheduler_job.intel_digest[0].name : null
}

output "service_account_email" {
  description = "Service account used by the job"
  value       = google_service_account.intel_digest.email
}

output "docker_push_command" {
  description = "Run this to build and push the Docker image"
  value       = "docker build -t ${local.image} ../.. && docker push ${local.image}"
}

output "manual_run_command" {
  description = "Run the job manually"
  value       = "gcloud run jobs execute intel-digest --region=${var.region}"
}

output "cloud_build_trigger" {
  description = "Cloud Build trigger name"
  value       = google_cloudbuild_trigger.deploy.name
}
