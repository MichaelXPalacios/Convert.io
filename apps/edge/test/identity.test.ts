import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COOKIE_ASSIGNMENT,
  COOKIE_SESSION,
  COOKIE_VISITOR,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  VISITOR_COOKIE_MAX_AGE_SECONDS,
} from "@convertio/contracts";
import {
  identityCookies,
  parseCookieHeader,
  resolveIdentity,
  serializeCookie,
} from "../lib/identity.js";

/** A counter, so a test can assert exactly which ids were minted. */
function sequentialIds(prefix = "id"): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${n}`;
  };
}

describe("parseCookieHeader", () => {
  it("returns an empty map for a missing header", () => {
    assert.deepEqual(parseCookieHeader(null), {});
    assert.deepEqual(parseCookieHeader(undefined), {});
    assert.deepEqual(parseCookieHeader(""), {});
  });

  it("parses a normal header", () => {
    assert.deepEqual(parseCookieHeader("a=1; b=2"), { a: "1", b: "2" });
  });

  it("tolerates whitespace and missing spaces", () => {
    assert.deepEqual(parseCookieHeader("a=1;b=2;   c=3"), { a: "1", b: "2", c: "3" });
  });

  it("percent-decodes values", () => {
    assert.deepEqual(parseCookieHeader("a=hello%20world"), { a: "hello world" });
  });

  it("keeps a value that is not valid percent-encoding", () => {
    assert.deepEqual(parseCookieHeader("a=100%"), { a: "100%" });
  });

  it("skips malformed pairs rather than failing", () => {
    // A junk cookie from a third-party script must not take the page down.
    assert.deepEqual(parseCookieHeader("garbage; =novalue; a=1; =; b=2"), { a: "1", b: "2" });
  });

  it("keeps the first value when a name repeats", () => {
    assert.deepEqual(parseCookieHeader("a=first; a=second"), { a: "first" });
  });

  it("preserves an = inside a value", () => {
    assert.deepEqual(parseCookieHeader("a=b=c"), { a: "b=c" });
  });
});

describe("serializeCookie", () => {
  it("always sets HttpOnly, Path and SameSite", () => {
    const c = serializeCookie("n", "v", { maxAgeSeconds: 60 });
    assert.match(c, /^n=v;/);
    assert.ok(c.includes("HttpOnly"), c);
    assert.ok(c.includes("Path=/"), c);
    assert.ok(c.includes("SameSite=Lax"), c);
    assert.ok(c.includes("Max-Age=60"), c);
  });

  it("is Secure by default and opts out only when asked", () => {
    assert.ok(serializeCookie("n", "v", { maxAgeSeconds: 60 }).includes("Secure"));
    assert.ok(!serializeCookie("n", "v", { maxAgeSeconds: 60, secure: false }).includes("Secure"));
  });

  it("forces Secure for SameSite=None, which browsers require", () => {
    const c = serializeCookie("n", "v", { maxAgeSeconds: 60, secure: false, sameSite: "None" });
    assert.ok(c.includes("Secure"), c);
  });

  it("encodes the value", () => {
    assert.match(serializeCookie("n", "a b;c", { maxAgeSeconds: 1 }), /^n=a%20b%3Bc;/);
  });

  it("never emits a negative or fractional Max-Age", () => {
    assert.ok(serializeCookie("n", "v", { maxAgeSeconds: -5 }).includes("Max-Age=0"));
    assert.ok(serializeCookie("n", "v", { maxAgeSeconds: 1.9 }).includes("Max-Age=1"));
  });

  it("round-trips through the parser", () => {
    const value = "a b;c=d";
    const header = serializeCookie("n", value, { maxAgeSeconds: 60 }).split(";")[0] ?? "";
    assert.equal(parseCookieHeader(header)["n"], value);
  });
});

describe("resolveIdentity", () => {
  it("mints both ids for a first-time visitor", () => {
    const id = resolveIdentity({}, sequentialIds());
    assert.equal(id.visitorId, "id-1");
    assert.equal(id.sessionId, "id-2");
    assert.equal(id.isNewVisitor, true);
    assert.equal(id.isNewSession, true);
    assert.equal(id.assignmentKey, null);
  });

  it("keeps both ids for a returning visitor mid-session", () => {
    const id = resolveIdentity(
      { [COOKIE_VISITOR]: "v", [COOKIE_SESSION]: "s", [COOKIE_ASSIGNMENT]: "challenger" },
      () => {
        throw new Error("must not mint an id when both cookies are present");
      },
    );
    assert.equal(id.visitorId, "v");
    assert.equal(id.sessionId, "s");
    assert.equal(id.isNewVisitor, false);
    assert.equal(id.isNewSession, false);
    assert.equal(id.assignmentKey, "challenger");
  });

  it("keeps the visitor but mints a session when the session has expired", () => {
    // This is the case that makes long-window attribution work.
    const id = resolveIdentity({ [COOKIE_VISITOR]: "v" }, sequentialIds("new"));
    assert.equal(id.visitorId, "v");
    assert.equal(id.isNewVisitor, false);
    assert.equal(id.sessionId, "new-1");
    assert.equal(id.isNewSession, true);
  });

  it("treats an empty cookie as absent", () => {
    const id = resolveIdentity(
      { [COOKIE_VISITOR]: "", [COOKIE_SESSION]: "", [COOKIE_ASSIGNMENT]: "" },
      sequentialIds(),
    );
    assert.equal(id.isNewVisitor, true);
    assert.equal(id.isNewSession, true);
    assert.equal(id.assignmentKey, null);
  });

  it("rejects an oversized id rather than carrying it into an exposure", () => {
    // VisitorIdSchema caps ids at 128 characters. A longer cookie would fail
    // the contract at the write, so it is replaced here instead.
    const id = resolveIdentity({ [COOKIE_VISITOR]: "x".repeat(129) }, sequentialIds());
    assert.equal(id.visitorId, "id-1");
    assert.equal(id.isNewVisitor, true);
  });

  it("accepts an id of exactly the maximum length", () => {
    const max = "x".repeat(128);
    const id = resolveIdentity({ [COOKIE_VISITOR]: max }, sequentialIds());
    assert.equal(id.visitorId, max);
    assert.equal(id.isNewVisitor, false);
  });
});

describe("identityCookies", () => {
  const nameOf = (cookie: string) => cookie.slice(0, cookie.indexOf("="));

  it("sets visitor, session and assignment for a new visitor", () => {
    const identity = resolveIdentity({}, sequentialIds());
    const cookies = identityCookies(identity, "control");
    assert.deepEqual(cookies.map(nameOf), [COOKIE_VISITOR, COOKIE_SESSION, COOKIE_ASSIGNMENT]);
  });

  it("does not rewrite the visitor cookie for a returning visitor", () => {
    // Rewriting it on every pageview would silently extend the window.
    const identity = resolveIdentity(
      { [COOKIE_VISITOR]: "v", [COOKIE_SESSION]: "s" },
      sequentialIds(),
    );
    const cookies = identityCookies(identity, "control");
    assert.deepEqual(cookies.map(nameOf), [COOKIE_SESSION, COOKIE_ASSIGNMENT]);
  });

  it("uses the contract lifetimes", () => {
    const identity = resolveIdentity({}, sequentialIds());
    const cookies = identityCookies(identity, "control");
    const visitor = cookies.find((c) => nameOf(c) === COOKIE_VISITOR) ?? "";
    const session = cookies.find((c) => nameOf(c) === COOKIE_SESSION) ?? "";
    assert.ok(visitor.includes(`Max-Age=${VISITOR_COOKIE_MAX_AGE_SECONDS}`), visitor);
    assert.ok(session.includes(`Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`), session);
  });

  it("marks every identity cookie HttpOnly and Secure", () => {
    const identity = resolveIdentity({}, sequentialIds());
    for (const cookie of identityCookies(identity, "control")) {
      assert.ok(cookie.includes("HttpOnly"), cookie);
      assert.ok(cookie.includes("Secure"), cookie);
    }
  });

  it("can drop Secure for local http development", () => {
    const identity = resolveIdentity({}, sequentialIds());
    for (const cookie of identityCookies(identity, "control", { secure: false })) {
      assert.ok(!cookie.includes("Secure"), cookie);
      assert.ok(cookie.includes("HttpOnly"), cookie);
    }
  });

  it("writes the arm key it was given", () => {
    const identity = resolveIdentity({}, sequentialIds());
    const assignment =
      identityCookies(identity, "variant-a").find((c) => nameOf(c) === COOKIE_ASSIGNMENT) ?? "";
    assert.match(assignment, new RegExp(`^${COOKIE_ASSIGNMENT}=variant-a;`));
  });
});
