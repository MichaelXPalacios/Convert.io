/**
 * POST /api/webhook/order — an order arrives.
 *
 * One route for both providers, as the contract specifies. Which one sent it
 * is decided by which signature header is present, not by a path segment or a
 * query parameter, because the header is the only part of the request an
 * attacker cannot choose freely.
 *
 * This is where revenue enters the system, which makes it the one route where
 * being wrong is expensive in both directions. Accepting a forged order lets
 * anyone move traffic to an arm of their choosing by inventing sales for it.
 * Rejecting a real one loses the reward signal for a conversion that actually
 * happened, and nothing downstream will ever notice the gap.
 *
 * ORDER OF OPERATIONS, and every step is load-bearing:
 *
 *   1. read the RAW body as text
 *   2. verify the signature against those exact bytes
 *   3. only then parse
 *   4. normalize to a NormalizedOrder
 *   5. attribute -- last exposure for the visitor inside the window
 *   6. record, idempotent on (provider, external order id)
 *
 * Step 1 before step 3 is not a style preference. Parsing and re-serializing
 * does not round-trip, so a signature verified against re-serialized bytes
 * verifies something the sender never sent.
 */

import pg from "pg";
import { NextResponse } from "next/server";
import {
  attributeOrder,
  normalizeShopifyOrder,
  normalizeStripeEvent,
  recordConversion,
  verifyShopifySignature,
  verifyStripeSignature,
} from "@convertio/core";
import type { NormalizedOrder } from "@convertio/contracts";

export const dynamic = "force-dynamic";

const SHOPIFY_HEADER = "x-shopify-hmac-sha256";
const STRIPE_HEADER = "stripe-signature";

type Outcome = { ok: true; order: NormalizedOrder } | { ok: false; status: number; error: string };

/**
 * Identify the provider, verify, and normalize.
 *
 * An unset secret means the provider is disabled, and a disabled provider
 * rejects rather than trusts. That asymmetry is deliberate: a misconfigured
 * deployment that silently accepted unsigned orders would look exactly like a
 * working one until someone noticed the revenue was fictional.
 */
function interpret(rawBody: string, headers: Headers): Outcome {
  const shopifySignature = headers.get(SHOPIFY_HEADER);
  const stripeSignature = headers.get(STRIPE_HEADER);

  if (shopifySignature !== null) {
    if (!verifyShopifySignature(rawBody, shopifySignature, process.env.SHOPIFY_WEBHOOK_SECRET)) {
      return { ok: false, status: 401, error: "shopify signature did not verify" };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return { ok: false, status: 400, error: "body must be JSON" };
    }

    const order = normalizeShopifyOrder(payload);
    if (order === undefined) {
      return { ok: false, status: 422, error: "not an order shape this route can read" };
    }
    return { ok: true, order };
  }

  if (stripeSignature !== null) {
    if (!verifyStripeSignature(rawBody, stripeSignature, process.env.STRIPE_WEBHOOK_SECRET)) {
      return { ok: false, status: 401, error: "stripe signature did not verify" };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return { ok: false, status: 400, error: "body must be JSON" };
    }

    const order = normalizeStripeEvent(payload);
    if (order === undefined) {
      // Stripe sends every subscribed event type here. A payment_intent or an
      // invoice is not a failure -- it is simply not revenue this system
      // counts, and answering 2xx stops Stripe retrying it forever.
      return { ok: false, status: 202, error: "event ignored" };
    }
    return { ok: true, order };
  }

  return { ok: false, status: 400, error: "no recognised provider signature" };
}

export async function POST(request: Request): Promise<NextResponse> {
  // The raw bytes, before anything parses them.
  const rawBody = await request.text();

  const interpreted = interpret(rawBody, request.headers);
  if (!interpreted.ok) {
    if (interpreted.status === 401) {
      console.error("[cv] rejected a webhook whose signature did not verify");
    }
    return NextResponse.json({ error: interpreted.error }, { status: interpreted.status });
  }

  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === "") {
    console.error("[cv] DATABASE_URL is unset; cannot record conversions");
    // 503 rather than 500 so the provider retries: this order is real and the
    // fault is ours.
    return NextResponse.json({ error: "database is not configured" }, { status: 503 });
  }

  const client = new pg.Client({ connectionString });

  try {
    await client.connect();

    const attribution = await attributeOrder(client, interpreted.order);
    const result = await recordConversion(client, interpreted.order, attribution);

    if (!result.attributed) {
      // Visible, not silent. An unattributed order is revenue the experiment
      // did not explain, and a rising rate usually means checkout stopped
      // carrying the visitor id rather than that visitors stopped being
      // exposed.
      console.warn(
        `[cv] unattributed ${interpreted.order.provider} order ` +
          `${interpreted.order.externalOrderId}: ${result.reason}`,
      );
    }

    return NextResponse.json(result, { status: result.deduplicated ? 200 : 201 });
  } catch (error) {
    console.error("[cv] conversion not recorded:", error);
    // The order is real and we failed to store it. 500 asks the provider to
    // retry, and the retry is safe because the write is idempotent.
    return NextResponse.json({ error: "could not record conversion" }, { status: 500 });
  } finally {
    await client.end().catch(() => undefined);
  }
}
