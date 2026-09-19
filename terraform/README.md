# Infrastructure

Terraform for the Vercel project and the Upstash database behind the posterior
mirror. Nothing here has been applied — the configuration is validated against
the real provider schemas, but no infrastructure exists yet.

## What this does and does not own

Owns: the Vercel project, its production environment variables, and an
optional custom domain.

Does not own Neon. The project and its branches belong to the Neon CLI and
`neon.ts`, so that exactly one system claims them. Nothing you do against a
Neon branch needs to route through Terraform.

Does not own Upstash either, and this one is a trap worth stating plainly.
The database is provisioned through the Vercel Marketplace, which injects
`KV_REST_API_URL` and `KV_REST_API_TOKEN` into the project. Terraform must not
create a second database or set `UPSTASH_REDIS_REST_*`: `packages/core` checks
`UPSTASH_REDIS_REST_URL` **before** `KV_REST_API_URL`, so those names pointing
at a different database would silently win. The failure is not an error — it
is an empty mirror, which the request path handles by serving the control arm
to every visitor indefinitely.

Does not own the cron schedule either. Vercel reads schedules from
`vercel.json` at the repository root, which keeps the schedule next to the
route it invokes rather than in a plan the application developer never runs.

## The first apply creates the project

No Vercel project exists yet. Checked against the live API with a working
token on 2026-09-19: authenticated as the account owner, zero teams, zero
projects in personal scope, and `GET /v9/projects/convertio` returning 404.

So there is nothing to import, and `terraform import` would fail with nothing
to bind to. The first `apply` is a **create**.

That makes this configuration a specification rather than a diff. Everything
`vercel.tf` sets — `root_directory`, `build_command`, `install_command`,
`node_version`, `ignore_command` — is what the project will be, not what it
will be reconciled toward. Read it as such before the first apply, because a
default Vercel build cannot work for this repository: `pnpm install` does not
build workspace packages, and `@convertio/contracts` and `@convertio/core`
both resolve through their `dist/`.

One consequence worth knowing before you run it. Any webhook secret set in
`terraform.tfvars` becomes a real deployed value on creation, which flips that
provider from disabled to live in the same moment the project appears. See the
note below on what an empty secret means.

If the project turns out to exist under a different Vercel account than the
token's, none of the above holds — import it first, and expect that plan to
converge the build settings above.

## Running it

```sh
cp terraform.tfvars.example terraform.tfvars   # then fill it in
make plan                                      # terraform plan
make apply                                     # terraform apply
```

`terraform.tfvars` is gitignored. In CI, set `TF_VAR_*` environment variables
instead of writing the file.

An empty `shopify_webhook_secret` or `stripe_webhook_secret` is a **working**
configuration, not a broken one, and that is the trap. The order webhook
treats an unset secret as "this provider is disabled" rather than "skip
verification" — which is the right call, since the alternative is accepting
unverifiable orders. But the result is a deployment that comes up healthy and
silently records no revenue from that provider. If conversions are missing for
one provider and nothing is erroring, check these two first.

Two variables are validated rather than trusted:

- `database_url` must be the **pooled** Neon string, the one containing
  `-pooler.`. The unpooled string is for migrations and the seed, and is never
  deployed — a route that could reach the direct connection eventually will.
- `cron_secret` must be at least 32 characters. Vercel Cron presents it to
  `/api/cron/worker` as a bearer token and it is the only thing in front of
  that route.

## State

State is local and gitignored, which is fine for one operator and wrong for
two. Before a second person runs `apply`, move it to a remote backend —
otherwise the first concurrent apply silently diverges from the second.

## Cron frequency

`vercel.json` recomputes posteriors every 15 minutes. Vercel's Hobby plan
allows only daily cron invocations; this schedule needs Pro. If the account is
on Hobby the deployment succeeds and the cron simply does not fire at the
requested rate, which looks like a stalled bandit rather than a billing
problem.
