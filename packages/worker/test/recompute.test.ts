import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { parsePosteriorMirror, redisPosteriorKey } from "@convertio/contracts";

import { allocate, recomputeAll, type QueryFn, type QueryResultLike } from "../src/index.js";

// ---------------------------------------------------------------------------
// A fake database.
//
// Values are returned as strings wherever the real column is numeric or
// bigint, because that is what node-postgres does and a recompute that only
// works against numbers would pass here and produce nonsense in production.
// ---------------------------------------------------------------------------

interface FakeData {
  experiments?: Array<Record<string, unknown>>;
  arms?: Array<Record<string, unknown>>;
  exposures?: Array<{ arm_id: string; n: string }>;
  clicks?: Array<{ arm_id: string; n: string }>;
  conversions?: Array<{ arm_id: string; value_cents: string; n: string }>;
}

interface Recorded {
  sql: string;
  params: unknown[];
}

function fakeDb(data: FakeData): { query: QueryFn; writes: Recorded[] } {
  const writes: Recorded[] = [];

  const query = (async <R>(sql: string, params: unknown[] = []): Promise<QueryResultLike<R>> => {
    const rows = (() => {
      if (sql.includes("FROM experiments")) return data.experiments ?? [];
      if (sql.includes("FROM arms")) return data.arms ?? [];
      if (sql.includes("FROM exposures")) return data.exposures ?? [];
      if (sql.includes("FROM events")) return data.clicks ?? [];
      if (sql.includes("FROM conversions")) return data.conversions ?? [];
      if (sql.includes("INSERT INTO posteriors")) {
        writes.push({ sql, params });
        return [];
      }
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    })();

    return { rows: rows as R[] };
  }) as QueryFn;

  return { query, writes };
}

const EXPERIMENT = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "demo-landing",
  exploration_floor: "0.1000",
  min_exposures: "0",
  reward_cap_cents: "20000",
};

const ARM = (key: string, id: string, status = "active", isControl = false) => ({
  id,
  key,
  is_control: isControl,
  status,
});

const CONTROL_ID = "22222222-2222-4222-8222-222222222222";
const A_ID = "33333333-3333-4333-8333-333333333333";
const B_ID = "44444444-4444-4444-8444-444444444444";

/** Deterministic: each arm's "draw" is just its mean, so wins are decidable. */
const meanSampler = (alpha: number, beta: number): number => alpha / (alpha + beta);

const now = () => new Date("2026-09-18T00:00:00.000Z");

