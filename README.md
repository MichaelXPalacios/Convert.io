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
| `packages/audit`     | Reads a landing page and proposes variants worth testing.         |

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

### Branches

| Branch        | What it is                                                         |
| ------------- | ------------------------------------------------------------------ |
| `production`  | The default branch. Real visitors, real orders. Never seeded.      |
| `development` | Branched from production. Carries the seed; point local work here. |

`development` is what `.env.local` should address. Pointing local work at
production is not a smaller version of the same thing: the request path reads
posteriors and writes exposures, so a `pnpm dev` against production is a live
experiment with an audience of one.

Ephemeral branches — one per pull request, per experiment, per developer — are
policy rather than ceremony. `neon.ts` gives anything named `preview/*`,
`pr-*` or `dev-*` a parent of `development`, a seven-day expiry and a 1 CU
ceiling, so a branch created by `neon checkout preview/my-feature` is born
cheap and cleans itself up.

They are parented on `development` rather than `production` deliberately. A
preview deployment of a bandit is a live experiment; copying production rows
into a branch it will write exposures into mixes demo traffic with revenue
data that cannot be un-mixed afterwards. When you want production-shaped data
— testing a migration against real row volumes — create that branch
explicitly and delete it when you are done:

```sh
neon branches create --name migration-test --parent production \
  --expires-at <iso8601>
```

The policy only applies to branches that do not exist yet; `production` and
`development` were created by hand and are managed by hand. `neon config plan`
shows what `neon deploy` would change, and against both of them it shows
nothing, by design.

## The HTTP boundary

Every route is defined once in `packages/contracts/src/wire.ts` and parses its
input with that schema. A route accepting a shape defined anywhere else is
outside the contract.

| Route                | Method | What it does                                             |
| -------------------- | ------ | -------------------------------------------------------- |
| `/api/track`         | POST   | Records an exposure. The denominator of every posterior. |
| `/api/event`         | POST   | Engagement. Diagnostic only; never reaches a posterior.  |
| `/api/webhook/order` | POST   | Shopify and Stripe orders. Where revenue enters.         |
| `/api/cron/worker`   | GET    | Recomputes posteriors and publishes the mirror.          |

Three rules hold across them, and each exists because the alternative fails
quietly rather than loudly.

**Identity is never taken from a request body.** `/api/track` reads the
visitor, session and arm from the proxy's HttpOnly cookies, and fills the user
agent, device and country from request headers, even though `TrackRequest`
names all of them. They are the idempotency key and the attribution key at
once, so a caller who can name its own `visitorId` can mint exposures for an
arm it was never shown — and the only symptom is a posterior that stops
matching reality.

**Signatures are verified against the raw body, before parsing.**
`JSON.parse` followed by `JSON.stringify` does not round-trip, so a signature
checked against re-serialized bytes verifies something the sender never sent.
An unset provider secret disables that provider rather than trusting it.

**Writes that a caller may retry are idempotent.** Exposures on
(visitor, session, arm), conversions on (provider, external order id). Payment
providers redeliver, beacons double-fire, and cron overlaps; none of those may
count twice.

One known bias, recorded because it is invisible at the call site: exposures
depend on client JavaScript running, so ad blockers and pre-hydration bounces
lose some, and not uniformly across arms. It is partly self-cancelling — a
conversion whose exposure is missing attributes to nothing either — and worth
watching the loss rate once there is real traffic.

## Who owns what

Neon belongs to the Neon CLI and `neon.ts` — the project, its branches, and
their compute profile — **not** to Terraform. Terraform owns the Vercel
project, its environment variables, and the Upstash database. One system per
resource, so a plan nobody read carefully cannot destroy a branch.

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
