import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recordExposure } from "../src/exposure.js";
import type { Queryable } from "../src/exposure.js";

const EXPOSURE_ID = "00000000-0000-4000-8000-0000000000aa";

interface Call {
  sql: string;
  params: readonly unknown[];
}

/** Records what it was asked and answers with canned rows. */
function fakeDb(rows: Array<{ id: string; inserted: boolean }>): {
  db: Queryable;
  calls: Call[];
} {
  const calls: Call[] = [];
  const db: Queryable = {
    query: async <R>(sql: string, params: readonly unknown[]) => {
      calls.push({ sql, params });
      return { rows: rows as unknown as R[] };
    },
  };
  return { db, calls };
}

const request = {
  slug: "demo-landing",
  armKey: "variant-a",
  visitorId: "v-1",
  sessionId: "s-1",
};

describe("recordExposure", () => {
  it("reports a newly created exposure as not deduplicated", async () => {
    const { db } = fakeDb([{ id: EXPOSURE_ID, inserted: true }]);
    const result = await recordExposure(db, request);

    assert.deepEqual(result, { exposureId: EXPOSURE_ID, deduplicated: false });
  });

  it("reports an existing exposure as deduplicated, with the original id", async () => {
    // The property the posteriors depend on: a second fire returns the first
    // row rather than creating a second one.
    const { db } = fakeDb([{ id: EXPOSURE_ID, inserted: false }]);
    const result = await recordExposure(db, request);

    assert.deepEqual(result, { exposureId: EXPOSURE_ID, deduplicated: true });
  });

  it("returns undefined when no arm matches the slug and key", async () => {
    const { db } = fakeDb([]);
    assert.equal(await recordExposure(db, request), undefined);
  });

  it("resolves the arm and inserts in a single round trip", async () => {
    // Two statements would leave a race between resolving the arm and writing
    // the row.
    const { db, calls } = fakeDb([{ id: EXPOSURE_ID, inserted: true }]);
    await recordExposure(db, request);

    assert.equal(calls.length, 1);
    assert.match(calls[0]?.sql ?? "", /ON CONFLICT \(visitor_id, session_id, arm_id\) DO NOTHING/);
  });

  it("passes the identifying columns in the order the statement expects", async () => {
    const { db, calls } = fakeDb([{ id: EXPOSURE_ID, inserted: true }]);
    await recordExposure(db, request);

    const params = calls[0]?.params ?? [];
    assert.equal(params[0], "demo-landing");
    assert.equal(params[1], "variant-a");
    assert.equal(params[2], "v-1");
    assert.equal(params[3], "s-1");
    assert.equal(params.length, 13);
  });

  it("sends null, not undefined, for every attribution field left out", async () => {
    // node-postgres turns undefined into NULL anyway, but relying on that means
    // a driver swap silently changes what is written.
    const { db, calls } = fakeDb([{ id: EXPOSURE_ID, inserted: true }]);
    await recordExposure(db, request);

    const optional = (calls[0]?.params ?? []).slice(4);
    assert.equal(optional.length, 9);
    for (const value of optional) assert.equal(value, null);
  });

  it("carries the attribution fields through when they are present", async () => {
    const { db, calls } = fakeDb([{ id: EXPOSURE_ID, inserted: true }]);
    await recordExposure(db, {
      ...request,
      utmSource: "meta",
      utmMedium: "cpc",
      utmCampaign: "spring",
      utmContent: "ad-3",
      utmTerm: "serum",
      referrer: "https://ads.example/click",
      userAgent: "Mozilla/5.0",
      device: "mobile",
      country: "US",
    });

    assert.deepEqual((calls[0]?.params ?? []).slice(4), [
      "meta",
      "cpc",
      "spring",
      "ad-3",
      "serum",
      "https://ads.example/click",
      "Mozilla/5.0",
      "mobile",
      "US",
    ]);
  });

  it("rejects a request the contract would not accept", async () => {
    const { db, calls } = fakeDb([]);

    // Not kebab-case, so SlugSchema refuses it.
    await assert.rejects(recordExposure(db, { ...request, slug: "Demo_Landing" }));
    // An empty visitor id cannot identify anyone.
    await assert.rejects(recordExposure(db, { ...request, visitorId: "" }));
    // Not a device the schema's CHECK constraint allows.
    await assert.rejects(
      recordExposure(db, { ...request, device: "watch" } as unknown as typeof request),
    );

    assert.equal(calls.length, 0, "a malformed request must not reach the database");
  });

  it("lets a database failure surface rather than swallowing it", async () => {
    const db: Queryable = {
      query: async () => {
        throw new Error("connection terminated");
      },
    };
    await assert.rejects(recordExposure(db, request), /connection terminated/);
  });
});
