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

## The Vercel project already exists

It was created by hand before any of this was applied, so Terraform has never
seen it. A plain `apply` would try to **create** a project that exists and
fail on the name, and if it somehow succeeded you would have two.

Import it before the first apply, and read the plan afterwards rather than
accepting it:

```sh
terraform import vercel_project.app <project-id-or-name>
terraform plan
```

Expect that first plan to show changes, because the hand-made project will not
match this configuration — `root_directory`, `build_command`, `node_version`
and `ignore_command` in particular. Those are the settings a default Vercel
build gets wrong here, so the plan converging on them is the point. What it
must **not** show is a change to any `KV_REST_API_*` variable; if it does,
something has reintroduced Upstash into this configuration and applying it
would break the mirror.

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