describe("recomputeAll", () => {
  it("starts every arm at the uniform prior when there is no traffic", async () => {
    const { query } = fakeDb({
      experiments: [EXPERIMENT],
      arms: [ARM("control", CONTROL_ID, "active", true), ARM("variant-a", A_ID)],
    });

    const [result] = await recomputeAll({ query, sampleBeta: meanSampler, now });
    assert.ok(result);

    assert.equal(result.isCold, true);
    for (const arm of result.arms) {
      assert.equal(arm.alpha, 1, `${arm.key} alpha`);
      assert.equal(arm.beta, 1, `${arm.key} beta`);
      assert.equal(arm.mean, 0.5, `${arm.key} mean`);
      assert.equal(arm.exposuresCount, 0);
    }
  });

  it("holds the credible interval around the mean, which the schema requires", async () => {
    const { query } = fakeDb({
      experiments: [EXPERIMENT],
      arms: [ARM("control", CONTROL_ID, "active", true), ARM("variant-a", A_ID)],
      exposures: [
        { arm_id: CONTROL_ID, n: "500" },
        { arm_id: A_ID, n: "500" },
      ],
      conversions: [{ arm_id: A_ID, value_cents: "10000", n: "50" }],
    });

    const [result] = await recomputeAll({ query, sampleBeta: meanSampler, now });
    assert.ok(result);

    for (const arm of result.arms) {
      assert.ok(arm.ciLow <= arm.mean, `${arm.key}: ciLow <= mean`);
      assert.ok(arm.mean <= arm.ciHigh, `${arm.key}: mean <= ciHigh`);
      assert.ok(arm.ciLow >= 0 && arm.ciHigh <= 1, `${arm.key}: interval within [0,1]`);
    }
  });

  it("caps an outsized order instead of letting it rescale the arm", async () => {
    // cap is 20000. One order of 400000 and one of 20000 must contribute the
    // same reward, which is the whole point of the cap.
    const huge = fakeDb({
      experiments: [EXPERIMENT],
      arms: [ARM("variant-a", A_ID)],
      exposures: [{ arm_id: A_ID, n: "10" }],
      conversions: [{ arm_id: A_ID, value_cents: "400000", n: "1" }],
    });
    const atCap = fakeDb({
      experiments: [EXPERIMENT],
      arms: [ARM("variant-a", A_ID)],
      exposures: [{ arm_id: A_ID, n: "10" }],
      conversions: [{ arm_id: A_ID, value_cents: "20000", n: "1" }],
    });

    const [a] = await recomputeAll({ query: huge.query, sampleBeta: meanSampler, now });
    const [b] = await recomputeAll({ query: atCap.query, sampleBeta: meanSampler, now });
    assert.ok(a && b);

    assert.equal(a.arms[0]?.alpha, b.arms[0]?.alpha);
    assert.equal(a.arms[0]?.beta, b.arms[0]?.beta);
    // Revenue is still reported at its true value; only the reward is capped.
    assert.equal(a.arms[0]?.revenueCents, 400000);
    assert.equal(b.arms[0]?.revenueCents, 20000);
  });

  it("counts a visitor who never ordered as reward zero", async () => {
    const { query } = fakeDb({
      experiments: [EXPERIMENT],
      arms: [ARM("variant-a", A_ID)],
      exposures: [{ arm_id: A_ID, n: "100" }],
      conversions: [{ arm_id: A_ID, value_cents: "20000", n: "10" }],
    });

    const [result] = await recomputeAll({ query, sampleBeta: meanSampler, now });
    const arm = result?.arms[0];
    assert.ok(arm);

    // 10 full-reward conversions out of 100 exposures: alpha = 1 + 10.
    assert.equal(arm.alpha, 11);
    assert.equal(arm.beta, 1 + 90);
    assert.ok(arm.mean < 0.2, "90 non-converting visitors must drag the mean down");
  });

  it("never lets clicks reach the posterior", async () => {
    const withClicks = fakeDb({
      experiments: [EXPERIMENT],
      arms: [ARM("variant-a", A_ID)],
      exposures: [{ arm_id: A_ID, n: "50" }],
      clicks: [{ arm_id: A_ID, n: "5000" }],
    });
    const without = fakeDb({
      experiments: [EXPERIMENT],
      arms: [ARM("variant-a", A_ID)],
      exposures: [{ arm_id: A_ID, n: "50" }],
    });

    const [a] = await recomputeAll({ query: withClicks.query, sampleBeta: meanSampler, now });
    const [b] = await recomputeAll({ query: without.query, sampleBeta: meanSampler, now });

    assert.equal(a?.arms[0]?.alpha, b?.arms[0]?.alpha);
    assert.equal(a?.arms[0]?.beta, b?.arms[0]?.beta);
    assert.equal(a?.arms[0]?.clicksCount, 5000, "but it is still reported");
  });

  it("writes one posteriors row per arm", async () => {
    const { query, writes } = fakeDb({
      experiments: [EXPERIMENT],
      arms: [ARM("control", CONTROL_ID, "active", true), ARM("variant-a", A_ID)],
    });

    await recomputeAll({ query, sampleBeta: meanSampler, now });

    assert.equal(writes.length, 2);
    assert.ok(writes[0]?.sql.includes("ON CONFLICT (experiment_id, arm_id) DO UPDATE"));
    assert.equal(writes[0]?.params[0], EXPERIMENT.id);
  });
});

