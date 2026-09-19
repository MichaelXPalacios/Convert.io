/**
 * First-party visitor and session identity.
 *
 * These cookies are the root of attribution: an exposure is keyed on
 * (visitor, session, arm), and an order that cannot find a visitor id is
 * unattributable and teaches the bandit nothing. The names and lifetimes come
 * from @convertio/contracts so that the collector, the edge and the webhook
 * cannot disagree about them.
 *
 * Everything here is set server side and HttpOnly. The visitor id does have to
 * reach the checkout provider — see ORDER_VISITOR_ATTRIBUTE — but it gets there
 * by the server rendering it into the page, not by client JavaScript reading a
 * cookie, so there is no reason to expose it to script.
 */

import {
  COOKIE_ASSIGNMENT,
  COOKIE_SESSION,
  COOKIE_VISITOR,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  VISITOR_COOKIE_MAX_AGE_SECONDS,
} from "@convertio/contracts";

/** A source of opaque ids. Injected so tests can assert exact values. */
export type IdFactory = () => string;

const defaultIdFactory: IdFactory = () => crypto.randomUUID();

/**
 * Parse a Cookie request header into a map.
 *
 * Tolerant by design: a malformed pair is skipped rather than failing the
 * request, because a third-party script writing a junk cookie must not be able
 * to take the landing page down. A repeated name keeps the first value, which
 * is the one the browser considers most specific.
 */
export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;

  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;

    const name = part.slice(0, index).trim();
    if (name === "") continue;
    if (Object.prototype.hasOwnProperty.call(out, name)) continue;

    const raw = part.slice(index + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      // A value that is not valid percent-encoding is still a value.
      out[name] = raw;
    }
  }

  return out;
}

export interface SerializeCookieOptions {
  maxAgeSeconds: number;
  /**
   * Off only for local http development. Production must never set an identity
   * cookie without Secure, so the default is on and the caller opts out.
   */
  secure?: boolean;
  path?: string;
  sameSite?: "Lax" | "Strict" | "None";
}

/** Build a Set-Cookie value. HttpOnly is not optional and is always applied. */
export function serializeCookie(
  name: string,
  value: string,
  options: SerializeCookieOptions,
): string {
  const { maxAgeSeconds, secure = true, path = "/", sameSite = "Lax" } = options;

  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    `SameSite=${sameSite}`,
    "HttpOnly",
  ];

  // SameSite=None without Secure is rejected by every current browser, so it
  // would be a silently dropped cookie rather than a loosened one.
  if (secure || sameSite === "None") parts.push("Secure");

  return parts.join("; ");
}

export interface Identity {
  visitorId: string;
  sessionId: string;
  /** The arm key this visitor already holds, if any. */
  assignmentKey: string | null;
  isNewVisitor: boolean;
  isNewSession: boolean;
}

/**
 * Read identity from the request's cookies, minting whatever is missing.
 *
 * A returning visitor keeps their visitor id for the full window, which is what
 * lets an order days later still find the exposure that earned it. The session
 * id rolls on its own shorter clock.
 */
export function resolveIdentity(
  cookies: Record<string, string>,
  newId: IdFactory = defaultIdFactory,
): Identity {
  const existingVisitor = cookies[COOKIE_VISITOR];
  const existingSession = cookies[COOKIE_SESSION];
  const existingAssignment = cookies[COOKIE_ASSIGNMENT];

  // An empty or oversized value is treated as absent: VisitorIdSchema caps ids
  // at 128 characters, and a cookie that would fail the contract must not be
  // carried into an exposure write that then rejects it.
  const visitorOk =
    existingVisitor !== undefined && existingVisitor.length > 0 && existingVisitor.length <= 128;
  const sessionOk =
    existingSession !== undefined && existingSession.length > 0 && existingSession.length <= 128;

  const visitorId = visitorOk ? existingVisitor : newId();
  const sessionId = sessionOk ? existingSession : newId();

  return {
    visitorId,
    sessionId,
    assignmentKey:
      existingAssignment !== undefined && existingAssignment.length > 0 ? existingAssignment : null,
    isNewVisitor: !visitorOk,
    isNewSession: !sessionOk,
  };
}

export interface IdentityCookieOptions {
  secure?: boolean;
}

/**
 * The Set-Cookie values a response should carry for this identity.
 *
 * The session cookie is always rewritten, because its lifetime is a sliding
 * window: a visitor still reading is still in the same session. The visitor
 * cookie is only rewritten when newly minted, so an existing visitor's window
 * is not silently extended on every pageview.
 */
export function identityCookies(
  identity: Identity,
  armKey: string,
  options: IdentityCookieOptions = {},
): string[] {
  const { secure = true } = options;
  const cookies: string[] = [];

  if (identity.isNewVisitor) {
    cookies.push(
      serializeCookie(COOKIE_VISITOR, identity.visitorId, {
        maxAgeSeconds: VISITOR_COOKIE_MAX_AGE_SECONDS,
        secure,
      }),
    );
  }

  cookies.push(
    serializeCookie(COOKIE_SESSION, identity.sessionId, {
      maxAgeSeconds: SESSION_COOKIE_MAX_AGE_SECONDS,
      secure,
    }),
  );

  cookies.push(
    serializeCookie(COOKIE_ASSIGNMENT, armKey, {
      maxAgeSeconds: SESSION_COOKIE_MAX_AGE_SECONDS,
      secure,
    }),
  );

  return cookies;
}
