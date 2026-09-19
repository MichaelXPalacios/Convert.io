# Providers are pinned to a major version. Neon is deliberately absent: the
# project and its branches are owned by the Neon CLI and neon.ts, and two
# systems claiming one resource is how a branch gets destroyed by a plan
# nobody read carefully.

terraform {
  required_version = ">= 1.9"

  required_providers {
    vercel = {
      source  = "vercel/vercel"
      version = "~> 3.0"
    }
    upstash = {
      source  = "upstash/upstash"
      version = "~> 1.5"
    }
  }
}

provider "vercel" {
  api_token = var.vercel_api_token
  team      = var.vercel_team_id
}

provider "upstash" {
  email   = var.upstash_email
  api_key = var.upstash_api_key
}
