# Credentials are never defaulted and never committed. Supply them through a
# gitignored terraform.tfvars, or TF_VAR_* in CI. See terraform.tfvars.example.

# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------

variable "vercel_api_token" {
  description = "Vercel API token with access to the target team."
  type        = string
  sensitive   = true
}

variable "vercel_team_id" {
  description = "Vercel team id. Null for a personal account."
  type        = string
  default     = null
}

variable "upstash_email" {
  description = "Email of the Upstash account."
  type        = string
}

variable "upstash_api_key" {
  description = "Upstash management API key."
  type        = string
  sensitive   = true
}

# ---------------------------------------------------------------------------
# Project shape
# ---------------------------------------------------------------------------

variable "project_name" {
  description = "Vercel project name."
  type        = string
  default     = "convertio"
}

variable "github_repo" {
  description = "GitHub repository backing the Vercel project, as owner/name."
  type        = string
  default     = "MichaelXPalacios/Convert.io"
}

variable "production_domain" {
  description = "Custom production domain. Null leaves the project on its vercel.app domain."
  type        = string
  default     = null
}

variable "upstash_region" {
  description = "Upstash primary region. Keep it next to the Neon project, which is aws-us-east-2."
  type        = string
  default     = "us-east-1"
}

# ---------------------------------------------------------------------------
# Application secrets
#
# DATABASE_URL_UNPOOLED is deliberately not here. Nothing deployed uses the
# direct connection, and leaving it unset means a deployed route cannot take it
# by accident.
# ---------------------------------------------------------------------------

variable "database_url" {
  description = "Pooled Neon connection string. The unpooled one is for migrations and the seed, and is never deployed."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("-pooler[.]", var.database_url))
    error_message = "database_url must be the POOLED Neon connection string; it should contain '-pooler.'."
  }
}

variable "cron_secret" {
  description = "Shared secret Vercel Cron presents to /api/cron/worker as a bearer token."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.cron_secret) >= 32
    error_message = "cron_secret must be at least 32 characters; it is the only thing standing in front of the worker."
  }
}

variable "shopify_webhook_secret" {
  description = "Shopify webhook signing secret. Empty disables the provider rather than trusting it."
  type        = string
  sensitive   = true
  default     = ""
}

variable "stripe_webhook_secret" {
  description = "Stripe webhook signing secret. Empty disables the provider rather than trusting it."
  type        = string
  sensitive   = true
  default     = ""
}

variable "meta_pixel_id" {
  description = "Meta pixel id. Optional; the forwarder no-ops when unset."
  type        = string
  default     = ""
}

variable "meta_capi_access_token" {
  description = "Meta Conversions API token. Optional; the forwarder no-ops when unset."
  type        = string
  sensitive   = true
  default     = ""
}

variable "admin_allowed_emails" {
  description = "Comma separated email allowlist for the admin surface."
  type        = string
  default     = ""
}
