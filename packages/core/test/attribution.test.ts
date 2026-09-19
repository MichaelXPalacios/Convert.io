import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attributeOrder, recordConversion, UNKNOWN_VISITOR } from "../src/attribution.js";
import type { Queryable } from "../src/exposure.js";
import type { AttributionResult, NormalizedOrder } from "@convertio/contracts";

const EXPOSURE_ID = "00000000-0000-4000-8000-000000000001";
const EXPERIMENT_ID = "00000000-0000-4000-8000-000000000002";
const ARM_ID = "00000000-0000-4000-8000-000000000003";
const CONVERSION_ID = "00000000-0000-4000-8000-000000000004";

const order: NormalizedOrder = {
  provider: "shopify",
  externalOrderId: "4242",
  valueCents: 12995,
  currency: "USD",
  occurredAt: new Date("2026-09-19T12:00:00Z"),
  visitorId: "visitor-1",
  email: "buyer@example.com",
};

interface Call {
  sql: string;
  params: readonly unknown[];
}

/** A database that answers with canned rows and records what it was asked. */
function fakeDb(rows: unknown[]): { db: Queryable; calls: Call[] } {
  const calls: Call[] = [];
  const db: Queryable = {
    async query<R>(sql: string, params: readonly unknown[]) {
      calls.push({ sql, params });
      return { rows: rows as R[] };
    },
  };
  return { db, calls };
}

describe("attributeOrder", () => {
  it("attributes to the exposure the query returned", async () => {
    const { db } = fakeDb([
      {
        exposure_id: EXPOSURE_ID,
        experiment_id: EXPERIMENT_ID,
        arm_id: ARM_ID,
        latency_hours: "3.5",
      },
    ]);

    const result = await attributeOrder(db, order);
    assert.equal(result.attributed, true);
    if (!result.attributed) return;
    assert.equal(result.exposureId, EXPOSURE_ID);
    assert.equal(result.armId, ARM_ID);
    // node-postgres returns numeric as a string; a raw pass-through would put
    // "3.5" into a field the contract types as a number.
    assert.equal(result.latencyHours, 3.5);
    assert.equal(typeof result.latencyHours, "number");
  });

  it("asks for the most recent exposure, not an arbitrary one", async () => {
    const { db, calls } = fakeDb([]);
    await attributeOrder(db, order);
    const sql = calls[0]?.sql ?? "";
    assert.match(sql, /ORDER BY e\.assigned_at DESC/);
    assert.match(sql, /LIMIT 1/);
  });

  it("bounds the search by the order time, not by now", async () => {
    // An exposure recorded after the order cannot have caused it.
    const { db, calls } = fakeDb([]);
    await attributeOrder(db, order);
    assert.equal(calls[0]?.params[1], order.occurredAt.toISOString());
  });

  it("does not query at all without a visitor id", async () => {
    const { db, calls } = fakeDb([]);
    const result = await attributeOrder(db, { ...order, visitorId: null });

    assert.equal(result.attributed, false);
    if (result.attributed) return;
    assert.match(result.reason, /no visitor id/);
    assert.equal(calls.length, 0);
  });

  it("explains an order that found no exposure in the window", async () => {
    const { db } = fakeDb([]);
    const result = await attributeOrder(db, order);

    assert.equal(result.attributed, false);
    if (result.attributed) return;
    assert.match(result.reason, /attribution window/);
  });

  it("never reports a negative latency", async () => {
    const { db } = fakeDb([
      {
        exposure_id: EXPOSURE_ID,
        experiment_id: EXPERIMENT_ID,
        arm_id: ARM_ID,
        latency_hours: "-0.001",
      },
    ]);
    const result = await attributeOrder(db, order);
    assert.equal(result.attributed && result.latencyHours, 0);
  });
});

const attributed: AttributionResult = {
  attributed: true,
  exposureId: EXPOSURE_ID,
  experimentId: EXPERIMENT_ID,
  armId: ARM_ID,
  latencyHours: 1,
};

const unattributed: AttributionResult = {
  attributed: false,
  reason: "no exposure for this visitor inside the attribution window",
};

describe("recordConversion", () => {
  it("reports a fresh write", async () => {
    const { db } = fakeDb([{ id: CONVERSION_ID, arm_id: ARM_ID, inserted: true }]);
    const result = await recordConversion(db, order, attributed);

    assert.deepEqual(result, {
      conversionId: CONVERSION_ID,
      attributed: true,
      armId: ARM_ID,
      reason: null,
      deduplicated: false,
    });
  });

  it("reports a provider retry as deduplicated rather than failing", async () => {
    const { db } = fakeDb([{ id: CONVERSION_ID, arm_id: ARM_ID, inserted: false }]);
    const result = await recordConversion(db, order, attributed);
    assert.equal(result.deduplicated, true);
    assert.equal(result.conversionId, CONVERSION_ID);
  });

  it("stores an unattributed order with null attribution and the reason", async () => {
    const { db, calls } = fakeDb([{ id: CONVERSION_ID, arm_id: null, inserted: true }]);
    const result = await recordConversion(db, order, unattributed);

    assert.equal(result.attributed, false);
    assert.equal(result.armId, null);
    assert.match(result.reason ?? "", /attribution window/);

    // The revenue is still recorded: that is what makes the unattributed rate
    // visible instead of silently absent.
    const params = calls[0]?.params ?? [];
    assert.equal(params[0], null, "exposure_id");
    assert.equal(params[2], null, "arm_id");
    assert.equal(params[6], 12995, "value_cents");
  });

  it("substitutes a sentinel visitor rather than dropping the row", async () => {
    // visitor_id is NOT NULL, and losing the row would lose the revenue.
    const { db, calls } = fakeDb([{ id: CONVERSION_ID, arm_id: null, inserted: true }]);
    await recordConversion(db, { ...order, visitorId: null }, unattributed);
    assert.equal(calls[0]?.params[3], UNKNOWN_VISITOR);
  });

  it("sends integer cents, never a float", async () => {
    const { db, calls } = fakeDb([{ id: CONVERSION_ID, arm_id: ARM_ID, inserted: true }]);
    await recordConversion(db, order, attributed);
    const cents = calls[0]?.params[6];
    assert.equal(Number.isInteger(cents), true);
  });

  it("throws when the statement returns nothing, rather than inventing a result", async () => {
    const { db } = fakeDb([]);
    await assert.rejects(recordConversion(db, order, attributed), /neither inserted nor found/);
  });
});
