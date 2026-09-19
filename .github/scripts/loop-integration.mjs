// End-to-end check of the revenue loop, against a real Postgres.
//
// worker-integration.mjs proves the recompute's SQL by writing exposures and
// conversions with hand-written INSERTs. That leaves the modules the request
// path actually calls — recordExposure, recordEvent, attributeOrder,
// recordConversion — unexercised against a real database, and those are the
// ones carrying the attribution window and the idempotency guarantees.
//
// This drives the whole chain the way production does:
//
//   recordExposure  ->  recordEvent  ->  attributeOrder  ->  recordConversion
//                                                                  |
//                                                            recomputeAll
//
// and asserts the revenue arrives in the posterior of the arm that earned it.
//
// Expects schema and seed applied. Writes real rows, so throwaway databases
// only. The CI job gives it a service container destroyed with the run.

import pg from "pg";

import {
  recordExposure,
  recordEvent,
  attributeOrder,
  recordConversion,
} from "../../packages/core/dist/src/index.js";
import { recomputeAll } from "../../packages/worker/dist/src/index.js";

const connectionString = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

if (!connectionString) {
  console.error("DATABASE_URL_UNPOOLED is required.");
  process.exit(1);
}

const sampleBeta = (alpha, beta) => alpha / (alpha + beta);

const failures = [];
const check = (condition, message) => {
  console.log(`  ${condition ? "ok  " : "FAIL"} ${message}`);
  if (!condition) failures.push(message);
};

const client = new pg.Client({ connectionString });
await client.connect();

// recordExposure and friends take a Queryable, which is structurally what the
// pg client already is.
const db = { query: (sql, params) => client.query(sql, params) };

try {
  console.log("exposure");

  const track = {
    slug: "demo-landing",
    armKey: "variant-a",
    visitorId: "loop-visitor-1",
    sessionId: "loop-session-1",
    utmSource: "integration",
    referrer: "https://example.test/",
    userAgent: "loop-integration",
    device: "desktop",
    country: "US",
  };

  const exposure = await recordExposure(db, track);
  check(exposure !== undefined, "recordExposure returns a result for a known slug and arm");
  check(typeof exposure?.exposureId === "string", "it returns an exposure id");

  // The unique constraint is (visitor_id, session_id, arm_id). A beacon that
  // fires twice — a retry, a refresh — must not inflate the denominator.
  const repeat = await recordExposure(db, track);
  check(
    repeat?.exposureId === exposure?.exposureId,
    "recording the same exposure twice returns the same id rather than a second row",
  );

  const { rows: exposureCount } = await client.query(
    "SELECT count(*)::int AS n FROM exposures WHERE visitor_id = $1",
    [track.visitorId],
  );
  check(exposureCount[0].n === 1, `exactly one exposure row exists (got ${exposureCount[0].n})`);

  const unknown = await recordExposure(db, { ...track, slug: "no-such-experiment" });
  check(unknown === undefined, "an unknown slug records nothing rather than inventing a row");

  console.log("\nengagement");

  const event = await recordEvent(db, {
    exposureId: exposure.exposureId,
    type: "click",
    metadata: { source: "loop-integration" },
  });
  check(event !== undefined, "recordEvent accepts a click against a real exposure");

  console.log("\nattribution");

  const order = {
    provider: "manual",
    externalOrderId: "loop-order-1",
    visitorId: track.visitorId,
    valueCents: 15000,
    currency: "USD",
    occurredAt: new Date(),
  };

  const attribution = await attributeOrder(db, order);
  check(
    attribution.attributed === true,
    "an order from a known visitor attributes to its exposure",
  );
  check(
    attribution.attributed && attribution.exposureId === exposure.exposureId,
    "it attributes to the exposure that actually earned it",
  );

  const orphan = await attributeOrder(db, { ...order, visitorId: "nobody-has-this-id" });
  check(
    orphan.attributed === false,
    "an order from an unseen visitor does not attribute rather than guessing",
  );

  const conversion = await recordConversion(db, order, attribution);
  check(conversion !== undefined, "recordConversion writes the order");

  // Payment providers retry. The unique constraint is
  // (provider, external_order_id), so the same order must never be counted
  // twice — double-counted revenue is the worst failure this system has,
  // because it moves the posterior toward whichever arm got retried.
  await recordConversion(db, order, attribution);
  const { rows: convCount } = await client.query(
    "SELECT count(*)::int AS n FROM conversions WHERE external_order_id = $1",
    [order.externalOrderId],
  );
  check(convCount[0].n === 1, `a retried webhook writes one conversion (got ${convCount[0].n})`);

  console.log("\nthe revenue reaches the posterior");

  const [result] = await recomputeAll({ query: db.query, sampleBeta, allocationSamples: 200 });
  const byKey = Object.fromEntries(result.arms.map((a) => [a.key, a]));

  check(byKey["variant-a"].exposuresCount === 1, "the exposure is counted once in the posterior");
  check(byKey["variant-a"].conversionsCount === 1, "the conversion is counted once");
  check(byKey["variant-a"].revenueCents === 15000, "the revenue lands on the arm that earned it");
  check(byKey["variant-a"].clicksCount === 1, "the click is reported");

  // cap 20000, so reward = 15000/20000 = 0.75 on one exposure.
  check(
    Math.abs(byKey["variant-a"].alpha - 1.75) < 1e-9,
    `alpha is 1 + 0.75 (got ${byKey["variant-a"].alpha})`,
  );
  check(
    byKey["control"].alpha === 1 && byKey["control"].exposuresCount === 0,
    "an arm that saw no traffic stays at the prior",
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
