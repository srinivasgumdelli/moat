output "job_name" {
  description = "Cloud Run Job name"
  value       = google_cloud_run_v2_job.intel_digest.name
}

output "image_url" {
  description = "Artifact Registry image URL"
  value       = local.image
}

output "scheduler_job" {
  description = "Cloud Scheduler job name"
  value       = google_cloud_scheduler_job.intel_digest.name
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
