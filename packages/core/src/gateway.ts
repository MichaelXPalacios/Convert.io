/**
 * Route decisions, without the framework.
 *
 * Every rule that decides whether a request is allowed, what it means, and
 * what status it deserves lives here. The route handlers in apps/edge are
 * adapters: they read the request, call one of these, and map the result onto
 * a NextResponse. They contain no decisions of their own.
 *
 * WHY THE SPLIT EXISTS: a Next route module cannot be imported outside Next's
 * bundler -- `next/server` does not resolve under plain Node, with or without
 * resolution conditions. So logic that lives inside a route handler cannot be
 * unit tested at all, and the only proof it works is someone running curl
 * against a dev server and reading the output. That is a fine way to check
 * something once and a terrible way to keep it working: it does not run in CI,
 * it does not run on a pull request, and nothing fails when a refactor quietly
 * inverts a condition.
 *
 * These are the rules protecting money and identity, so "verified once, by
 * hand" was not good enough. Everything below is pure, takes its secrets as
 * arguments rather than reading the environment, and is covered in
 * packages/core/test/gateway.test.ts.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import {
  COOKIE_ASSIGNMENT,
  COOKIE_SESSION,
  COOKIE_VISITOR,
  TrackRequestSchema,
} from "@convertio/contracts";
import type { NormalizedOrder, TrackRequest } from "@convertio/contracts";
import { parseCookieHeader } from "./identity.js";
import {
  normalizeShopifyOrder,
  normalizeStripeEvent,
  verifyShopifySignature,
  verifyStripeSignature,
} from "./webhook.js";

/** The slice of `Headers` these functions need. The web `Headers` satisfies it. */
export interface HeaderLookup {
  get(name: string): string | null;
}

/**
 * A decision: proceed with a value, or stop with a status and a message.
 *
 * Statuses live here rather than in the routes because the status IS part of
 * the decision -- 401 versus 503 versus 202 each tell a caller something
 * different about whether to retry, and getting that wrong is how a provider
 * either gives up on a real order or hammers an endpoint forever.
 */
export type Decision<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const deny = (status: number, error: string): Decision<never> => ({ ok: false, status, error });

// ---------------------------------------------------------------------------
// Cron authorization
// ---------------------------------------------------------------------------

/**
 * Constant time, and length-safe.
 *
 * `timingSafeEqual` throws when the two buffers differ in length, and letting
 * that throw would leak the secret's length through the error path. Hashing
 * both sides first makes every comparison fixed-width.
 */
function secretMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Who may run the recompute.
 *
 * An unset secret is 503, never open. This route rewrites every posterior in
 * the system, so a deployment that forgot to configure it must refuse rather
 * than accept anyone -- a misconfiguration that silently allowed the world to
 * trigger recomputes would look exactly like a working deployment.
 */
export function authorizeCron(
  authorizationHeader: string | null,
  expected: string | undefined,
): Decision<true> {
  if (expected === undefined || expected === "") {
    return deny(503, "cron is not configured");
  }

  const header = authorizationHeader ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

  if (presented === "" || !secretMatches(presented, expected)) {
    return deny(401, "unauthorized");
  }

  return { ok: true, value: true };
}

// ---------------------------------------------------------------------------
// Track
// ---------------------------------------------------------------------------

/** Vercel resolves the visitor's country for us; locally there is none. */
export const COUNTRY_HEADER = "x-vercel-ip-country";

/**
 * Device from the user agent.
 *
 * Deliberately crude. Nothing downstream allocates on it, and a real device
 * library is a dependency and a maintenance surface bought for a field nobody
 * makes a decision with. Order matters: every tablet user agent also says
 * mobile, and most bots also say one of the two.
 */
export function deviceFrom(userAgent: string | null): TrackRequest["device"] {
  if (userAgent === null || userAgent === "") return null;
  const ua = userAgent.toLowerCase();
  if (/bot|crawler|spider|crawling|headless|lighthouse|preview/.test(ua)) return "bot";
  if (/ipad|tablet|playbook|silk/.test(ua)) return "tablet";
  if (/mobi|android|iphone|ipod/.test(ua)) return "mobile";
  return "desktop";
}

/** Undefined for anything that is not a non-empty string, so zod sees one shape. */
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** The campaign fields a caller is allowed to supply. */
interface TrackBody {
  slug?: unknown;
  referrer?: unknown;
  utmSource?: unknown;
  utmMedium?: unknown;
  utmCampaign?: unknown;
  utmContent?: unknown;
  utmTerm?: unknown;
}

