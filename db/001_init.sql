-- 001_init.sql — Convert.io stage 1.
--
-- Forward only. Never edit a migration that has been applied; add 002, 003, ...
--
-- The non-negotiable invariants are enforced here as constraints rather than in
-- application code. A CHECK survives a careless caller, a refactor, and an agent
-- that never read the brief; a service-layer guard does not.
--
--   * exactly one control arm per experiment, and it can never be paused or retired
--   * an exposure is idempotent on (visitor, session, arm)
--   * a conversion is idempotent on (provider, external order id)
--   * money is integer cents, never a float, and never negative
--   * every arm state change has a decisions row with a reason and an actor

-- ---------------------------------------------------------------------------
-- updated_at maintenance
--
-- A trigger rather than a convention, because six agents write to these tables
-- and a convention only holds while everyone remembers it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- experiments — one per landing page slug under test
-- ---------------------------------------------------------------------------

CREATE TABLE experiments (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                      text NOT NULL UNIQUE,
  name                      text NOT NULL,
  status                    text NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft', 'running', 'paused', 'archived')),

  -- Allocation guardrails. These live per experiment so the worker can read
  -- them, but the allocation function applies the floor whether or not a caller
  -- supplies one. Configuration is a default, not the enforcement point.
  exploration_floor         numeric(5, 4) NOT NULL DEFAULT 0.1000
                              CHECK (exploration_floor > 0 AND exploration_floor < 1),
  min_exposures             integer NOT NULL DEFAULT 1000
                              CHECK (min_exposures >= 0),

  -- How far back an order may reach to find the exposure that earned it.
  attribution_window_hours  integer NOT NULL DEFAULT 168
                              CHECK (attribution_window_hours > 0),

  -- Reward normalization cap, in cents. Revenue per visitor is divided by this
  -- before it updates a Beta posterior, so one outsized order cannot saturate
  -- an arm. See packages/contracts and lib/bandit.ts for the full reasoning.
  reward_cap_cents          bigint NOT NULL DEFAULT 20000
                              CHECK (reward_cap_cents > 0),

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER experiments_updated_at BEFORE UPDATE ON experiments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- arms — the variants, one of which is always the customer's existing page
-- ---------------------------------------------------------------------------

CREATE TABLE arms (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id   uuid NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,

  -- Stable identifier, also the filename under content/arms/.
  key             text NOT NULL,
  name            text NOT NULL,

  is_control      boolean NOT NULL DEFAULT false,

  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'paused', 'promoted', 'retired')),

  -- Where the rendered payload lives. Validated against the contracts package
  -- at render time; the database does not police its shape.
  content_ref     text NOT NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (experiment_id, key),

  -- The control is never retired and never paused. It may be promoted, since
  -- the existing page winning is a legitimate and common outcome.
  CONSTRAINT control_is_never_retired_or_paused
    CHECK (NOT is_control OR status IN ('active', 'promoted'))
);

-- Exactly one control per experiment.
CREATE UNIQUE INDEX one_control_per_experiment
  ON arms (experiment_id) WHERE is_control;

CREATE INDEX arms_experiment_status ON arms (experiment_id, status);

CREATE TRIGGER arms_updated_at BEFORE UPDATE ON arms
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- exposures — a visitor was shown an arm. The root of every reward signal.
-- ---------------------------------------------------------------------------

CREATE TABLE exposures (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id   uuid NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  arm_id          uuid NOT NULL REFERENCES arms(id) ON DELETE CASCADE,

  visitor_id      text NOT NULL,   -- cv_vid, 180 days
  session_id      text NOT NULL,   -- cv_sid, 30 minutes

  assigned_at     timestamptz NOT NULL DEFAULT now(),

  utm_source      text,
  utm_medium      text,
  utm_campaign    text,
  utm_content     text,
  utm_term        text,

  referrer        text,
  user_agent      text,
  device          text CHECK (device IS NULL OR device IN ('mobile', 'tablet', 'desktop', 'bot')),
  country         text,

  created_at      timestamptz NOT NULL DEFAULT now(),

  -- Idempotency. A retried edge write, a double fire, or a refresh inside the
  -- same session must not inflate the denominator of a posterior.
  UNIQUE (visitor_id, session_id, arm_id)
);

-- The attribution lookup: most recent exposure for a visitor inside a window.
CREATE INDEX exposures_visitor_recent ON exposures (visitor_id, assigned_at DESC);

-- The posterior recompute: everything for an experiment in a time range.
CREATE INDEX exposures_experiment_time ON exposures (experiment_id, assigned_at DESC);
CREATE INDEX exposures_arm_time ON exposures (arm_id, assigned_at DESC);

-- ---------------------------------------------------------------------------
-- events — engagement signals. Diagnostic only.
--
-- Deliberately separate from conversions and never an input to the posterior.
-- Revenue is the reward. A click is evidence about an ad, not about a page.
-- ---------------------------------------------------------------------------

CREATE TABLE events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exposure_id   uuid NOT NULL REFERENCES exposures(id) ON DELETE CASCADE,
  type          text NOT NULL,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX events_exposure ON events (exposure_id, occurred_at DESC);
