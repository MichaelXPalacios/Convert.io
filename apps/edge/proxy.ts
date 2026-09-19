/**
 * Arm selection.
 *
 * This runs in the proxy rather than in the page for a hard reason: a Server
 * Component cannot set a cookie, and assignment is not assignment until the
 * visitor is carrying the cookie that makes it stick. The proxy is the only
 * place on this path that can read the request, choose, and write Set-Cookie on
 * the way out.
 *
 * `proxy.ts` is Next 16's name for what earlier versions called
 * `middleware.ts`; the old filename still builds but warns.
 *
 * The chosen arm is handed to the page as a request header rather than a
 * rewrite to an arm-specific route, so the URL a visitor sees and shares is the
 * one they asked for. Nothing about which variant they got is in the address
 * bar.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { mirrorStoreFromEnv, selectForRequest } from "@convertio/core";
import { ARM_HEADER, SELECTION_HEADER } from "./lib/headers";

/**
 * Everything except Next's own assets and the API. The API sets its own
 * cookies where it needs to, and running allocation for a static file would
 * spend a Redis read to decorate an image.
 */
export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};

/** The leading path segment, which is the experiment slug. */
function slugFrom(pathname: string): string | undefined {
  const [first] = pathname.replace(/^\/+/, "").split("/");
  return first === undefined || first === "" ? undefined : first;
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const slug = slugFrom(request.nextUrl.pathname);
  if (slug === undefined) return NextResponse.next();

  let store;
  try {
    store = mirrorStoreFromEnv(process.env);
  } catch (error) {
    // A missing Upstash variable is a deployment fault, not a visitor's
    // problem. Serve the page unallocated and make the reason loud.
    console.error("[cv] mirror store unavailable:", error);
    return NextResponse.next();
  }

  const selection = await selectForRequest(request, slug, {
    store,
    secureCookies: process.env.NODE_ENV === "production",
  });

  if (selection.kind === "unavailable") {
    // Deliberately noisy. Silently serving the control forever is how a broken
    // experiment hides, and the page still renders either way.
    console.error(`[cv] allocation unavailable for "${slug}":`, selection.error.message);
    return NextResponse.next();
  }

  if (selection.kind === "not-under-test") return NextResponse.next();

  const headers = new Headers(request.headers);
  headers.set(ARM_HEADER, selection.arm.key);
  headers.set(SELECTION_HEADER, selection.assignment.reason);

  const response = NextResponse.next({ request: { headers } });
  for (const cookie of selection.setCookies) {
    response.headers.append("set-cookie", cookie);
  }

  return response;
}
