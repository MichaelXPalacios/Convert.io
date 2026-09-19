# Providers are pinned to a major version.
#
# Two things are deliberately absent, for the same reason: one owner per
# resource, because two systems claiming one resource is how it gets destroyed
# by a plan nobody read carefully.
#
#   Neon      — the project and its branches belong to the Neon CLI and neon.ts.
#   Upstash   — the database is provisioned through the Vercel Marketplace,
#               which injects its credentials into the project directly.

terraform {
  required_version = ">= 1.9"

  required_providers {
    vercel = {
      source  = "vercel/vercel"
      version = "~> 3.0"
    }
  }
}

provider "vercel" {
  api_token = var.vercel_api_token
  team      = var.vercel_team_id
}
