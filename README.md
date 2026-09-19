# Convert.io

A landing-page experiment system. Visitors are assigned to page variants by a
multi-armed bandit, orders are attributed back to the variant that earned them,
and traffic shifts toward whatever actually produces revenue.

The reward is revenue, not clicks. A click is evidence about an ad; only an
order is evidence about a page. Engagement is recorded and shown, but it never
reaches a posterior.

## Layout

| Path                 | What it is                                                        |
| -------------------- | ----------------------------------------------------------------- |
| `packages/contracts` | Every boundary in the system, defined once. Read-only by default. |
| `packages/worker`    | Posterior recompute: exposures and orders in, posteriors out.     |
| `apps/edge`          | The request path — variant assignment and visitor identity.       |
| `db/`                | Forward-only migrations and the development seed.                 |
| `terraform/`         | Vercel project and the Upstash database.                          |
| `Convert/`           | The standalone audit engine that proposes variants.               |

`packages/contracts` is the interface freeze. Several people and agents build
against it in parallel, so a shape that needs changing is escalated rather than
edited — a contract one owner edits while others build against it is not a
contract.

## Prerequisites

- **Node 22 or newer.** Not optional: `neon skills` refuses anything below
  22.20, and the root `package.json` sets `engines.node >= 22`. If your system
  Node is older, `fnm use 22` (or `nvm`) before anything else.
- **pnpm** — the version is pinned by `packageManager`, so `corepack enable` is
  enough.
- **Terraform** — only if you are touching `terraform/`.

## Getting started

```sh
pnpm install
cp .env.example .env.local        # then fill it in
pnpm migrate                      # apply db/*.sql
pnpm test
```

`.env.local` is gitignored and holds live credentials. Nothing in this repo
reads a credential from anywhere but the environment.

The Neon CLI writes `.env.local` for you if the directory is linked:

```sh
neon link --project-id <id> --branch <branch>
```

## Database

Migrations are **forward only**. `db/migrate.mjs` records a checksum of every
file it applies and refuses to run if one has changed since, because an edited
migration means the database you are looking at and the database CI builds are
different objects. To change the schema, add `db/002_*.sql`.

CI enforces the same rule on pull requests: modifying or deleting an existing
`db/*.sql` fails the build.

```sh
pnpm migrate   # apply pending migrations
pnpm seed      # one running experiment, a control and two variants
```

`pnpm seed` **refuses to run against a branch named production** unless you
pass `--force`. Seed traffic becomes exposures and posteriors that the request
path reads and acts on, and deleting the rows afterwards does not undo the
allocations they already produced.

## Who owns what

Neon belongs to the Neon CLI and `neon.ts`, **not** to Terraform. Terraform
owns the Vercel project, its environment variables, and the Upstash database.
One system per resource, so a plan nobody read carefully cannot destroy a
branch.

Cron schedules live in `vercel.json` rather than Terraform, because Vercel
reads them from the repository. Vercel Cron issues **GET**, not POST — the
worker route is authenticated by the `CRON_SECRET` bearer token, and the
request being a GET grants it nothing.

## CI

Every push and pull request runs build, typecheck, lint, format and tests.
Two additional guards:

- **Credentials** — the build fails if `.env.local` or `.neon` ever become
  tracked, or if a Postgres URL with an inline password is committed.
- **Migrations** — a pull request that edits an existing migration fails.

Changes under `terraform/` additionally run `fmt` and `validate` against the
real provider schemas. That check is worth more than it looks: it is what
catches `node_version = "22"` being invalid where `"22.x"` is correct.

## Gotchas

**An existing clone needs its line endings refreshed once.** `.gitattributes`
pins LF, but git will not re-materialize files already on disk, so
`prettier --check` may fail on files you never touched. Once:

```sh
git rm --cached -rq . && git reset --hard
```

A fresh clone is already correct and needs nothing.

**`make plan` and `make apply` need Terraform on your PATH**, and
`terraform/terraform.tfvars` filled in from the example.

**Nothing in `terraform/` has been applied.** The configuration is validated,
but it has never created infrastructure. Read `terraform/README.md` before the
first apply — in particular, state is local, which is correct for one operator
and wrong for two.
