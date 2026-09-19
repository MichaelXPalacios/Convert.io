/**
 * Arm allocation on the hot path.
 *
 * One visitor, one request, one arm. The input is the Redis mirror the worker
 * writes (see @convertio/contracts/redis), so allocating costs a single
 * HGETALL and never a database read.
 *
 * The guardrail discipline here is the point of the module: EXPLORATION_FLOOR
 * is applied by this function whether or not a caller passes a floor, and a
 * configured floor may only widen exploration, never narrow it. A guardrail a
 * caller can omit — or that a bad configuration row can shrink — is not a
 * guardrail.
 */

import { EXPLORATION_FLOOR, type MirrorArm, type PosteriorMirror } from "@convertio/contracts";
import { sampleBeta, type Rng } from "./bandit.js";

/** Why this visitor saw this arm. Recorded so a surprising split is explainable. */
export type AssignmentReason = "sticky" | "explore" | "thompson" | "control_fallback";

export interface Assignment {
  arm: MirrorArm;
  reason: AssignmentReason;
  /** The floor actually enforced, after the hard guardrail was applied. */
  explorationFloor: number;
}

export interface AssignOptions {
  /** Uniform source on [0, 1). Defaults to Math.random. */
  rng?: Rng;
  /**
   * The arm key carried by the visitor's assignment cookie, if any.
   *
   * Honoured when it still names an eligible arm, so a refresh inside a session
   * does not reshuffle the page under someone mid-read. A stale key — an arm
   * since paused or retired — is ignored rather than trusted.
   */
  stickyArmKey?: string | null;
}

/**
 * Arms a visitor may be shown.
 *
 * `promoted` stays eligible: promotion is a statement about which arm won, not
 * an instruction to stop measuring it.
 */
export function eligibleArms(mirror: PosteriorMirror): MirrorArm[] {
  return mirror.arms.filter((arm) => arm.status === "active" || arm.status === "promoted");
}

/** The experiment's control. The schema guarantees exactly one per experiment. */
export function controlArm(mirror: PosteriorMirror): MirrorArm | undefined {
  return mirror.arms.find((arm) => arm.isControl);
}

/**
 * The floor actually enforced.
 *
 * Configuration is a default, not the enforcement point: a row may ask for more
 * exploration than the hard floor and get it, and a row asking for less — or
 * carrying a nonsense value — gets the floor anyway.
 */
export function effectiveExplorationFloor(configuredFloor: number): number {
  if (!Number.isFinite(configuredFloor)) return EXPLORATION_FLOOR;
  return Math.max(EXPLORATION_FLOOR, configuredFloor);
}

/**
 * Choose the arm to render.
 *
 * Throws when the mirror contains no eligible arm at all, which means the
 * mirror is wrong rather than the experiment being finished — the schema will
 * not let the control be paused or retired. Callers on a request path should
 * use `assignArmOrControl`, which turns that into a control render.
 */
export function assignArm(mirror: PosteriorMirror, options: AssignOptions = {}): Assignment {
  const { rng = Math.random, stickyArmKey = null } = options;

  const eligible = eligibleArms(mirror);
  if (eligible.length === 0) {
    throw new Error(`posterior mirror for "${mirror.meta.slug}" contains no eligible arm`);
  }

  const floor = effectiveExplorationFloor(mirror.meta.explorationFloor);

  // A returning visitor keeps the arm they already have, provided it is still
  // one a visitor may be shown.
  if (stickyArmKey !== null) {
    const held = eligible.find((arm) => arm.key === stickyArmKey);
    if (held !== undefined) return { arm: held, reason: "sticky", explorationFloor: floor };
  }

  // An argmax over one candidate is that candidate. Drawing a posterior sample
  // to discover this would cost the hot path two Gamma draws and make a
  // single-arm experiment needlessly nondeterministic.
  const only = eligible[0];
  if (eligible.length === 1 && only !== undefined) {
    return { arm: only, reason: "thompson", explorationFloor: floor };
  }

  // With probability `floor`, ignore the posteriors entirely and pick uniformly.
  // This is what keeps an arm that an early unlucky run buried from being starved
  // of the traffic it would need to recover.
  if (rng() < floor) {
    const index = Math.min(eligible.length - 1, Math.floor(rng() * eligible.length));
    const picked = eligible[index] ?? eligible[0];
    if (picked === undefined) {
      throw new Error("unreachable: eligible arms was non-empty");
    }
    return { arm: picked, reason: "explore", explorationFloor: floor };
  }

  // Thompson sampling: one draw from each arm's posterior, highest draw wins.
  let best = eligible[0];
  if (best === undefined) {
    throw new Error("unreachable: eligible arms was non-empty");
  }
  let bestDraw = sampleBeta(best.alpha, best.beta, rng);

  for (let i = 1; i < eligible.length; i += 1) {
    const arm = eligible[i];
    if (arm === undefined) continue;
    const draw = sampleBeta(arm.alpha, arm.beta, rng);
    if (draw > bestDraw) {
      best = arm;
      bestDraw = draw;
    }
  }

  return { arm: best, reason: "thompson", explorationFloor: floor };
}

/**
 * Allocate, falling back to the control arm if anything goes wrong.
 *
 * The hot path must render something. A malformed mirror, a missing field, a
 * posterior that failed to parse — none of those justify a broken page, and all
 * of them justify showing the page we already trust. Returns undefined only
 * when even the control is absent, which the caller must treat as "this slug is
 * not under test" rather than as an error to retry.
 */
export function assignArmOrControl(
  mirror: PosteriorMirror,
  options: AssignOptions = {},
): Assignment | undefined {
  try {
    return assignArm(mirror, options);
  } catch {
    const control = controlArm(mirror);
    if (control === undefined) return undefined;
    return {
      arm: control,
      reason: "control_fallback",
      explorationFloor: effectiveExplorationFloor(mirror.meta.explorationFloor),
    };
  }
}
