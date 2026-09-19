# Infrastructure

Terraform for the Vercel project and the Upstash database behind the posterior
mirror. Nothing here has been applied — the configuration is validated against
the real provider schemas, but no infrastructure exists yet.

## What this does and does not own

Owns: the Vercel project, its production environment variables, an optional
custom domain, and the Upstash Redis database.

Does not own Neon. The project and its branches belong to the Neon CLI and
`neon.ts`, so that exactly one system claims them. Nothing you do against a
Neon branch needs to route through Terraform.

Does not own the cron schedule either. Vercel reads schedules from
`vercel.json` at the repository root, which keeps the schedule next to the
route it invokes rather than in a plan the application developer never runs.

## Running it

```sh
cp terraform.tfvars.example terraform.tfvars   # then fill it in
make plan                                      # terraform plan
make apply                                     # terraform apply
```

`terraform.tfvars` is gitignored. In CI, set `TF_VAR_*` environment variables
instead of writing the file.

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
