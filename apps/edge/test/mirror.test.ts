import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REDIS_MIRROR_META_FIELD,
  REDIS_MIRROR_SCHEMA_VERSION,
  redisPosteriorKey,
  serializePosteriorMirror,
} from "@convertio/contracts";
import type { MirrorArm, PosteriorMirror } from "@convertio/contracts";
import { createUpstashMirrorStore, mirrorStoreFromEnv } from "../lib/mirror.js";
import type { FetchLike } from "../lib/mirror.js";

const EXPERIMENT_ID = "00000000-0000-4000-8000-000000000001";
const ARM_ID = "00000000-0000-4000-8000-000000000002";

const arm: MirrorArm = {
  armId: ARM_ID,
  key: "control",
  isControl: true,
  status: "active",
  alpha: 1,
  beta: 1,
  allocation: 1,
  exposuresCount: 0,
};

const mirror: PosteriorMirror = {
  meta: {
    schemaVersion: REDIS_MIRROR_SCHEMA_VERSION,
    experimentId: EXPERIMENT_ID,
    slug: "demo-landing",
    explorationFloor: 0.1,
    minExposures: 1000,
    computedAt: "2026-09-18T00:00:00.000Z",
  },
  arms: [arm],
};

interface StubCall {
  url: string;
  headers: Record<string, string>;
}

/** A fetch that answers with one canned payload and records what it was asked. */
function stubFetch(
  payload: unknown,
  init: { ok?: boolean; status?: number } = {},
): { fetch: FetchLike; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const fetch: FetchLike = async (url, options) => {
    calls.push({ url, headers: options?.headers ?? {} });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => payload,
    };
  };
  return { fetch, calls };
}

/** Upstash returns HGETALL as a flat array of alternating field and value. */
function asUpstashArray(fields: Record<string, string>): string[] {
  return Object.entries(fields).flatMap(([k, v]) => [k, v]);
}

const store = (fetch: FetchLike) =>
  createUpstashMirrorStore({ url: "https://example.upstash.io", token: "tok", fetch });

describe("createUpstashMirrorStore", () => {
  it("requires a url and a token", () => {
    assert.throws(
      () => createUpstashMirrorStore({ url: "", token: "t", fetch: stubFetch({}).fetch }),
      /URL is required/,
    );
    assert.throws(
      () => createUpstashMirrorStore({ url: "u", token: "", fetch: stubFetch({}).fetch }),
      /TOKEN is required/,
    );
  });

  it("reads and parses a mirror", async () => {
    const { fetch } = stubFetch({ result: asUpstashArray(serializePosteriorMirror(mirror)) });
    const got = await store(fetch).read("demo-landing");

    assert.ok(got !== undefined);
    assert.equal(got.meta.slug, "demo-landing");
    assert.equal(got.meta.explorationFloor, 0.1);
    assert.equal(got.arms.length, 1);
    assert.equal(got.arms[0]?.key, "control");
  });

  it("accepts an object reply as well as a flat array", async () => {
    const { fetch } = stubFetch({ result: serializePosteriorMirror(mirror) });
    const got = await store(fetch).read("demo-landing");
    assert.equal(got?.arms[0]?.key, "control");
  });

  it("asks for the key contracts defines and sends the token as a bearer header", async () => {
    const { fetch, calls } = stubFetch({
      result: asUpstashArray(serializePosteriorMirror(mirror)),
    });
    await store(fetch).read("demo-landing");

    const call = calls[0];
    assert.ok(call !== undefined);
    assert.ok(
      call.url.endsWith(`/hgetall/${encodeURIComponent(redisPosteriorKey("demo-landing"))}`),
      call.url,
    );
    assert.equal(call.headers["Authorization"], "Bearer tok");
    // A token in the query string ends up in every access log in between.
    assert.ok(!call.url.includes("tok"), call.url);
  });

  it("strips a trailing slash from the base url", async () => {
    const { fetch, calls } = stubFetch({
      result: asUpstashArray(serializePosteriorMirror(mirror)),
    });
    const s = createUpstashMirrorStore({
      url: "https://example.upstash.io///",
      token: "tok",
      fetch,
    });
    await s.read("demo-landing");
    assert.ok(!(calls[0]?.url ?? "").includes("///hgetall"), calls[0]?.url);
  });

  it("returns undefined for a slug that is not under test", async () => {
    // Redis answers a missing hash with an empty reply, which is not an error.
    for (const empty of [{ result: [] }, { result: null }, { result: {} }]) {
      const { fetch } = stubFetch(empty);
      assert.equal(await store(fetch).read("nope"), undefined);
    }
  });

  it("throws on a non-ok response", async () => {
    const { fetch } = stubFetch({}, { ok: false, status: 502 });
    await assert.rejects(store(fetch).read("demo-landing"), /status 502/);
  });

  it("throws when the reply is truncated to an odd number of entries", async () => {
    const { fetch } = stubFetch({ result: ["only-a-field"] });
    await assert.rejects(store(fetch).read("demo-landing"), /not field\/value pairs/);
  });

  it("throws when a field or value is not a string", async () => {
    const { fetch } = stubFetch({ result: ["field", 42] });
    await assert.rejects(store(fetch).read("demo-landing"), /non-string field or value/);
  });

  it("throws when __meta is missing", async () => {
    // Allocating without the guardrail values is worse than failing: the caller
    // can fall back to the control, but it cannot invent a floor it never read.
    const fields = serializePosteriorMirror(mirror);
    delete fields[REDIS_MIRROR_META_FIELD];
    const { fetch } = stubFetch({ result: asUpstashArray(fields) });
    await assert.rejects(store(fetch).read("demo-landing"), /__meta/);
  });

  it("throws when __meta is malformed", async () => {
    const { fetch } = stubFetch({
      result: asUpstashArray({ [REDIS_MIRROR_META_FIELD]: "{not json" }),
    });
    await assert.rejects(store(fetch).read("demo-landing"));
  });

  it("aborts a read that exceeds its timeout", async () => {
    const hangs: FetchLike = (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });

    const s = createUpstashMirrorStore({
      url: "https://example.upstash.io",
      token: "tok",
      fetch: hangs,
      timeoutMs: 20,
    });

    await assert.rejects(s.read("demo-landing"), /aborted/);
  });
});

describe("mirrorStoreFromEnv", () => {
  it("names the variable that is missing", () => {
    assert.throws(() => mirrorStoreFromEnv({}), /UPSTASH_REDIS_REST_URL is not set/);
    assert.throws(
      () => mirrorStoreFromEnv({ UPSTASH_REDIS_REST_URL: "https://x" }),
      /UPSTASH_REDIS_REST_TOKEN is not set/,
    );
  });

  it("treats an empty variable as unset", () => {
    assert.throws(
      () => mirrorStoreFromEnv({ UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "t" }),
      /UPSTASH_REDIS_REST_URL is not set/,
    );
  });

  it("builds a store when both are present", () => {
    const s = mirrorStoreFromEnv({
      UPSTASH_REDIS_REST_URL: "https://x.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "t",
    });
    assert.equal(typeof s.read, "function");
  });
});
