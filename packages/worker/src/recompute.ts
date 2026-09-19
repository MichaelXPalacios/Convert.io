/**
 * Posterior recompute.
 *
 * Reads exposures and conversions, derives each arm's Beta posterior through
 * the helpers in contracts, writes the `posteriors` rows, and returns the
 * mirror the edge will read.
 *
 * Everything external is injected — the database through `query`, randomness
 * through `sampleBeta`, the clock through `now`. That is not ceremony: it is
 * what lets the whole recompute be tested against fixed inputs with no
 * database, no Redis and no network, which is the only way a statistical
 * calculation gets tested at all.
 *
 * What this deliberately does NOT do:
 *
 *   * It does not attribute. A conversion arrives with arm_id already
 *     denormalized by whoever wrote it, inside the attribution window. By the
 *     time the worker runs, attribution is a fact, not a decision.
 *   * It does not manage transactions. The caller owns the connection and
 *     decides the boundary, because the mirror must not be published before
 *     the rows it describes are durable.
 *   * It does not define the reward. `normalizeReward` lives in contracts so
 *     the worker, a backfill and a simulator cannot disagree about it.
 */

import {
  betaCredibleInterval,
  betaFromRewards,
  betaMean,
  normalizeReward,
  redisPosteriorKey,
  serializePosteriorMirror,
  REDIS_MIRROR_SCHEMA_VERSION,
  type MirrorArm,
  type PosteriorMirror,
} from "@convertio/contracts";

// ---------------------------------------------------------------------------
// Injected boundaries
// ---------------------------------------------------------------------------

export interface QueryResultLike<R> {
  rows: R[];
}

/** Structurally compatible with `pg.Client.query`. */
export type QueryFn = <R>(sql: string, params?: unknown[]) => Promise<QueryResultLike<R>>;

export interface RecomputeDeps {
  query: QueryFn;

  /**
   * A draw from Beta(alpha, beta). Injected rather than implemented here:
   * packages/core owns the sampler the edge allocates with, and a second
   * implementation would eventually disagree with it while both passed their
   * own tests.
   */
  sampleBeta: (alpha: number, beta: number) => number;

  /** Defaults to `() => new Date()`. */
  now?: () => Date;

  /** Monte Carlo draws per arm when estimating share. Defaults to 2000. */
  allocationSamples?: number;
}

// ---------------------------------------------------------------------------
// Row shapes
//
// node-postgres returns numeric and bigint as strings, because they do not fit
// a JS number in general. Every one of these is converted explicitly rather
// than relied on to coerce: `"1000" * 1` works and `"1000" + 1` does not, and
// the difference is a silent wrong number rather than an error.
// ---------------------------------------------------------------------------

interface ExperimentRow {
  id: string;
  slug: string;
  exploration_floor: string;
  min_exposures: string | number;
  reward_cap_cents: string | number;
}

interface ArmRow {
  id: string;
  key: string;
  is_control: boolean;
  status: string;
}

