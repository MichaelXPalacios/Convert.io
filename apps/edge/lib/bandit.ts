/**
 * Sampling primitives for Thompson allocation.
 *
 * Every function here takes its randomness as an argument. That is deliberate:
 * an allocator whose draws cannot be reproduced can only be tested for "it
 * returned an arm", and the property that actually matters — that a better arm
 * wins more often, and that a worse one still gets its floor — is a statement
 * about a distribution, which needs a seed to assert.
 *
 * Nothing in this file reads the clock, the environment, or Math.random.
 */

/** A uniform source on [0, 1). `Math.random` satisfies this. */
export type Rng = () => number;

/**
 * mulberry32 — a small deterministic PRNG for tests and reproducible draws.
 *
 * Not cryptographic. It must never be used to generate an id, a token, or
 * anything else whose unpredictability carries weight.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A draw strictly inside (0, 1).
 *
 * Box-Muller takes a logarithm and Marsaglia-Tsang takes a power, so an exact
 * 0 or 1 from the source produces a non-finite intermediate. Rather than loop
 * until the source cooperates — which never terminates for a degenerate rng
 * that always returns the same value — this gives up after a bounded number of
 * attempts and returns the midpoint, so a bad source degrades to a fixed draw
 * instead of hanging the request.
 */
function openUnit(rng: Rng): number {
  for (let i = 0; i < 64; i += 1) {
    const u = rng();
    if (u > 0 && u < 1) return u;
  }
  return 0.5;
}

/** A standard normal draw, via Box-Muller. */
export function sampleNormal(rng: Rng): number {
  const u1 = openUnit(rng);
  const u2 = openUnit(rng);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Guards against the rejection loop spinning on a degenerate source. */
const MAX_REJECTION_ATTEMPTS = 1000;

/**
 * A Gamma(shape, 1) draw, via Marsaglia-Tsang.
 *
 * Shapes below 1 are boosted by the standard identity
 * Gamma(a) = Gamma(a + 1) * U^(1/a), because the squeeze step assumes a >= 1.
 *
 * Acceptance is above 95% for every shape, so the loop is effectively constant
 * time; the attempt cap exists only so a pathological rng cannot hang the hot
 * path. On giving up it returns the distribution mean, which is the least
 * misleading value available.
 */
export function sampleGamma(shape: number, rng: Rng): number {
  if (!Number.isFinite(shape) || shape <= 0) {
    throw new Error(`gamma shape must be a positive finite number, got ${shape}`);
  }

  if (shape < 1) {
    return sampleGamma(shape + 1, rng) * Math.pow(openUnit(rng), 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  for (let attempt = 0; attempt < MAX_REJECTION_ATTEMPTS; attempt += 1) {
    let x = 0;
    let v = 0;
    do {
      x = sampleNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);

    v = v * v * v;
    const u = openUnit(rng);
    const xSquared = x * x;

    // The cheap squeeze first, then the exact test, as in the original paper.
    if (u < 1 - 0.0331 * xSquared * xSquared) return d * v;
    if (Math.log(u) < 0.5 * xSquared + d * (1 - v + Math.log(v))) return d * v;
  }

  return shape;
}

/**
 * A Beta(alpha, beta) draw, as the ratio of two Gamma draws.
 *
 * This is the sample Thompson allocation compares across arms: one draw from
 * each arm's current belief, highest draw wins. An arm with little data has a
 * wide posterior and therefore sometimes draws high, which is exactly how it
 * earns the traffic it needs to be judged.
 */
export function sampleBeta(alpha: number, beta: number, rng: Rng): number {
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  const total = x + y;

  // Both draws underflowing to 0 is possible for very small shapes. The mean is
  // the honest fallback: it is what the posterior says without the noise.
  if (!Number.isFinite(total) || total <= 0) return alpha / (alpha + beta);

  return x / total;
}
