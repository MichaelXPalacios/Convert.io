output "project_id" {
  description = "Vercel project id."
  value       = vercel_project.app.id
}

output "production_url" {
  description = "Production URL, custom domain when one is configured."
  value       = var.production_domain != null ? "https://${var.production_domain}" : "https://${var.project_name}.vercel.app"
}
