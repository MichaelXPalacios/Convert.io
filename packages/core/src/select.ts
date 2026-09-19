/**
 * The hot path, composed.
 *
 * One request in, one arm and a set of cookies out. This is deliberately a
 * plain function over Web `Request` headers rather than anything Next-shaped:
 * an App Router route handler is already `(Request) => Response`, so the
 * framework layer on top of this is a re-export, and every branch below can be
 * tested without a server.
 *
 * The rule the whole module serves: a landing page always renders. A Redis
 * outage, a malformed mirror, a slug nobody has configured — none of those are
 * allowed to produce an error page for a visitor who clicked an ad.
 */

import type { MirrorArm } from "@convertio/contracts";
import { assignArmOrControl } from "./assign.js";
import type { Assignment } from "./assign.js";
import type { Rng } from "./bandit.js";
import { identityCookies, parseCookieHeader, resolveIdentity } from "./identity.js";
import type { Identity, IdFactory } from "./identity.js";
import type { MirrorStore } from "./mirror.js";

export interface SelectDeps {
  store: MirrorStore;
  /** Injected for tests. Defaults to crypto.randomUUID via resolveIdentity. */
  newId?: IdFactory;
  /** Injected for tests. Defaults to Math.random via assignArm. */
  rng?: Rng;
  /** Off only for local http development. */
  secureCookies?: boolean;
}

/** Just enough of a Request to read a header. Keeps tests free of globals. */
export interface HeaderBearing {
  headers: { get(name: string): string | null };
}

export interface AssignedSelection {
  kind: "assigned";
  slug: string;
  arm: MirrorArm;
  assignment: Assignment;
  identity: Identity;
  /** Set-Cookie values the response must carry. */
  setCookies: string[];
  /**
   * Whether this pageview is a new (visitor, session, arm) triple.
   *
   * Exposures are idempotent on that triple, so posting one anyway is safe —
   * this only exists to keep the collector from doing obviously redundant work
   * on a refresh.
   */
  shouldTrack: boolean;
}

/**
 * Why no arm was chosen.
 *
 * `not-under-test` is an ordinary answer: the slug has no mirror, so there is
 * nothing to allocate and the caller should serve its default page.
 * `unavailable` is a fault — the mirror exists but could not be read or parsed
 * — and the caller should serve the same default page *and* report it, because
 * silently serving the default forever is how a broken experiment hides.
 */
export type Selection =
  | AssignedSelection
  | { kind: "not-under-test"; slug: string }
  | { kind: "unavailable"; slug: string; error: Error };

/**
 * Choose the arm for a request.
 *
 * Never throws. Every failure is turned into a `Selection` the caller can
 * render, because the alternative on this path is a blank page.
 */
export async function selectForRequest(
  request: HeaderBearing,
  slug: string,
  deps: SelectDeps,
): Promise<Selection> {
  const { store, newId, rng, secureCookies = true } = deps;

  const cookies = parseCookieHeader(request.headers.get("cookie"));
  const identity = resolveIdentity(cookies, newId);

  let mirror;
  try {
    mirror = await store.read(slug);
  } catch (cause) {
    return {
      kind: "unavailable",
      slug,
      error: cause instanceof Error ? cause : new Error(String(cause)),
    };
  }

  if (mirror === undefined) return { kind: "not-under-test", slug };

  const assignment = assignArmOrControl(mirror, {
    rng,
    stickyArmKey: identity.assignmentKey,
  });

  // A mirror with no control and no eligible arm is a worker bug. There is
  // nothing to render, so the caller falls back exactly as it would for an
  // unreadable mirror.
  if (assignment === undefined) {
    return {
      kind: "unavailable",
      slug,
      error: new Error(`mirror for "${slug}" has no eligible arm and no control to fall back to`),
    };
  }

  return {
    kind: "assigned",
    slug,
    arm: assignment.arm,
    assignment,
    identity,
    setCookies: identityCookies(identity, assignment.arm.key, { secure: secureCookies }),
    shouldTrack: identity.isNewSession || identity.assignmentKey !== assignment.arm.key,
  };
}

/** Attach a selection's cookies to a response. */
export function applySelectionCookies(headers: Headers, selection: Selection): Headers {
  if (selection.kind !== "assigned") return headers;
  for (const cookie of selection.setCookies) headers.append("set-cookie", cookie);
  return headers;
}

/**
 * The body a variant page posts to /api/track.
 *
 * Built here rather than in the page so the field names come from one place;
 * TrackRequestSchema validates the same shape on the way in.
 */
export function trackRequestBody(
  selection: AssignedSelection,
  request: HeaderBearing,
): Record<string, string | null> {
  const url = request.headers.get("referer");
  return {
    slug: selection.slug,
    armKey: selection.arm.key,
    visitorId: selection.identity.visitorId,
    sessionId: selection.identity.sessionId,
    referrer: url,
    userAgent: request.headers.get("user-agent"),
    country: request.headers.get("x-vercel-ip-country"),
  };
}
