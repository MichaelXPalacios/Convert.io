// Integration check for the posterior recompute.
//
// The worker's unit tests drive a fake database, which proves the arithmetic
// but cannot prove the SQL. Column names, the events -> exposures join, and
// node-postgres returning numeric and bigint as strings are all invisible to
// them. This runs the real recompute against a real Postgres with known
// traffic and asserts the numbers that come out.
//
// It expects a database that already has the schema and the seed applied, and
// it writes synthetic exposures and conversions, so point it at a throwaway
// database only. The CI job gives it a service container that is destroyed
// with the run.
//
//   DATABASE_URL_UNPOOLED=postgres://... node .github/scripts/worker-integration.mjs

import pg from "pg";

import { recomputeAll } from "../../packages/worker/dist/src/index.js";
import { parsePosteriorMirror } from "../../packages/contracts/dist/index.js";

const connectionString = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.error("DATABASE_URL_UNPOOLED is required.");
  process.exit(1);
}

// Deterministic: a "draw" is the posterior mean. Real sampling belongs to
// packages/core; this check is about the SQL and the arithmetic, and a random
// sampler would make the allocation assertions flaky for no benefit.
const sampleBeta = (alpha, beta) => alpha / (alpha + beta);

// Known traffic with a known answer. variant-a converts four times as often as
// control; variant-b never converts but is clicked constantly, which must move
// its posterior by exactly nothing.
const PLAN = [
  { key: "control", exposures: 400, conversions: 20, valueCents: 12000, clicks: false },
  { key: "variant-a", exposures: 400, conversions: 80, valueCents: 15000, clicks: false },
  { key: "variant-b", exposures: 400, conversions: 0, valueCents: 0, clicks: true },
];

// reward = min(value, cap) / cap, cap = 20000 from the seed.
//   control   20 x 12000/20000 = 12  -> alpha 13, beta 1 + (400 - 12) = 389
//   variant-a 80 x 15000/20000 = 60  -> alpha 61, beta 1 + (400 - 60) = 341
//   variant-b  0                     -> alpha  1, beta 1 + 400        = 401
const EXPECTED = {
  control: { alpha: 13, beta: 389 },
  "variant-a": { alpha: 61, beta: 341 },
  "variant-b": { alpha: 1, beta: 401 },
};

const failures = [];
const check = (condition, message) => {
  if (condition) {
    console.log(`  ok   ${message}`);
  } else {
    console.log(`  FAIL ${message}`);
    failures.push(message);
  }
};

const client = new pg.Client({ connectionString });
await client.connect();

