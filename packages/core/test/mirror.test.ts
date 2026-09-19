import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REDIS_MIRROR_META_FIELD,
  REDIS_MIRROR_SCHEMA_VERSION,
  redisPosteriorKey,
  serializePosteriorMirror,
} from "@convertio/contracts";
import type { MirrorArm, PosteriorMirror } from "@convertio/contracts";
import { createUpstashMirrorStore, mirrorStoreFromEnv } from "../src/mirror.js";
import type { FetchLike } from "../src/mirror.js";

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
      /REST URL is required/,
    );
    assert.throws(
      () => createUpstashMirrorStore({ url: "u", token: "", fetch: stubFetch({}).fetch }),
      /REST token is required/,
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
  it("names every spelling that would have worked", () => {
    assert.throws(() => mirrorStoreFromEnv({}), /UPSTASH_REDIS_REST_URL or KV_REST_API_URL/);
    assert.throws(
      () => mirrorStoreFromEnv({ UPSTASH_REDIS_REST_URL: "https://x" }),
      /UPSTASH_REDIS_REST_TOKEN or KV_REST_API_READ_ONLY_TOKEN or KV_REST_API_TOKEN/,
    );
  });

  it("treats an empty variable as unset", () => {
    assert.throws(
      () => mirrorStoreFromEnv({ UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "t" }),
      /no Upstash REST URL/,
    );
  });

  it("builds a store from the UPSTASH_ names", () => {
    const s = mirrorStoreFromEnv({
      UPSTASH_REDIS_REST_URL: "https://x.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "t",
    });
    assert.equal(typeof s.read, "function");
  });

  it("builds a store from the KV_ names the Vercel Marketplace injects", async () => {
    // Provisioning Upstash through Vercel sets KV_REST_API_*; it is the same
    // database, and nobody should have to copy a credential to satisfy a name.
    const { fetch, calls } = stubFetch({
      result: asUpstashArray(serializePosteriorMirror(mirror)),
    });
    const s = createUpstashMirrorStore({
      url: "https://x.upstash.io",
      token: "readonly-token",
      fetch,
    });
    await s.read("demo-landing");
    assert.equal(calls[0]?.headers["Authorization"], "Bearer readonly-token");

    const fromEnv = mirrorStoreFromEnv({
      KV_REST_API_URL: "https://x.upstash.io",
      KV_REST_API_TOKEN: "t",
    });
    assert.equal(typeof fromEnv.read, "function");
  });

  it("prefers the read-only token, because a mirror store only ever reads", () => {
    // The worker writes the mirror; the request path has no use for an
    // authority it never exercises.
    const s = mirrorStoreFromEnv({
      KV_REST_API_URL: "https://x.upstash.io",
      KV_REST_API_READ_ONLY_TOKEN: "ro",
      KV_REST_API_TOKEN: "rw",
    });
    assert.equal(typeof s.read, "function");
  });

  it("prefers an explicit UPSTASH_ value over an injected KV_ one", () => {
    const s = mirrorStoreFromEnv({
      UPSTASH_REDIS_REST_URL: "https://explicit.upstash.io",
      KV_REST_API_URL: "https://injected.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "t",
    });
    assert.equal(typeof s.read, "function");
  });

  it("rejects a redis:// URL with an explanation rather than failing at request time", () => {
    // KV_URL and REDIS_URL are TCP URLs. Taking one would surface as a
    // connection error that looks like an Upstash outage.
    for (const url of ["redis://x.upstash.io:6379", "rediss://x.upstash.io:6379"]) {
      assert.throws(
        () => mirrorStoreFromEnv({ KV_REST_API_URL: url, KV_REST_API_TOKEN: "t" }),
        /TCP URL/,
      );
    }
  });
});