/**
 * Build a TrackRequest from a request, taking identity from cookies only.
 *
 * TrackRequest names visitorId, sessionId and armKey and NONE of them may come
 * from the body. They are the idempotency key and the attribution key at once,
 * so a caller that can name its own visitorId can mint exposures for an arm it
 * was never shown, and the only symptom is a posterior that quietly stops
 * matching reality. They come from the proxy's cookies, which are HttpOnly --
 * the page's own script cannot read them to send them anyway.
 *
 * userAgent, device and country come from headers for the same reason. Country
 * in particular is edge-injected and a browser cannot know it; forged geo
 * poisons segmentation in a way nobody notices for months.
 *
 * 204, not 400, when the assignment cookies are absent. That means the proxy
 * never allocated this request -- a direct call, a client that drops cookies,
 * or a page served through the unallocated fallback. There is no exposure to
 * record and nothing went wrong.
 */
export function buildTrackRequest(body: unknown, headers: HeaderLookup): Decision<TrackRequest> {
  const cookies = parseCookieHeader(headers.get("cookie"));

  const visitorId = cookies[COOKIE_VISITOR];
  const sessionId = cookies[COOKIE_SESSION];
  const armKey = cookies[COOKIE_ASSIGNMENT];

  if (visitorId === undefined || sessionId === undefined || armKey === undefined) {
    return deny(204, "no assignment on this request");
  }

  const fields = (typeof body === "object" && body !== null ? body : {}) as TrackBody;
  const userAgent = headers.get("user-agent");

  const parsed = TrackRequestSchema.safeParse({
    slug: str(fields.slug),
    armKey,
    visitorId,
    sessionId,
    utmSource: str(fields.utmSource) ?? null,
    utmMedium: str(fields.utmMedium) ?? null,
    utmCampaign: str(fields.utmCampaign) ?? null,
    utmContent: str(fields.utmContent) ?? null,
    utmTerm: str(fields.utmTerm) ?? null,
    referrer: str(fields.referrer) ?? null,
    userAgent: userAgent ?? null,
    device: deviceFrom(userAgent),
    country: headers.get(COUNTRY_HEADER) ?? null,
  });

  if (!parsed.success) return deny(400, "invalid track request");
  return { ok: true, value: parsed.data };
}

// ---------------------------------------------------------------------------
// Order webhook
// ---------------------------------------------------------------------------

export const SHOPIFY_SIGNATURE_HEADER = "x-shopify-hmac-sha256";
export const STRIPE_SIGNATURE_HEADER = "stripe-signature";

export interface WebhookSecrets {
  shopify: string | undefined;
  stripe: string | undefined;
}

/**
 * Identify the provider, verify the signature, and normalize the order.
 *
 * The provider is decided by which signature header is present, not by a path
 * segment or a query parameter, because the header is the only part of the
 * request an attacker cannot choose freely and still pass verification.
 *
 * `rawBody` must be the exact bytes received. Verifying a re-serialized object
 * verifies something the sender never sent, because JSON.parse followed by
 * JSON.stringify does not round-trip.
 *
 * An unset secret disables its provider rather than skipping verification. A
 * webhook endpoint that accepts unsigned orders lets anyone write revenue into
 * the experiment that decides where traffic goes.
 */
export function interpretOrderWebhook(
  rawBody: string,
  headers: HeaderLookup,
  secrets: WebhookSecrets,
): Decision<NormalizedOrder> {
  const shopifySignature = headers.get(SHOPIFY_SIGNATURE_HEADER);
  const stripeSignature = headers.get(STRIPE_SIGNATURE_HEADER);

  if (shopifySignature !== null) {
    if (!verifyShopifySignature(rawBody, shopifySignature, secrets.shopify)) {
      return deny(401, "shopify signature did not verify");
    }

    const payload = parseJson(rawBody);
    if (payload === undefined) return deny(400, "body must be JSON");

    const order = normalizeShopifyOrder(payload);
    if (order === undefined) return deny(422, "not an order shape this route can read");
    return { ok: true, value: order };
  }

  if (stripeSignature !== null) {
    if (!verifyStripeSignature(rawBody, stripeSignature, secrets.stripe)) {
      return deny(401, "stripe signature did not verify");
    }

    const payload = parseJson(rawBody);
    if (payload === undefined) return deny(400, "body must be JSON");

    const order = normalizeStripeEvent(payload);
    if (order === undefined) {
      // Stripe sends every subscribed event type to the same endpoint. A
      // payment_intent or an invoice is not a failure, it is simply not
      // revenue this system counts -- and a 2xx stops Stripe retrying it
      // forever, which a 4xx would not.
      return deny(202, "event ignored");
    }
    return { ok: true, value: order };
  }

  return deny(400, "no recognised provider signature");
}

function parseJson(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
