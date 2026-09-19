import { z } from "zod";
import { CentsSchema, TimestampSchema, UuidSchema } from "./common.js";

/**
 * A row of `posteriors`: the bandit's current belief about one arm.
 *
 * Postgres is the source of truth. Redis holds a mirror of this so the edge can
 * do a single read on the hot path; see redis.ts for that format.
 */
export const PosteriorSchema = z
  .object({
    experimentId: UuidSchema,
    armId: UuidSchema,

    /** Beta parameters over normalized revenue per visitor, not over clicks. */
    alpha: z.number().positive(),
    beta: z.number().positive(),

    exposuresCount: z.number().int().nonnegative(),
    conversionsCount: z.number().int().nonnegative(),
    revenueCents: CentsSchema,

    /**
     * Carried so the admin surface can show an ad problem and a page problem as
     * separate numbers. Never an input to allocation.
     */
    clicksCount: z.number().int().nonnegative(),

    mean: z.number(),
    ciLow: z.number(),
    ciHigh: z.number(),

    allocation: z.number().min(0).max(1),

    computedAt: TimestampSchema,
  })
  .refine((p) => p.ciLow <= p.mean && p.mean <= p.ciHigh, {
    message: "credible interval must contain the mean",
    path: ["mean"],
  });

export type Posterior = z.infer<typeof PosteriorSchema>;

/**
 * Normalize an order value into the [0,1] reward a Beta posterior can accept.
 *
 * This is the single most consequential definition in the system, so it lives
 * in contracts rather than inside the worker: the worker, the simulator and any
 * backfill must agree on it exactly or their numbers are not comparable.
 *
 * Why a cap rather than raw revenue:
 *
 *   A Beta distribution is defined over [0,1]. Revenue is unbounded. Mapping
 *   revenue in by dividing by the observed maximum lets a single outsized order
 *   rescale every arm's history retroactively. Dividing by a fixed cap instead
 *   means one $4,000 order and one $200 order both saturate at 1.0, so the
 *   posterior tracks how often an arm produces a good order rather than
 *   whether it once produced a spectacular one.
 *
 *   The cost is deliberate: above the cap, revenue differences stop mattering.
 *   For a business whose order values cluster well under the cap that is the
 *   right trade. Set rewardCapCents per experiment to roughly the 95th
 *   percentile order value.
 *
 * A visitor who never ordered contributes reward 0, which is what moves a
 * high-click, low-order arm down. That is the thesis of the product.
 */
export function normalizeReward(valueCents: number, rewardCapCents: number): number {
  if (rewardCapCents <= 0) throw new Error("rewardCapCents must be positive");
  if (!Number.isFinite(valueCents) || valueCents <= 0) return 0;
  return Math.min(valueCents, rewardCapCents) / rewardCapCents;
}

/**
 * Beta parameters from a set of exposures and the rewards they earned.
 *
 * alpha = 1 + sum(reward), beta = 1 + sum(1 - reward), starting from Beta(1,1),
 * the uniform prior: before any data, every arm is equally plausible rather
 * than assumed good.
 */
export function betaFromRewards(
  exposures: number,
  rewardSum: number,
): { alpha: number; beta: number } {
  const n = Math.max(0, exposures);
  const s = Math.min(Math.max(0, rewardSum), n);
  return { alpha: 1 + s, beta: 1 + (n - s) };
}

/** Mean of Beta(alpha, beta). */
export const betaMean = (alpha: number, beta: number): number => alpha / (alpha + beta);

/**
 * Normal approximation to a central credible interval for Beta(alpha, beta).
 *
 * Adequate once an arm has the minimum exposures the guardrails require; below
 * that the interval is wide enough that no promotion decision should be reading
 * it anyway, which is exactly why the minimum exists.
 */
export function betaCredibleInterval(
  alpha: number,
  beta: number,
  z = 1.96,
): { low: number; high: number } {
  const mean = betaMean(alpha, beta);
  const n = alpha + beta;
  const sd = Math.sqrt((alpha * beta) / (n * n * (n + 1)));
  return {
    low: Math.max(0, mean - z * sd),
    high: Math.min(1, mean + z * sd),
  };
}
