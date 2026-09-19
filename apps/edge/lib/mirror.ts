/**
 * Reading the posterior mirror on the hot path.
 *
 * The worker writes one Redis HASH per experiment slug; see
 * @convertio/contracts/redis for the format and for why it lives in contracts
 * rather than here. The edge does exactly one HGETALL per request and never a
 * database read.
 *
 * The store is an interface rather than a concrete client on purpose. The
 * transport is the part of this system most likely to change — a TCP Redis
 * client cannot run on Vercel's edge runtime, which is why the Upstash REST
 * implementation exists — and allocation must not have to change with it.
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
  /** UPSTASH_REDIS_REST_URL, without a trailing slash. */
  url: string;
  /** UPSTASH_REDIS_REST_TOKEN. */
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
 * REST rather than a TCP client because the edge runtime has no raw sockets.
 * The token goes in an Authorization header and never into the URL, which
 * would put it in every access log between here and Upstash.
 */
export function createUpstashMirrorStore(options: UpstashMirrorStoreOptions): MirrorStore {
  const { url, token } = options;
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = options.timeoutMs ?? MIRROR_READ_TIMEOUT_MS;

  if (!url) throw new Error("UPSTASH_REDIS_REST_URL is required");
  if (!token) throw new Error("UPSTASH_REDIS_REST_TOKEN is required");
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

/**
 * Build the store from the environment.
 *
 * Kept separate from the constructor so tests and the worker can build a store
 * without a process environment, and so the missing-variable message names the
 * variable rather than surfacing as a generic failure at the first request.
 */
export function mirrorStoreFromEnv(env: Record<string, string | undefined>): MirrorStore {
  const url = env["UPSTASH_REDIS_REST_URL"];
  const token = env["UPSTASH_REDIS_REST_TOKEN"];

  if (url === undefined || url === "") {
    throw new Error("UPSTASH_REDIS_REST_URL is not set; the edge cannot read the posterior mirror");
  }
  if (token === undefined || token === "") {
    throw new Error(
      "UPSTASH_REDIS_REST_TOKEN is not set; the edge cannot read the posterior mirror",
    );
  }

  return createUpstashMirrorStore({ url, token });
}
