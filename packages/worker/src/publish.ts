/**
 * Mirror publication.
 *
 * `recomputeAll` returns `mirrorKey` and `mirrorFields` but deliberately does
 * not write them: the mirror must not be published before the posteriors rows
 * it describes are durable, and only the caller knows where its transaction
 * ends. This module is the other half — it takes what the recompute produced
 * and puts it where the edge reads.
 *
 * The write lives here rather than in packages/core because core is the
 * request path, and the request path has no business holding a credential that
 * can write the mirror. Core reads; the worker writes.
 *
 * Published over Upstash's REST API for the same reason core reads over it: a
 * single fetch that behaves identically on either runtime.
 */

import type { FetchLike } from "./http.js";

/**
 * A stale-field problem the naive HSET has and this does not.
 *
 * HSET merges. An arm that was in the mirror last run and is paused this run
 * keeps its old field forever, and the edge cannot tell a stale arm from a
 * live one -- it would allocate traffic to something the operator paused. So
 * the key is replaced rather than merged: DEL then HSET, inside MULTI/EXEC so
 * no reader ever observes the gap between them.
 *
 * `/multi-exec` is the atomic endpoint. `/pipeline` is not -- it is only a
 * batching convenience, and a reader can land between its commands.
 */
const MULTI_EXEC_PATH = "/multi-exec";

export interface PublishTarget {
  /** Redis key, from `ExperimentRecompute.mirrorKey`. */
  key: string;
  /** HSET field map, from `ExperimentRecompute.mirrorFields`. */
  fields: Record<string, string>;
}

export interface MirrorPublisherOptions {
  /** Upstash REST endpoint, e.g. https://name.upstash.io */
  url: string;
  /**
   * A REST token with write access.
   *
   * Note this is NOT the read-only token core prefers. Publishing needs
   * authority the request path does not, which is exactly why the two halves
   * read their credentials independently instead of sharing one.
   */
  token: string;
  /** Injected so tests need no network. */
  fetch?: FetchLike;
  /** Defaults to 5s. Generous: this is a cron, not a request path. */
  timeoutMs?: number;
}

export interface MirrorPublisher {
  publish(target: PublishTarget): Promise<void>;
}

export const PUBLISH_TIMEOUT_MS = 5_000;

export function createUpstashMirrorPublisher(options: MirrorPublisherOptions): MirrorPublisher {
  const { url, token } = options;
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = options.timeoutMs ?? PUBLISH_TIMEOUT_MS;

  if (!url) throw new Error("a REST URL is required");
  if (!token) throw new Error("a REST token is required");
  if (typeof doFetch !== "function") {
    throw new Error("no fetch implementation available for the mirror publisher");
  }

  const base = url.replace(/\/+$/, "");

  return {
    async publish({ key, fields }: PublishTarget): Promise<void> {
      const entries = Object.entries(fields);

      // An empty mirror would DEL the key and write nothing, which reads back
      // as "not under test" -- the edge would stop allocating a running
      // experiment. A recompute that produced no fields is a bug upstream, and
      // silently publishing it converts that bug into an outage.
      if (entries.length === 0) {
        throw new Error(`refusing to publish an empty mirror for "${key}"`);
      }

      const commands: string[][] = [
        ["DEL", key],
        ["HSET", key, ...entries.flat()],
      ];

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let payload: unknown;
      try {
        const response = await doFetch(`${base}${MULTI_EXEC_PATH}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(commands),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`mirror publish for "${key}" failed with status ${response.status}`);
        }

        payload = await response.json();
      } finally {
        clearTimeout(timer);
      }

      // Upstash answers a transaction with one result object per command, and
      // reports a failed command in the body rather than in the status. A 200
      // is not success on its own.
      if (!Array.isArray(payload)) {
        throw new Error(`mirror publish for "${key}" returned a non-transaction response`);
      }

      for (const step of payload) {
        const error =
          typeof step === "object" && step !== null && "error" in step
            ? (step as { error?: unknown }).error
            : undefined;
        if (error !== undefined && error !== null) {
          throw new Error(`mirror publish for "${key}" failed: ${String(error)}`);
        }
      }
    },
  };
}

/** The REST URL and a write-capable token, under either provisioning's names. */
const URL_VARS = ["UPSTASH_REDIS_REST_URL", "KV_REST_API_URL"];

/**
 * Write tokens only.
 *
 * `KV_REST_API_READ_ONLY_TOKEN` is deliberately absent: core prefers it
 * because core only reads, and a publisher that silently accepted it would
 * fail at the first HSET with a permission error that looks like an outage.
 */
const TOKEN_VARS = ["UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN"];

const firstSet = (env: Record<string, string | undefined>, names: string[]): string | undefined => {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
};

export function mirrorPublisherFromEnv(env: Record<string, string | undefined>): MirrorPublisher {
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
      `no Upstash REST write token in the environment; set one of ${TOKEN_VARS.join(" or ")}. ` +
        "KV_REST_API_READ_ONLY_TOKEN cannot publish.",
    );
  }
  if (url.startsWith("redis://") || url.startsWith("rediss://")) {
    throw new Error(
      `the Upstash REST URL is a ${url.slice(0, url.indexOf(":"))}:// TCP URL. ` +
        "This client speaks HTTP; use the REST endpoint (https://<name>.upstash.io).",
    );
  }

  return createUpstashMirrorPublisher({ url, token });
}
