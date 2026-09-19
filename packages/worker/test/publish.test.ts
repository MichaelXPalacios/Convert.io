import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createUpstashMirrorPublisher, mirrorPublisherFromEnv } from "../src/publish.js";
import type { FetchLike } from "../src/http.js";

const KEY = "cv:post:v1:demo-landing";
const FIELDS = { __meta: '{"schemaVersion":1}', control: '{"alpha":1}' };

interface StubCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that answers with one canned payload and records what it was asked. */
function stubFetch(
  payload: unknown,
  response: { ok?: boolean; status?: number } = {},
): { fetch: FetchLike; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers ?? {},
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
    });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => payload,
    };
  };
  return { fetch, calls };
}

/** What Upstash answers a two-command transaction with when both succeed. */
const OK_TX = [{ result: 1 }, { result: 2 }];

describe("createUpstashMirrorPublisher", () => {
  it("requires a url and a token", () => {
    const { fetch } = stubFetch(OK_TX);
    assert.throws(() => createUpstashMirrorPublisher({ url: "", token: "t", fetch }));
    assert.throws(() => createUpstashMirrorPublisher({ url: "u", token: "", fetch }));
  });

  it("publishes to the atomic endpoint, not the pipeline one", async () => {
    const { fetch, calls } = stubFetch(OK_TX);
    await createUpstashMirrorPublisher({ url: "https://h", token: "t", fetch }).publish({
      key: KEY,
      fields: FIELDS,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://h/multi-exec");
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.headers.Authorization, "Bearer t");
  });

  it("replaces the key rather than merging into it", async () => {
    // The point of the DEL: an arm that was published last run and is paused
    // this run must not survive in the hash, or the edge allocates to it.
    const { fetch, calls } = stubFetch(OK_TX);
    await createUpstashMirrorPublisher({ url: "https://h", token: "t", fetch }).publish({
      key: KEY,
      fields: FIELDS,
    });

    const commands = calls[0]?.body as string[][];
    assert.deepEqual(commands[0], ["DEL", KEY]);
    assert.deepEqual(commands[1], [
      "HSET",
      KEY,
      "__meta",
      '{"schemaVersion":1}',
      "control",
      '{"alpha":1}',
    ]);
  });

  it("trims a trailing slash off the endpoint", async () => {
    const { fetch, calls } = stubFetch(OK_TX);
    await createUpstashMirrorPublisher({ url: "https://h/", token: "t", fetch }).publish({
      key: KEY,
      fields: FIELDS,
    });
    assert.equal(calls[0]?.url, "https://h/multi-exec");
  });

  it("refuses to publish an empty mirror", async () => {
    // DEL with nothing to write reads back as "not under test", which would
    // stop a running experiment rather than update it.
    const { fetch, calls } = stubFetch(OK_TX);
    await assert.rejects(
      createUpstashMirrorPublisher({ url: "https://h", token: "t", fetch }).publish({
        key: KEY,
        fields: {},
      }),
      /refusing to publish an empty mirror/,
    );
    assert.equal(calls.length, 0, "nothing should reach the network");
  });

  it("throws on a transport failure", async () => {
    const { fetch } = stubFetch(OK_TX, { ok: false, status: 502 });
    await assert.rejects(
      createUpstashMirrorPublisher({ url: "https://h", token: "t", fetch }).publish({
        key: KEY,
        fields: FIELDS,
      }),
      /status 502/,
    );
  });

  it("treats a failed command inside a 200 as a failure", async () => {
    // Upstash reports a broken command in the body, not the status.
    const { fetch } = stubFetch([{ result: 1 }, { error: "WRONGTYPE" }]);
    await assert.rejects(
      createUpstashMirrorPublisher({ url: "https://h", token: "t", fetch }).publish({
        key: KEY,
        fields: FIELDS,
      }),
      /WRONGTYPE/,
    );
  });

  it("rejects a response that is not a transaction", async () => {
    const { fetch } = stubFetch({ result: "OK" });
    await assert.rejects(
      createUpstashMirrorPublisher({ url: "https://h", token: "t", fetch }).publish({
        key: KEY,
        fields: FIELDS,
      }),
      /non-transaction response/,
    );
  });
});

describe("mirrorPublisherFromEnv", () => {
  it("accepts either provisioning's names", () => {
    assert.doesNotThrow(() =>
      mirrorPublisherFromEnv({
        UPSTASH_REDIS_REST_URL: "https://h",
        UPSTASH_REDIS_REST_TOKEN: "t",
      }),
    );
    assert.doesNotThrow(() =>
      mirrorPublisherFromEnv({ KV_REST_API_URL: "https://h", KV_REST_API_TOKEN: "t" }),
    );
  });

  it("will not take the read-only token", () => {
    // Accepting it would fail at the first HSET with a permission error that
    // looks like an outage.
    assert.throws(
      () =>
        mirrorPublisherFromEnv({
          UPSTASH_REDIS_REST_URL: "https://h",
          KV_REST_API_READ_ONLY_TOKEN: "readonly",
        }),
      /cannot publish/,
    );
  });

  it("rejects a redis:// URL with the reason", () => {
    assert.throws(
      () =>
        mirrorPublisherFromEnv({
          UPSTASH_REDIS_REST_URL: "redis://localhost:6379",
          UPSTASH_REDIS_REST_TOKEN: "t",
        }),
      /speaks HTTP/,
    );
  });

  it("names every spelling that would have worked", () => {
    assert.throws(() => mirrorPublisherFromEnv({}), /UPSTASH_REDIS_REST_URL or KV_REST_API_URL/);
  });
});
