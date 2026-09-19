/**
 * Order webhooks: signature verification and normalization.
 *
 * Two providers send two shapes over two signing schemes, and everything
 * downstream of this module sees one NormalizedOrder. The split matters
 * because attribution and money handling should not have to know which payment
 * processor a customer happens to use.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: the signature is verified against the
 * RAW body, before the body is parsed. Not after, and never against a
 * re-serialized object. JSON.parse followed by JSON.stringify does not
 * round-trip -- key order, unicode escapes and number formatting all drift --
 * so a signature checked against re-serialized bytes verifies something the
 * sender never sent. Routes must read the raw text and hand those exact bytes
 * here.
 *
 * An unverifiable signature is a rejection, never a warning. An unset secret
 * disables its provider rather than trusting it, because a webhook endpoint
 * that accepts unsigned orders lets anyone write revenue into the experiment
 * that decides where traffic goes.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ORDER_VISITOR_ATTRIBUTE,
  ShopifyOrderSchema,
  StripeEventSchema,
} from "@convertio/contracts";
import type { NormalizedOrder } from "@convertio/contracts";

/** Every signature comparison goes through here, so none of them leak timing. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // Unequal lengths cannot go through timingSafeEqual, and the early return
  // leaks only the length, which the signature format already fixes.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// ---------------------------------------------------------------------------
// Shopify
// ---------------------------------------------------------------------------

/** Shopify signs the raw body with HMAC-SHA256 and sends it base64. */
export function verifyShopifySignature(
  rawBody: string,
  header: string | null,
  secret: string | undefined,
): boolean {
  if (secret === undefined || secret === "") return false;
  if (header === null || header === "") return false;

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  return constantTimeEquals(header, expected);
}

/**
 * Shopify sends money as a decimal string in the shop currency: "129.95".
 *
 * Converted through string arithmetic rather than Number, because the posterior
 * is computed from sums of this column and floating point loses cents at scale.
 * 129.95 * 100 in IEEE 754 is 12994.999999999998, which truncates to 12994 -- a
 * cent lost on every order, silently, forever.
 */
export function decimalStringToCents(value: string): number | undefined {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (match === null) return undefined;

  const [, sign, whole, fraction = ""] = match;
  if (sign === "-") return undefined;
  if (whole === undefined) return undefined;

  const cents = (fraction + "00").slice(0, 2);
  const total = Number(whole) * 100 + Number(cents);
  return Number.isSafeInteger(total) ? total : undefined;
}

/** The visitor id Shopify carried through checkout, if the storefront set it. */
function shopifyVisitorId(
  attributes: ReadonlyArray<{ name: string; value: string }>,
): string | null {
  for (const attribute of attributes) {
    if (attribute.name === ORDER_VISITOR_ATTRIBUTE && attribute.value !== "") {
      return attribute.value;
    }
  }
  return null;
}

export function normalizeShopifyOrder(payload: unknown): NormalizedOrder | undefined {
  const parsed = ShopifyOrderSchema.safeParse(payload);
  if (!parsed.success) return undefined;

  const order = parsed.data;
  const valueCents = decimalStringToCents(order.total_price);
  if (valueCents === undefined) return undefined;

  const occurredAt = new Date(order.created_at);
  if (Number.isNaN(occurredAt.getTime())) return undefined;

  return {
    provider: "shopify",
    externalOrderId: String(order.id),
    valueCents,
    currency: order.currency.toUpperCase(),
    occurredAt,
    visitorId: shopifyVisitorId(order.note_attributes),
    email: order.email ?? null,
  };
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

/**
 * The Stripe-Signature header, shaped t=<unix>,v1=<hex>,v1=<hex>.
 *
 * The signed payload is the timestamp, a dot, and the raw body. There can
 * legitimately be several v1 values during a secret rotation, and any one
 * matching is a pass.
 */
export function parseStripeSignatureHeader(
  header: string,
): { timestamp: string; signatures: string[] } | undefined {
  let timestamp: string | undefined;
  const signatures: string[] = [];

  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") timestamp = value;
    else if (key === "v1") signatures.push(value);
  }

  if (timestamp === undefined || timestamp === "" || signatures.length === 0) return undefined;
  return { timestamp, signatures };
}

/**
 * Default freshness tolerance, in seconds.
 *
 * A signature with no freshness check is replayable forever: anyone who
 * captures one valid webhook can resend it indefinitely. Conversions are
 * idempotent on (provider, external_order_id), so a replay is mostly harmless
 * -- but "mostly" is not a property worth relying on when the check costs one
 * comparison.
 */
export const STRIPE_TOLERANCE_SECONDS = 300;

export function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string | undefined,
  options: { toleranceSeconds?: number; now?: () => Date } = {},
): boolean {
  if (secret === undefined || secret === "") return false;
  if (header === null || header === "") return false;

  const parsed = parseStripeSignatureHeader(header);
  if (parsed === undefined) return false;

  const timestamp = Number(parsed.timestamp);
  if (!Number.isFinite(timestamp)) return false;

  const tolerance = options.toleranceSeconds ?? STRIPE_TOLERANCE_SECONDS;
  const nowSeconds = (options.now?.() ?? new Date()).getTime() / 1000;
  if (Math.abs(nowSeconds - timestamp) > tolerance) return false;

  const signedPayload = parsed.timestamp + "." + rawBody;
  const expected = createHmac("sha256", secret).update(signedPayload, "utf8").digest("hex");

  return parsed.signatures.some((candidate) => constantTimeEquals(candidate, expected));
}

/** Stripe amounts are already in the currency minor unit. */
export function normalizeStripeEvent(payload: unknown): NormalizedOrder | undefined {
  const parsed = StripeEventSchema.safeParse(payload);
  if (!parsed.success) return undefined;

  const event = parsed.data;

  // Only a completed checkout is an order. Stripe sends dozens of other event
  // types to the same endpoint and none of them are revenue.
  if (event.type !== "checkout.session.completed") return undefined;

  const session = event.data.object;
  const valueCents = session.amount_total;
  if (valueCents === null || valueCents === undefined || valueCents < 0) return undefined;
  if (!Number.isSafeInteger(valueCents)) return undefined;

  const occurredAt =
    session.created === null || session.created === undefined
      ? new Date()
      : new Date(session.created * 1000);
  if (Number.isNaN(occurredAt.getTime())) return undefined;

  // client_reference_id is the documented place for a caller's own id; the
  // metadata key is the fallback for integrations that already use it.
  const referenced =
    session.client_reference_id !== null && session.client_reference_id !== undefined
      ? session.client_reference_id
      : (session.metadata?.[ORDER_VISITOR_ATTRIBUTE] ?? null);

  return {
    provider: "stripe",
    externalOrderId: session.id,
    valueCents,
    currency: (session.currency ?? "usd").toUpperCase(),
    occurredAt,
    visitorId: referenced === "" ? null : referenced,
    email: session.customer_email ?? null,
  };
}