describe("mirror", () => {
  it("round-trips through the contracts parser", async () => {
    const { query } = fakeDb({
      experiments: [EXPERIMENT],
      arms: [ARM("control", CONTROL_ID, "active", true), ARM("variant-a", A_ID)],
      exposures: [{ arm_id: A_ID, n: "12" }],
    });

    const [result] = await recomputeAll({ query, sampleBeta: meanSampler, now });
    assert.ok(result);

    assert.equal(result.mirrorKey, redisPosteriorKey("demo-landing"));

    const parsed = parsePosteriorMirror(result.mirrorFields);
    assert.equal(parsed.meta.slug, "demo-landing");
    assert.equal(parsed.meta.experimentId, EXPERIMENT.id);
    assert.equal(parsed.meta.explorationFloor, 0.1);
    assert.equal(parsed.arms.length, 2);
  });

  it("leaves paused and retired arms out, so the edge cannot allocate to them", async () => {
    const { query } = fakeDb({
      experiments: [EXPERIMENT],
      arms: [
        ARM("control", CONTROL_ID, "active", true),
        ARM("variant-a", A_ID, "paused"),
        ARM("variant-b", B_ID, "retired"),
      ],
    });

    const [result] = await recomputeAll({ query, sampleBeta: meanSampler, now });
    assert.ok(result);

    const parsed = parsePosteriorMirror(result.mirrorFields);
    assert.deepEqual(
      parsed.arms.map((a) => a.key),
      ["control"],
    );

    // They still get a posteriors row — the admin surface needs their numbers.
    assert.equal(result.arms.length, 3);
    assert.equal(result.arms.find((a) => a.key === "variant-a")?.allocation, 0);
  });
});

describe("allocate", () => {
  const base = { status: "active", exposuresCount: 1000 };

  it("gives a lone eligible arm everything", () => {
    const out = allocate([{ ...base, alpha: 5, beta: 5 }], {
      explorationFloor: 0.1,
      minExposures: 0,
      sampleBeta: meanSampler,
      samples: 10,
    });
    assert.deepEqual(out, [1]);
  });

  it("holds every eligible arm at or above the exploration floor", () => {
    // meanSampler makes the third arm win every draw; the losers must still
    // clear the floor, because that is what the floor is for.
    const out = allocate(
      [
        { ...base, alpha: 2, beta: 100 },
        { ...base, alpha: 2, beta: 100 },
        { ...base, alpha: 90, beta: 10 },
      ],
      { explorationFloor: 0.1, minExposures: 0, sampleBeta: meanSampler, samples: 200 },
    );

    for (const share of out) assert.ok(share >= 0.1, `${share} must clear the floor`);
    assert.ok((out[2] ?? 0) > 0.6, "the winner should still take most of the traffic");
    assert.equal(round(out.reduce((a, b) => a + b, 0)), 1);
  });

  it("splits uniformly below the minimum exposure guardrail", () => {
    const out = allocate(
      [
        { ...base, exposuresCount: 5, alpha: 50, beta: 1 },
        { ...base, exposuresCount: 5, alpha: 1, beta: 50 },
      ],
      { explorationFloor: 0.1, minExposures: 1000, sampleBeta: meanSampler, samples: 200 },
    );
    assert.deepEqual(out, [0.5, 0.5]);
  });

  it("falls back to uniform when the floor cannot be satisfied", () => {
    // Four arms at a 0.3 floor would need 1.2 of the traffic.
    const arms = [1, 2, 3, 4].map(() => ({ ...base, alpha: 2, beta: 2 }));
    const out = allocate(arms, {
      explorationFloor: 0.3,
      minExposures: 0,
      sampleBeta: meanSampler,
      samples: 50,
    });
    assert.deepEqual(out, [0.25, 0.25, 0.25, 0.25]);
  });

  it("allocates nothing when no arm is eligible", () => {
    const out = allocate(
      [
        { ...base, status: "paused", alpha: 2, beta: 2 },
        { ...base, status: "retired", alpha: 2, beta: 2 },
      ],
      { explorationFloor: 0.1, minExposures: 0, sampleBeta: meanSampler, samples: 10 },
    );
    assert.deepEqual(out, [0, 0]);
  });

  it("sums to exactly one after rounding to the column's five decimals", () => {
    const arms = [1, 2, 3].map((i) => ({ ...base, alpha: i * 3, beta: 7 }));
    const out = allocate(arms, {
      explorationFloor: 0.1,
      minExposures: 0,
      sampleBeta: meanSampler,
      samples: 333,
    });

    assert.equal(round(out.reduce((a, b) => a + b, 0)), 1);
    for (const share of out) {
      assert.equal(share, Math.round(share * 1e5) / 1e5, "must fit numeric(6,5)");
    }
  });
});

const round = (n: number): number => Math.round(n * 1e5) / 1e5;
