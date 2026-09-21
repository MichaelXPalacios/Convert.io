/**
 * What the auditor is allowed to fetch.
 *
 * This endpoint takes a URL from a caller and makes the server fetch it. That
 * is server-side request forgery by construction, and authentication does not
 * fix it — authentication decides *who* can aim the server, not *where*. An
 * authenticated caller, or anyone who obtains the token, could otherwise ask
 * for http://169.254.169.254/ and read cloud metadata, or sweep
 * http://localhost:5432 and learn what is listening.
 *
 * So the address is checked, not the string. Three properties matter:
 *
 *   1. A hostname is checked AFTER resolution, because "internal.example.com"
 *      is a public-looking name that can resolve to 10.0.0.1.
 *   2. Every redirect hop is checked again, because a public host can answer
 *      302 with a Location pointing inside.
 *   3. The response is capped in bytes and in time, because an attacker who
 *      cannot read the answer can still make us pay to download and tokenize
 *      a 50 MB page.
 *
 * What this deliberately does NOT claim: DNS rebinding is not fully closed.
 * The name is resolved for the check and resolved again by fetch, and a
 * hostile resolver can answer differently between the two. Closing that means
 * connecting to a pinned address with the Host header preserved, which fetch
 * does not expose. The residual risk is recorded here rather than papered
 * over.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class UrlPolicyError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "UrlPolicyError";
    this.status = status;
  }
}

/** Redirect hops followed before giving up. */
export const MAX_REDIRECTS = 5;

/** Bytes of HTML read before the body is abandoned. */
export const MAX_BYTES = 2_000_000;

/** Milliseconds for the whole fetch, redirects included. */
export const FETCH_TIMEOUT_MS = 10_000;

const toParts = (ip: string): number[] => ip.split(".").map((n) => Number(n));

/**
 * Ranges that must never be reachable from a user-supplied URL.
 *
 * Loopback and private ranges are the obvious ones. 169.254.0.0/16 is the
 * important one: it is where every major cloud puts its instance metadata
 * service, and reading it is how a credential leaks.
 */
function isPrivateIpv4(ip: string): boolean {
  const [a = 0, b = 0] = toParts(ip);

  if (a === 0) return true; // "this host"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0) return true; // protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const addr = ip.toLowerCase().split("%")[0] ?? "";

  if (addr === "::" || addr === "::1") return true;

  // IPv4-mapped (::ffff:10.0.0.1) and IPv4-compatible forms carry a v4
  // address inside a v6 one; the embedded address is what actually gets
  // contacted, so it is what must be judged.
  const embedded = addr.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embedded?.[1]) return isPrivateIpv4(embedded[1]);

  if (/^f[cd]/.test(addr)) return true; // unique local fc00::/7
  if (/^fe[89ab]/.test(addr)) return true; // link-local fe80::/10
  if (/^ff/.test(addr)) return true; // multicast
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family === 6) return isPrivateIpv6(ip);
  // Not an address at all. Refusing is the safe answer.
  return true;
}

/**
 * Parse and check one URL. Throws UrlPolicyError; returns the parsed URL.
 *
 * Exported separately from the fetch so the policy can be tested without a
 * network, which is the only way this gets tested at all.
 */
export async function assertFetchableUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlPolicyError("not a valid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    // file:, data:, gopher: and friends. file: would read the server's disk.
    throw new UrlPolicyError(`unsupported scheme ${url.protocol.replace(":", "")}`);
  }

  if (url.username !== "" || url.password !== "") {
    // Credentials in a URL are both a smell and a redirect-laundering trick.
    throw new UrlPolicyError("credentials in the URL are not accepted");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");

  // A literal address needs no resolution and must be judged as written.
  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) {
      throw new UrlPolicyError("that address is not publicly routable");
    }
    return url;
  }

  let resolved: Array<{ address: string }>;
  try {
    resolved = await lookup(host, { all: true });
  } catch {
    throw new UrlPolicyError("that hostname does not resolve");
  }

  if (resolved.length === 0) {
    throw new UrlPolicyError("that hostname does not resolve");
  }

  // EVERY answer must be public. One private address among several is enough
  // to reach the private one, since which is used is not ours to choose.
  for (const { address } of resolved) {
    if (isPrivateAddress(address)) {
      throw new UrlPolicyError("that hostname resolves to a non-public address");
    }
  }

  return url;
}

export interface FetchedPage {
  /** The URL actually fetched, after redirects. */
  url: string;
  html: string;
  truncated: boolean;
}

/**
 * Fetch a page under the policy above.
 *
 * Redirects are followed by hand rather than by fetch, because fetch's own
 * redirect handling would take us somewhere nobody checked.
 */
export async function fetchPage(
  raw: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchedPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let current = await assertFetchableUrl(raw);

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await fetchImpl(current.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          // Identify honestly. A site that wishes to refuse us should be able
          // to.
          "user-agent": "convertio-audit/0.1 (+https://github.com/MichaelXPalacios/Convert.io)",
          accept: "text/html,application/xhtml+xml",
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location === null) {
          throw new UrlPolicyError("redirect without a location", 502);
        }
        // Re-check the destination. This is the hop that matters: a public
        // host answering 302 to http://169.254.169.254/ is the whole attack.
        current = await assertFetchableUrl(new URL(location, current).toString());
        continue;
      }

      if (!response.ok) {
        throw new UrlPolicyError(`the page returned ${response.status}`, 502);
      }

      const type = response.headers.get("content-type") ?? "";
      if (type !== "" && !/html|xml|text\/plain/i.test(type)) {
        throw new UrlPolicyError(`expected HTML, got ${type.split(";")[0]}`, 415);
      }

      const { text, truncated } = await readCapped(response);
      return { url: current.toString(), html: text, truncated };
    }

    throw new UrlPolicyError("too many redirects", 502);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read at most MAX_BYTES.
 *
 * Content-Length is checked first because it is free, but it is a claim and
 * not a fact, so the stream is capped as it arrives regardless.
 */
async function readCapped(response: Response): Promise<{ text: string; truncated: boolean }> {
  const claimed = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(claimed) && claimed > MAX_BYTES) {
    throw new UrlPolicyError("that page is too large to audit", 413);
  }

  const body = response.body;
  if (body === null) return { text: "", truncated: false };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;

    total += value.byteLength;
    if (total > MAX_BYTES) {
      chunks.push(value.subarray(0, value.byteLength - (total - MAX_BYTES)));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }

  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}
