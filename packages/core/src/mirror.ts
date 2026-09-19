/**
 * Reading the posterior mirror on the hot path.
 *
 * The worker writes one Redis HASH per experiment slug; see
 * @convertio/contracts/redis for the format and for why it lives in contracts
 * rather than here. The edge does exactly one HGETALL per request and never a
 * database read.
 *
 * The store is an interface rather than a concrete client on purpose: the
 * transport is the part of this system most likely to change, and allocation
 * must not have to change with it.
 *
 * REST rather than a TCP client because it is one fetch that behaves the same
 * on every runtime — NOT because sockets are unavailable. Next 16 deprecates
 * the edge runtime in favour of Node, where sockets do work, and leaving the
 * old reason in place would invite someone to "fix" this back to a TCP client
 * on a premise that is no longer true.
 */

import { parsePosteriorMirror, redisPosteriorKey } from "@convertio/contracts";
import type { PosteriorMirror } from "@convertio/contracts";

/**
 * How long the hot path will wait for the mirror before giving up.
 *
 * A landing page that renders slowly has already lost the visitor the
 * experiment was measuring, so a slow read is treated as a failed one.
 */
export const MIRROR_READ_TIMEOUT_MS = 500;

export interface MirrorStore {
  /**
   * The mirror for a slug, or undefined when no such key exists — which means
   * the slug is not under test, not that something went wrong.
   *
   * Throws on a transport failure or a malformed mirror. Both are real faults
   * and the caller needs to be able to tell them apart from "no experiment".
   */
  read(slug: string): Promise<PosteriorMirror | undefined>;
}

/** The `fetch` the store should use. Injected so tests need no network. */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface UpstashMirrorStoreOptions {
  /** The REST endpoint, e.g. https://<name>.upstash.io. Trailing slashes are trimmed. */
  url: string;
  /** A REST token. A read-only one is sufficient: this store never writes. */
  token: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/**
 * Turn Upstash's HGETALL reply into the flat field map contracts expects.
 *
 * The REST API returns a flat array of alternating field and value, so an odd
 * length means the reply was truncated. That is worth failing on rather than
 * silently dropping the final field, which could be `__meta`.
 */
function toFieldMap(result: unknown): Record<string, string> | undefined {
  if (result === null || result === undefined) return undefined;

  if (Array.isArray(result)) {
    if (result.length === 0) return undefined;
    if (result.length % 2 !== 0) {
      throw new Error(`HGETALL returned ${result.length} entries, which is not field/value pairs`);
    }
    const out: Record<string, string> = {};
    for (let i = 0; i < result.length; i += 2) {
      const field = result[i];
      const value = result[i + 1];
      if (typeof field !== "string" || typeof value !== "string") {
        throw new Error("HGETALL returned a non-string field or value");
      }
      out[field] = value;
    }
    return out;
  }

  // Some clients hand back an object already. Accept it rather than insisting
  // on a shape that carries no extra information.
  if (typeof result === "object") {
    const entries = Object.entries(result as Record<string, unknown>);
    if (entries.length === 0) return undefined;
    const out: Record<string, string> = {};
    for (const [field, value] of entries) {
      if (typeof value !== "string") {
        throw new Error(`HGETALL field "${field}" was not a string`);
      }
      out[field] = value;
    }
    return out;
  }

  throw new Error(`HGETALL returned an unexpected shape: ${typeof result}`);
}

/**
 * A mirror store backed by the Upstash REST API.
 *
 * The token goes in an Authorization header and never into the URL, which
 * would put it in every access log between here and Upstash.
 */
export function createUpstashMirrorStore(options: UpstashMirrorStoreOptions): MirrorStore {
  const { url, token } = options;
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = options.timeoutMs ?? MIRROR_READ_TIMEOUT_MS;

  if (!url) throw new Error("a REST URL is required");
  if (!token) throw new Error("a REST token is required");
  if (typeof doFetch !== "function") {
    throw new Error("no fetch implementation available for the mirror store");
  }

  const base = url.replace(/\/+$/, "");

  return {
    async read(slug: string): Promise<PosteriorMirror | undefined> {
      const key = redisPosteriorKey(slug);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let payload: unknown;
      try {
        const response = await doFetch(`${base}/hgetall/${encodeURIComponent(key)}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`mirror read for "${slug}" failed with status ${response.status}`);
        }

        payload = await response.json();
      } finally {
        clearTimeout(timer);
      }

      const result =
        typeof payload === "object" && payload !== null && "result" in payload
          ? (payload as { result: unknown }).result
          : undefined;

      const fields = toFieldMap(result);
      if (fields === undefined) return undefined;

      // Throws when `__meta` is missing or malformed, which is deliberate:
      // allocating without the guardrail values is worse than failing, because
      // the caller can fall back to the control but cannot invent a floor.
      return parsePosteriorMirror(fields);
    },
  };
}

/** The first of these names that carries a non-empty value. */
function firstSet(env: Record<string, string | undefined>, names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/**
 * The REST URL, under either name.
 *
 * Provisioning Upstash through the Vercel Marketplace injects `KV_REST_API_*`
 * rather than `UPSTASH_REDIS_REST_*`. Both are the same database; accepting
 * both means nobody has to copy a live credential into a second variable just
 * to satisfy a name.
 *
 * `KV_URL` and `REDIS_URL` are deliberately NOT accepted. They are `redis://`
 * TCP URLs, and this client speaks HTTP — taking one would fail at the first
 * request instead of here, with a connection error that looks like an outage.
 */
const URL_VARS = ["UPSTASH_REDIS_REST_URL", "KV_REST_API_URL"];

/**
 * The token, most-specific first.
 *
 * `KV_REST_API_READ_ONLY_TOKEN` is preferred over the read-write token because
 * a MirrorStore only ever reads: the worker writes the mirror, the edge reads
 * it. Handing the request path a token that can also write is an authority it
 * has no use for, and the read-only one is right there.
 */
const TOKEN_VARS = ["UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_READ_ONLY_TOKEN", "KV_REST_API_TOKEN"];

/**
 * Build the store from the environment.
 *
 * Kept separate from the constructor so tests and the worker can build a store
 * without a process environment, and so a missing variable names every spelling
 * that would have worked rather than surfacing as a generic failure at the
 * first request.
 */
export function mirrorStoreFromEnv(env: Record<string, string | undefined>): MirrorStore {
  const url = firstSet(env, URL_VARS);
  const token = firstSet(env, TOKEN_VARS);

  if (url === undefined) {
    throw new Error(
      `no Upstash REST URL in the environment; set one of ${URL_VARS.join(" or ")}. ` +
        "KV_URL and REDIS_URL are redis:// TCP URLs and will not work.",
    );
  }
  if (token === undefined) {
    throw new Error(
      `no Upstash REST token in the environment; set one of ${TOKEN_VARS.join(" or ")}`,
    );
  }

  if (url.startsWith("redis://") || url.startsWith("rediss://")) {
    throw new Error(
      `the Upstash REST URL is a ${url.slice(0, url.indexOf(":"))}:// TCP URL. ` +
        "This client speaks HTTP; use the REST endpoint (https://<name>.upstash.io).",
    );
  }

  return createUpstashMirrorStore({ url, token });
}
