/**
 * POST /api/track — record that a visitor was shown an arm.
 *
 * Until this existed the system chose arms and forgot it had done so: the
 * proxy set a cookie, the page rendered, and nothing wrote the exposure the
 * recompute counts. Every posterior was therefore still its prior, and the
 * bandit was a uniform splitter wearing a bandit's clothes.
 *
 * WHY THE BODY DOES NOT CARRY THE IDENTITY
 *
 * TrackRequest names visitorId, sessionId and armKey, and this route refuses
 * to take any of the three from the caller. They are read from the cookies the
 * proxy set instead, and the body supplies only page context (referrer, utm).
 *
 * The reason is that they are the idempotency key and the attribution key at
 * once. A caller that can name its own visitorId can mint exposures for an arm
 * it was never shown, and the only evidence of it would be a posterior that
 * quietly stops matching reality. The cookies are HttpOnly, so the page's own
 * script cannot read them to send them anyway -- a body-supplied identity
 * would have had to come from somewhere else, and there is nowhere honest for
 * it to come from.
 *
 * A failure here costs one data point. It must never cost the visitor their
 * page, so the beacon is fire-and-forget and this route says so in its status
 * codes rather than through anything the renderer waits on.
 */

import pg from "pg";
import { NextResponse } from "next/server";
import {
  COOKIE_ASSIGNMENT,
  COOKIE_SESSION,
  COOKIE_VISITOR,
  TrackRequestSchema,
} from "@convertio/contracts";
import { parseCookieHeader, recordExposure } from "@convertio/core";

export const dynamic = "force-dynamic";

/** Vercel resolves the visitor's country for us; locally there is none. */
const COUNTRY_HEADER = "x-vercel-ip-country";

/**
 * Device from the user agent.
 *
 * Deliberately crude. This is a diagnostic dimension -- nothing downstream
 * allocates on it -- and a real device library is a dependency, a bundle and a
 * maintenance surface bought for a field nobody makes a decision with. The
 * order matters: every tablet UA also says mobile.
 */
function deviceFrom(userAgent: string | null): "mobile" | "tablet" | "desktop" | "bot" | null {
  if (userAgent === null || userAgent === "") return null;
  const ua = userAgent.toLowerCase();
  if (/bot|crawler|spider|crawling|headless|lighthouse|preview/.test(ua)) return "bot";
  if (/ipad|tablet|playbook|silk/.test(ua)) return "tablet";
  if (/mobi|android|iphone|ipod/.test(ua)) return "mobile";
  return "desktop";
}

/** A pooled client per invocation. The pooled URL is the one deployed. */
function connectionString(): string | undefined {
  const value = process.env.DATABASE_URL;
  return value === undefined || value === "" ? undefined : value;
}

interface Body {
  slug?: unknown;
  referrer?: unknown;
  utmSource?: unknown;
  utmMedium?: unknown;
  utmCampaign?: unknown;
  utmContent?: unknown;
  utmTerm?: unknown;
}

/** Undefined for anything that is not a non-empty string, so zod sees one shape. */
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

export async function POST(request: Request): Promise<NextResponse> {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  const cookies = parseCookieHeader(request.headers.get("cookie"));
  const identity = {
    visitorId: cookies[COOKIE_VISITOR],
    sessionId: cookies[COOKIE_SESSION],
    armKey: cookies[COOKIE_ASSIGNMENT],
  };

  // No cookies means the proxy never allocated this request: a direct call, a
  // bot that does not keep cookies, or a page served through the unallocated
  // fallback. There is no exposure to record and nothing went wrong.
  if (
    identity.visitorId === undefined ||
    identity.sessionId === undefined ||
    identity.armKey === undefined
  ) {
    return new NextResponse(null, { status: 204 });
  }

  const userAgent = request.headers.get("user-agent");

  const parsed = TrackRequestSchema.safeParse({
    slug: str(body.slug),
    armKey: identity.armKey,
    visitorId: identity.visitorId,
    sessionId: identity.sessionId,
    utmSource: str(body.utmSource) ?? null,
    utmMedium: str(body.utmMedium) ?? null,
    utmCampaign: str(body.utmCampaign) ?? null,
    utmContent: str(body.utmContent) ?? null,
    utmTerm: str(body.utmTerm) ?? null,
    referrer: str(body.referrer) ?? null,
    userAgent: userAgent ?? null,
    device: deviceFrom(userAgent),
    country: request.headers.get(COUNTRY_HEADER) ?? null,
  });

  if (!parsed.success) {
    return NextResponse.json({ error: "invalid track request" }, { status: 400 });
  }

  const url = connectionString();
  if (url === undefined) {
    console.error("[cv] DATABASE_URL is unset; cannot record exposures");
    return NextResponse.json({ error: "database is not configured" }, { status: 503 });
  }

  const client = new pg.Client({ connectionString: url });

  try {
    await client.connect();
    const result = await recordExposure(client, parsed.data);

    // No arm matched (slug, armKey). A stale page posting an arm that has since
    // been removed is a normal thing to receive, not a fault to alert on.
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
