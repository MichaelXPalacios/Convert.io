/**
 * POST /api/webhook/order — an order arrives.
 *
 * One route for both providers, as the contract specifies. This handler makes
 * no decisions: `interpretOrderWebhook` in @convertio/core identifies the
 * provider, verifies the signature and normalizes the payload, and everything
 * here does is read the request, call it, and map the result.
 *
 * The decisions live there because a Next route module cannot be imported
 * outside Next's bundler, so anything inside this file is unreachable from a
 * unit test. These particular rules decide whether forged revenue can steer
 * the bandit, so they are tested rather than trusted.
 *
 * The one thing this file must get right on its own: `request.text()` before
 * anything parses. The signature is verified against those exact bytes, and a
 * signature checked against a re-serialized object verifies something the
 * sender never sent.
 */

import pg from "pg";
import { NextResponse } from "next/server";
import { attributeOrder, interpretOrderWebhook, recordConversion } from "@convertio/core";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  // The raw bytes, before anything parses them.
  const rawBody = await request.text();

  const interpreted = interpretOrderWebhook(rawBody, request.headers, {
    shopify: process.env.SHOPIFY_WEBHOOK_SECRET,
    stripe: process.env.STRIPE_WEBHOOK_SECRET,
  });

  if (!interpreted.ok) {
    if (interpreted.status === 401) {
      console.error("[cv] rejected a webhook whose signature did not verify");
    }
    return NextResponse.json({ error: interpreted.error }, { status: interpreted.status });
  }

  const order = interpreted.value;

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

    const attribution = await attributeOrder(client, order);
    const result = await recordConversion(client, order, attribution);

    if (!result.attributed) {
      // Visible, not silent. An unattributed order is revenue the experiment
      // did not explain, and a rising rate usually means checkout stopped
      // carrying the visitor id rather than that visitors stopped being
      // exposed.
      console.warn(
        `[cv] unattributed ${order.provider} order ${order.externalOrderId}: ${result.reason}`,
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