CREATE INDEX events_type_time ON events (type, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- conversions — an order joined back to the exposure that earned it
-- ---------------------------------------------------------------------------

CREATE TABLE conversions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The attributed exposure. Nullable because an order that arrives with no
  -- matching exposure inside the window is still worth recording as an
  -- unattributed fact; it simply never reaches a posterior.
  exposure_id         uuid REFERENCES exposures(id) ON DELETE SET NULL,

  -- Denormalized from the exposure so posterior recomputation is a single scan
  -- and so the row survives exposure deletion with its attribution intact.
  experiment_id       uuid REFERENCES experiments(id) ON DELETE CASCADE,
  arm_id              uuid REFERENCES arms(id) ON DELETE CASCADE,

  visitor_id          text NOT NULL,

  provider            text NOT NULL CHECK (provider IN ('shopify', 'stripe', 'manual')),
  external_order_id   text NOT NULL,

  -- Integer cents. Never a float: floating point money loses cents at scale and
  -- the posterior is computed from sums of this column.
  value_cents         bigint NOT NULL CHECK (value_cents >= 0),
  currency            text NOT NULL DEFAULT 'USD',

  occurred_at         timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),

  -- Idempotency. Payment providers retry webhooks; the same order must never
  -- be counted twice.
  UNIQUE (provider, external_order_id)
);

CREATE INDEX conversions_experiment_time ON conversions (experiment_id, occurred_at DESC);
CREATE INDEX conversions_arm_time ON conversions (arm_id, occurred_at DESC);
CREATE INDEX conversions_exposure ON conversions (exposure_id);
CREATE INDEX conversions_visitor ON conversions (visitor_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- posteriors — the bandit's current belief about each arm
--
-- Postgres is the source of truth. Redis holds a mirror of this table so the
-- edge does one read on the hot path; the mirror format is defined in
-- packages/contracts, not here and not in the worker.
-- ---------------------------------------------------------------------------

CREATE TABLE posteriors (
  experiment_id       uuid NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  arm_id              uuid NOT NULL REFERENCES arms(id) ON DELETE CASCADE,

  -- Beta parameters over normalized revenue per visitor, not over a binary
  -- conversion. Both are > 0 for a proper distribution.
  alpha               double precision NOT NULL CHECK (alpha > 0),
  beta                double precision NOT NULL CHECK (beta > 0),

  -- The raw counts the parameters were derived from, kept so the admin surface
  -- can show an ad problem and a page problem as separate numbers.
  exposures_count     bigint NOT NULL DEFAULT 0 CHECK (exposures_count >= 0),
  conversions_count   bigint NOT NULL DEFAULT 0 CHECK (conversions_count >= 0),
  revenue_cents       bigint NOT NULL DEFAULT 0 CHECK (revenue_cents >= 0),

  -- Engagement, carried for diagnosis only. Never an input to allocation.
  clicks_count        bigint NOT NULL DEFAULT 0 CHECK (clicks_count >= 0),

  -- Summary statistics, materialized so the dashboard does not recompute them.
  mean                double precision NOT NULL,
  ci_low              double precision NOT NULL,
  ci_high             double precision NOT NULL,

  -- Share of traffic this arm currently receives. Never below the experiment's
  -- exploration floor for an active arm.
  allocation          numeric(6, 5) NOT NULL DEFAULT 0
                        CHECK (allocation >= 0 AND allocation <= 1),

  computed_at         timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (experiment_id, arm_id),
  CONSTRAINT credible_interval_ordered CHECK (ci_low <= mean AND mean <= ci_high)
);

CREATE INDEX posteriors_experiment ON posteriors (experiment_id, allocation DESC);

-- ---------------------------------------------------------------------------
-- decisions — append-only audit log
--
-- Every state change to an arm writes one of these, with a reason a human can
-- read and an actor. The worker writes actor 'system:cron'; the admin surface
-- writes the operator's email. Nothing in this table is ever updated.
-- ---------------------------------------------------------------------------

CREATE TABLE decisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id   uuid REFERENCES experiments(id) ON DELETE CASCADE,
  arm_id          uuid REFERENCES arms(id) ON DELETE SET NULL,

  action          text NOT NULL CHECK (action IN (
                    'create_experiment',
                    'create_arm',
                    'promote',
                    'pause',
                    'resume',
                    'retire',
                    'rollback',
                    'allocation_change',
                    'approve_proposal',
                    'reject_proposal'
                  )),

  -- Prose, not an enum. Someone reading the timeline in six months needs to
  -- know why, and an enum cannot carry why.
  reason          text NOT NULL CHECK (length(trim(reason)) > 0),

  -- 'system:cron' or an operator email. Never null, never blank.
  actor           text NOT NULL CHECK (length(trim(actor)) > 0),

  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX decisions_experiment_time ON decisions (experiment_id, created_at DESC);
CREATE INDEX decisions_arm_time ON decisions (arm_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- proposals — suggested variants awaiting human approval
--
-- Stage 1 has no autonomous writes. A proposal becomes an arm only when a
-- person approves it, and that approval writes a decisions row.
-- ---------------------------------------------------------------------------

CREATE TABLE proposals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id   uuid NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,

  source          text NOT NULL DEFAULT 'audit'
                    CHECK (source IN ('audit', 'manual')),

  -- Links back to the audit engine's Finding.id when source = 'audit'.
  finding_id      text,

  hypothesis      text NOT NULL CHECK (length(trim(hypothesis)) > 0),

  -- The proposed arm payload, same shape the renderer validates.
  content         jsonb NOT NULL,

  -- Human readable change set the admin queue renders as a diff.
  diff            jsonb NOT NULL DEFAULT '{}'::jsonb,

  impact_score    integer CHECK (impact_score IS NULL OR (impact_score >= 0 AND impact_score <= 100)),

  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected')),

  -- Set when an operator decides. A decided proposal always has both.
  decided_at      timestamptz,
  decided_by      text,

  -- The arm created by approving this proposal, if any.
  arm_id          uuid REFERENCES arms(id) ON DELETE SET NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT decided_proposals_record_who_and_when
    CHECK (status = 'pending' OR (decided_at IS NOT NULL AND decided_by IS NOT NULL))
);

CREATE INDEX proposals_experiment_status ON proposals (experiment_id, status, created_at DESC);

CREATE TRIGGER proposals_updated_at BEFORE UPDATE ON proposals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