const toNumber = (value: string | number | null | undefined, fallback = 0): number => {
  if (value === null || value === undefined) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/** Arms that may receive traffic. A paused or retired arm is never allocated. */
const ELIGIBLE_STATUSES = new Set(["active", "promoted"]);

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface ArmPosterior {
  armId: string;
  key: string;
  isControl: boolean;
  status: string;
  alpha: number;
  beta: number;
  exposuresCount: number;
  conversionsCount: number;
  revenueCents: number;
  clicksCount: number;
  mean: number;
  ciLow: number;
  ciHigh: number;
  allocation: number;
}

export interface ExperimentRecompute {
  experimentId: string;
  slug: string;
  arms: ArmPosterior[];
  mirror: PosteriorMirror;
  /** Redis key and HSET fields, ready to publish once the rows are durable. */
  mirrorKey: string;
  mirrorFields: Record<string, string>;
  /** True when no arm had an exposure, so the posteriors are still the prior. */
  isCold: boolean;
}

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

/**
 * Advisory share per arm.
 *
 * The edge samples the posterior itself on every request, so this number does
 * not steer traffic — it tells an operator what the sampling is expected to
 * do. It is computed the same way regardless, because a dashboard that
 * disagrees with the mechanism is worse than no dashboard.
 *
 * Below `minExposures` the split is uniform. That is the guardrail doing its
 * job: with almost no evidence, probability-of-best is mostly an artefact of
 * which arm happened to get the first conversion.
 */
export function allocate(
  arms: ReadonlyArray<{ alpha: number; beta: number; status: string; exposuresCount: number }>,
  options: {
    explorationFloor: number;
    minExposures: number;
    sampleBeta: (alpha: number, beta: number) => number;
    samples: number;
  },
): number[] {
  const { explorationFloor, minExposures, sampleBeta, samples } = options;

  const eligible: number[] = [];
  arms.forEach((arm, i) => {
    if (ELIGIBLE_STATUSES.has(arm.status)) eligible.push(i);
  });

  const out = new Array<number>(arms.length).fill(0);
  if (eligible.length === 0) return out;

  const uniform = (): number[] => {
    const share = 1 / eligible.length;
    for (const i of eligible) out[i] = share;
    return round5(out, eligible);
  };

  if (eligible.length === 1) {
    const only = eligible[0] as number;
    out[only] = 1;
    return out;
  }

  // A floor that cannot be satisfied is a misconfiguration, not a reason to
  // silently allocate below it. Uniform is the honest fallback: it is the
  // most exploratory split available.
  if (explorationFloor * eligible.length >= 1) return uniform();

  const totalExposures = eligible.reduce((sum, i) => sum + (arms[i]?.exposuresCount ?? 0), 0);
  if (totalExposures < minExposures) return uniform();

  // Probability that each arm is the best, by Monte Carlo over the posteriors.
  const wins = new Array<number>(arms.length).fill(0);
  for (let s = 0; s < samples; s += 1) {
    let bestIndex = -1;
    let bestDraw = -Infinity;
    for (const i of eligible) {
      const arm = arms[i];
      if (arm === undefined) continue;
      const draw = sampleBeta(arm.alpha, arm.beta);
      if (draw > bestDraw) {
        bestDraw = draw;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) wins[bestIndex] = (wins[bestIndex] ?? 0) + 1;
  }

  const headroom = 1 - explorationFloor * eligible.length;
  for (const i of eligible) {
    out[i] = explorationFloor + headroom * ((wins[i] ?? 0) / samples);
  }

  return round5(out, eligible);
}

/**
 * The allocation column is numeric(6,5), so the stored values must round to
 * five decimals and still sum to one. Rounding each independently leaves a
 * remainder; it is absorbed by the largest eligible share, which is the one
 * where a 1e-5 adjustment is least meaningful.
 */
function round5(values: number[], eligible: number[]): number[] {
  const rounded = values.map((v) => Math.round(v * 1e5) / 1e5);

  let sum = 0;
  for (const i of eligible) sum += rounded[i] ?? 0;

  const drift = Math.round((1 - sum) * 1e5) / 1e5;
  if (drift !== 0 && eligible.length > 0) {
    let target = eligible[0] as number;
    for (const i of eligible) {
      if ((rounded[i] ?? 0) > (rounded[target] ?? 0)) target = i;
    }
    rounded[target] = Math.max(0, Math.round(((rounded[target] ?? 0) + drift) * 1e5) / 1e5);
  }

  return rounded;
}

// ---------------------------------------------------------------------------
// Recompute
// ---------------------------------------------------------------------------

/** Every running experiment, in slug order so a log is diffable run to run. */
export async function recomputeAll(deps: RecomputeDeps): Promise<ExperimentRecompute[]> {
  const { rows } = await deps.query<ExperimentRow>(
    `SELECT id, slug, exploration_floor, min_exposures, reward_cap_cents
       FROM experiments
      WHERE status = 'running'
      ORDER BY slug`,
  );

  const results: ExperimentRecompute[] = [];
  for (const row of rows) {
    results.push(await recomputeExperiment(deps, row));
  }
  return results;
}

async function recomputeExperiment(
  deps: RecomputeDeps,
  experiment: ExperimentRow,
): Promise<ExperimentRecompute> {
  const now = deps.now?.() ?? new Date();
  const samples = deps.allocationSamples ?? 2000;

  const experimentId = experiment.id;
  const rewardCapCents = toNumber(experiment.reward_cap_cents, 1);
  const explorationFloor = toNumber(experiment.exploration_floor, 0.1);
  const minExposures = toNumber(experiment.min_exposures, 0);

  const { rows: armRows } = await deps.query<ArmRow>(
    `SELECT id, key, is_control, status
       FROM arms
      WHERE experiment_id = $1
      ORDER BY is_control DESC, key`,
    [experimentId],
  );

  const exposures = await countBy(deps, experimentId);
  const clicks = await clicksBy(deps, experimentId);
  const conversions = await conversionsBy(deps, experimentId, rewardCapCents);

  const arms: ArmPosterior[] = armRows.map((arm) => {
    const exposuresCount = exposures.get(arm.id) ?? 0;
    const conv = conversions.get(arm.id);
    const rewardSum = conv?.rewardSum ?? 0;

    const { alpha, beta } = betaFromRewards(exposuresCount, rewardSum);
    const mean = betaMean(alpha, beta);
    const { low, high } = betaCredibleInterval(alpha, beta);

    return {
      armId: arm.id,
      key: arm.key,
      isControl: arm.is_control,
      status: arm.status,
      alpha,
      beta,
      exposuresCount,
      conversionsCount: conv?.count ?? 0,
      revenueCents: conv?.revenueCents ?? 0,
      clicksCount: clicks.get(arm.id) ?? 0,
      mean,
      ciLow: low,
      ciHigh: high,
      allocation: 0,
    };
  });

  const allocations = allocate(arms, {
    explorationFloor,
    minExposures,
    sampleBeta: deps.sampleBeta,
    samples,
  });
  arms.forEach((arm, i) => {
    arm.allocation = allocations[i] ?? 0;
  });

  for (const arm of arms) {
    await writePosterior(deps, experimentId, arm, now);
  }

  const mirror: PosteriorMirror = {
    meta: {
      schemaVersion: REDIS_MIRROR_SCHEMA_VERSION,
      experimentId,
      slug: experiment.slug,
      explorationFloor,
      minExposures,
      computedAt: now.toISOString(),
    },
    // Only arms that can actually be served. A paused arm in the mirror is an
    // invitation for the edge to allocate to it.
    arms: arms.filter((a) => ELIGIBLE_STATUSES.has(a.status)).map(toMirrorArm),
  };

  return {
    experimentId,
    slug: experiment.slug,
    arms,
    mirror,
    mirrorKey: redisPosteriorKey(experiment.slug),
    mirrorFields: serializePosteriorMirror(mirror),
    isCold: arms.every((a) => a.exposuresCount === 0),
  };
}

const toMirrorArm = (arm: ArmPosterior): MirrorArm => ({
  armId: arm.armId,
  key: arm.key,
  isControl: arm.isControl,
  status: arm.status as MirrorArm["status"],
  alpha: arm.alpha,
  beta: arm.beta,
  allocation: arm.allocation,
  exposuresCount: arm.exposuresCount,
});

async function writePosterior(
  deps: RecomputeDeps,
  experimentId: string,
  arm: ArmPosterior,
  now: Date,
): Promise<void> {
  await deps.query(
    `INSERT INTO posteriors
       (experiment_id, arm_id, alpha, beta, exposures_count, conversions_count,
        revenue_cents, clicks_count, mean, ci_low, ci_high, allocation, computed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (experiment_id, arm_id) DO UPDATE SET
       alpha             = EXCLUDED.alpha,
       beta              = EXCLUDED.beta,
       exposures_count   = EXCLUDED.exposures_count,
       conversions_count = EXCLUDED.conversions_count,
       revenue_cents     = EXCLUDED.revenue_cents,
       clicks_count      = EXCLUDED.clicks_count,
       mean              = EXCLUDED.mean,
       ci_low            = EXCLUDED.ci_low,
       ci_high           = EXCLUDED.ci_high,
       allocation        = EXCLUDED.allocation,
       computed_at       = EXCLUDED.computed_at`,
    [
      experimentId,
      arm.armId,
      arm.alpha,
      arm.beta,
      arm.exposuresCount,
      arm.conversionsCount,
      arm.revenueCents,
      arm.clicksCount,
      arm.mean,
      arm.ciLow,
      arm.ciHigh,
      arm.allocation,
      now.toISOString(),
    ],
  );
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

async function countBy(deps: RecomputeDeps, experimentId: string): Promise<Map<string, number>> {
  const { rows } = await deps.query<{ arm_id: string; n: string | number }>(
    `SELECT arm_id, count(*) AS n
       FROM exposures
      WHERE experiment_id = $1
      GROUP BY arm_id`,
    [experimentId],
  );
  return new Map(rows.map((r) => [r.arm_id, toNumber(r.n)]));
}

async function clicksBy(deps: RecomputeDeps, experimentId: string): Promise<Map<string, number>> {
  const { rows } = await deps.query<{ arm_id: string; n: string | number }>(
    `SELECT e.arm_id AS arm_id, count(*) AS n
       FROM events ev
       JOIN exposures e ON e.id = ev.exposure_id
      WHERE e.experiment_id = $1 AND ev.type = 'click'
      GROUP BY e.arm_id`,
    [experimentId],
  );
  return new Map(rows.map((r) => [r.arm_id, toNumber(r.n)]));
}

interface ConversionTotals {
  count: number;
  revenueCents: number;
  rewardSum: number;
}

/**
 * Conversion totals per arm, with the reward summed in JS rather than SQL.
 *
 * The obvious version computes `sum(least(value_cents, cap) / cap)` in the
 * query. That would be a second definition of the reward, in a different
 * language, that nothing checks against `normalizeReward` — and the comment on
 * that function says in as many words that a backfill or simulator disagreeing
 * with the worker makes their numbers incomparable.
 *
 * So the query groups by distinct order value instead. The row count is
 * bounded by distinct values rather than by conversions, which is small for
 * real price lists, and the canonical function is applied to each.
 */
async function conversionsBy(
  deps: RecomputeDeps,
  experimentId: string,
  rewardCapCents: number,
): Promise<Map<string, ConversionTotals>> {
  const { rows } = await deps.query<{
    arm_id: string | null;
    value_cents: string | number;
    n: string | number;
  }>(
    `SELECT arm_id, value_cents, count(*) AS n
       FROM conversions
      WHERE experiment_id = $1 AND arm_id IS NOT NULL
      GROUP BY arm_id, value_cents`,
    [experimentId],
  );

  const totals = new Map<string, ConversionTotals>();

  for (const row of rows) {
    if (row.arm_id === null) continue;
    const n = toNumber(row.n);
    const value = toNumber(row.value_cents);

    const acc = totals.get(row.arm_id) ?? { count: 0, revenueCents: 0, rewardSum: 0 };
    acc.count += n;
    acc.revenueCents += value * n;
    acc.rewardSum += normalizeReward(value, rewardCapCents) * n;
    totals.set(row.arm_id, acc);
  }

  return totals;
}
