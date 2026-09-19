# The Vercel project. Cron schedules are NOT here: Vercel reads them from
# vercel.json in the repository, so the schedule lives next to the code it
# invokes rather than in a plan the application developer never runs.

resource "vercel_project" "app" {
  name      = var.project_name
  framework = "nextjs"

  git_repository = {
    type = "github"
    repo = var.github_repo
  }

  # The Next app is not at the repository root, and the default build cannot
  # work here: `pnpm install` does not build workspace packages, and both
  # @convertio/contracts and @convertio/core resolve through their dist/, so a
  # bare `next build` fails on "Module not found" for each of them.
  #
  # The `...` in the filter is load-bearing: it selects the package AND its
  # workspace dependencies, building them in topological order first.
  root_directory = "apps/edge"
  build_command  = "cd ../.. && pnpm --filter @convertio/edge... build"

  # pnpm walks up to pnpm-workspace.yaml, so this installs the whole workspace
  # even though it runs from apps/edge. --frozen-lockfile so a stale lockfile
  # fails the deploy instead of silently resolving differently than CI did.
  install_command = "pnpm install --frozen-lockfile"

  # Root package.json requires >=22.
  node_version = "22.x"

  # With root_directory set, Vercel skips builds for pushes that do not touch
  # that directory. That is wrong here: a change to packages/core or
  # packages/contracts must redeploy. Exit 1 means "do not skip".
  ignore_command = "exit 1"

  # A push to a non-production branch should not be able to write to the
  # production database, and a preview deployment of a bandit is a live
  # experiment. Previews stay off until there is a preview Neon branch to
  # point them at.
  git_fork_protection                               = true
  automatically_expose_system_environment_variables = true

  # Functions run next to the database. The Neon project is aws-us-east-2 and
  # iad1 is the closest Vercel region; a worker that recomputes posteriors
  # across many rows should not pay a cross-country round trip per query.
  resource_config = {
    function_default_regions = ["iad1"]
  }
}

# ---------------------------------------------------------------------------
# Environment variables
#
# Set on production only. Every value here is either a secret or a pointer to
# one; none of them have safe defaults, which is why none are defaulted.
# ---------------------------------------------------------------------------

locals {
  # Values that must exist for the deployment to function at all.
  required_env = {
    DATABASE_URL             = var.database_url
    UPSTASH_REDIS_REST_URL   = "https://${upstash_redis_database.mirror.endpoint}"
    UPSTASH_REDIS_REST_TOKEN = upstash_redis_database.mirror.rest_token
    CRON_SECRET              = var.cron_secret
  }

  # Values that switch a capability on. An unset one disables its feature
  # cleanly rather than half-enabling it.
  optional_env = {
    SHOPIFY_WEBHOOK_SECRET = var.shopify_webhook_secret
    STRIPE_WEBHOOK_SECRET  = var.stripe_webhook_secret
    META_PIXEL_ID          = var.meta_pixel_id
    META_CAPI_ACCESS_TOKEN = var.meta_capi_access_token
    ADMIN_ALLOWED_EMAILS   = var.admin_allowed_emails
  }

  env = merge(local.required_env, { for k, v in local.optional_env : k => v if v != "" })
}

resource "vercel_project_environment_variable" "app" {
  for_each = local.env

  project_id = vercel_project.app.id
  key        = each.key
  value      = each.value
  target     = ["production"]
  sensitive  = true
}

# ---------------------------------------------------------------------------
# Domain
# ---------------------------------------------------------------------------

resource "vercel_project_domain" "production" {
  count = var.production_domain == null ? 0 : 1

  project_id = vercel_project.app.id
  domain     = var.production_domain
}
