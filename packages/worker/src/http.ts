/**
 * The `fetch` shape the publisher needs, and nothing more.
 *
 * Declared here rather than imported from packages/core because the worker
 * does not depend on core -- core is the request path. Two three-line
 * structural types are a smaller cost than a dependency edge pointing the
 * wrong way.
 */

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;
