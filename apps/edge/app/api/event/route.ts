/**
 * POST /api/event — engagement.
 *
 * Diagnostic only. Nothing posted here reaches a posterior, which is why this
 * route is allowed to be as thin as it looks: there is no attribution to get
 * right and no money to lose.
 *
 * It takes exposureId from the body rather than from a cookie, unlike
 * /api/track. The exposure id is not a capability -- it names a row that
 * already exists and was already attributed -- and the client genuinely has to
 * tell us which exposure it is reporting against, because a visitor can hold
 * several across sessions. A forged one buys an attacker a junk row on a
 * diagnostic dimension.
 */

import pg from "pg";
import { NextResponse } from "next/server";
import { EventRequestSchema } from "@convertio/contracts";
import { recordEvent } from "@convertio/core";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  const parsed = EventRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid event request" }, { status: 400 });
  }

  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === "") {
    console.error("[cv] DATABASE_URL is unset; cannot record events");
    return NextResponse.json({ error: "database is not configured" }, { status: 503 });
  }

  const client = new pg.Client({ connectionString });

  try {
    await client.connect();
    const result = await recordEvent(client, parsed.data);

    if (result === undefined) {
      return NextResponse.json({ error: "no such exposure" }, { status: 404 });
    }

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    console.error("[cv] event not recorded:", error);
    return NextResponse.json({ error: "could not record event" }, { status: 500 });
  } finally {
    await client.end().catch(() => undefined);
  }
}
