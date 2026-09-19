/**
 * POST /api/track — record that a visitor was shown an arm.
 *
 * Exposures are the denominator of every posterior, so this is the route that
 * decides whether the bandit is measuring anything at all.
 *
 * It makes no decisions of its own: `buildTrackRequest` in @convertio/core
 * reads the identity from the proxy's HttpOnly cookies, enriches from request
 * headers, and refuses anything the caller should not be naming. That lives
 * there rather than here because a Next route cannot be imported outside
 * Next's bundler, and a rule that stops a caller minting exposures for an arm
 * it never saw deserves a test rather than a curl command someone ran once.
 *
 * A failure here costs one data point. It must never cost the visitor their
 * page, so the beacon is fire-and-forget and nothing the renderer waits on
 * depends on this succeeding.
 */

import pg from "pg";
import { NextResponse } from "next/server";
import { buildTrackRequest, recordExposure } from "@convertio/core";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  const built = buildTrackRequest(body, request.headers);
  if (!built.ok) {
    // 204 carries no body, and means the proxy never allocated this request.
    if (built.status === 204) return new NextResponse(null, { status: 204 });
    return NextResponse.json({ error: built.error }, { status: built.status });
  }

  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === "") {
    console.error("[cv] DATABASE_URL is unset; cannot record exposures");
    return NextResponse.json({ error: "database is not configured" }, { status: 503 });
  }

  const client = new pg.Client({ connectionString });

  try {
    await client.connect();
    const result = await recordExposure(client, built.value);

    // No arm matched (slug, armKey). A stale page posting an arm that has
    // since been removed is a normal thing to receive, not a fault.
    if (result === undefined) {
      return NextResponse.json({ error: "no such arm" }, { status: 404 });
    }

    return NextResponse.json(result, { status: result.deduplicated ? 200 : 201 });
  } catch (error) {
    console.error("[cv] exposure not recorded:", error);
    return NextResponse.json({ error: "could not record exposure" }, { status: 500 });
  } finally {
    await client.end().catch(() => undefined);
  }
}