try {
  const { rows: experiments } = await client.query(
    "SELECT id, slug FROM experiments WHERE slug = $1",
    ["demo-landing"],
  );
  if (experiments.length === 0) {
    throw new Error("the seed has not been applied: no demo-landing experiment");
  }
  const experimentId = experiments[0].id;

  const { rows: armRows } = await client.query(
    "SELECT id, key FROM arms WHERE experiment_id = $1",
    [experimentId],
  );
  const armIdByKey = Object.fromEntries(armRows.map((r) => [r.key, r.id]));

  console.log("seeding synthetic traffic");
  await client.query("BEGIN");
  let order = 0;
  for (const arm of PLAN) {
    const armId = armIdByKey[arm.key];
    if (!armId) throw new Error(`seed is missing the ${arm.key} arm`);

    for (let i = 0; i < arm.exposures; i += 1) {
      const { rows } = await client.query(
        `INSERT INTO exposures (experiment_id, arm_id, visitor_id, session_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [experimentId, armId, `v-${arm.key}-${i}`, `s-${arm.key}-${i}`],
      );
      const exposureId = rows[0].id;

      if (arm.clicks) {
        await client.query("INSERT INTO events (exposure_id, type) VALUES ($1, 'click')", [
          exposureId,
        ]);
      }

      if (i < arm.conversions) {
        order += 1;
        await client.query(
          `INSERT INTO conversions
             (exposure_id, experiment_id, arm_id, visitor_id, provider,
              external_order_id, value_cents, occurred_at)
           VALUES ($1, $2, $3, $4, 'manual', $5, $6, now())`,
          [exposureId, experimentId, armId, `v-${arm.key}-${i}`, `order-${order}`, arm.valueCents],
        );
      }
    }
  }
  await client.query("COMMIT");

  const query = (sql, params) => client.query(sql, params);

  console.log("\nrecompute");
  const results = await recomputeAll({ query, sampleBeta, allocationSamples: 400 });

  check(results.length === 1, `one running experiment recomputed (got ${results.length})`);
  const result = results[0];
  check(result.isCold === false, "isCold is false once exposures exist");

  const byKey = Object.fromEntries(result.arms.map((a) => [a.key, a]));

  console.log("\nposteriors");
  for (const [key, expected] of Object.entries(EXPECTED)) {
    const arm = byKey[key];
    if (!arm) {
      check(false, `${key} is present`);
      continue;
    }
    check(arm.alpha === expected.alpha, `${key} alpha is ${expected.alpha} (got ${arm.alpha})`);
    check(arm.beta === expected.beta, `${key} beta is ${expected.beta} (got ${arm.beta})`);
    check(
      arm.ciLow <= arm.mean && arm.mean <= arm.ciHigh,
      `${key} credible interval contains the mean`,
    );
  }

  console.log("\nthe thesis of the product");
  check(
    byKey["variant-a"].mean > byKey["control"].mean &&
      byKey["control"].mean > byKey["variant-b"].mean,
    "posterior ordering is variant-a > control > variant-b",
  );
  check(
    byKey["variant-b"].clicksCount === 400 && byKey["variant-b"].alpha === 1,
    "400 clicks are recorded but move variant-b's posterior by nothing",
  );
  check(
    byKey["control"].revenueCents === 240000 && byKey["variant-a"].revenueCents === 1200000,
    "revenue is reported at its true value",
  );

  console.log("\nallocation");
  const total = result.arms.reduce((sum, a) => sum + a.allocation, 0);
  check(Math.round(total * 1e5) / 1e5 === 1, `allocations sum to exactly 1 (got ${total})`);
  check(
    result.arms.every((a) => a.allocation >= 0.1),
    "every eligible arm clears the 0.1 exploration floor",
  );
  check(
    byKey["variant-a"].allocation > byKey["control"].allocation,
    "the winning arm takes the largest share",
  );

  console.log("\npersistence");
  const { rows: stored } = await client.query(
    `SELECT a.key, p.alpha, p.beta, p.allocation
       FROM posteriors p JOIN arms a ON a.id = p.arm_id
      WHERE p.experiment_id = $1`,
    [experimentId],
  );
  check(stored.length === 3, `three posteriors rows persisted (got ${stored.length})`);
  for (const row of stored) {
    check(
      Number(row.alpha) === byKey[row.key].alpha,
      `${row.key} was stored with the alpha that was computed`,
    );
  }

  console.log("\nmirror");
  const mirror = parsePosteriorMirror(result.mirrorFields);
  check(mirror.meta.slug === "demo-landing", "mirror round-trips through the contracts parser");
  check(
    mirror.arms.length === 3,
    `mirror carries all three eligible arms (got ${mirror.arms.length})`,
  );

  console.log("\nidempotency");
  const again = await recomputeAll({ query, sampleBeta, allocationSamples: 400 });
  const fingerprint = (r) =>
    r.arms
      .map((a) => `${a.key}:${a.alpha}/${a.beta}`)
      .sort()
      .join(" ");
  check(
    fingerprint(again[0]) === fingerprint(result),
    "a second recompute produces identical posteriors",
  );
  const { rows: countRows } = await client.query(
    "SELECT count(*)::int AS n FROM posteriors WHERE experiment_id = $1",
    [experimentId],
  );
  check(
    countRows[0].n === 3,
    `still three posteriors rows after a second run (got ${countRows[0].n})`,
  );
} finally {
  await client.end();
}

console.log("");
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("all checks passed");
