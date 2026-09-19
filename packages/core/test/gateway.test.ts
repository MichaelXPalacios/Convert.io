import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  authorizeCron,
  buildTrackRequest,
  deviceFrom,
  interpretOrderWebhook,
} from "../src/gateway.js";
import type { HeaderLookup } from "../src/gateway.js";

/** Headers, as a plain object. The web Headers satisfies the same shape. */
function headers(map: Record<string, string>): HeaderLookup {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

const SECRET = "a-cron-secret-of-adequate-length";

describe("authorizeCron", () => {
  it("admits the right bearer token", () => {
    const result = authorizeCron(`Bearer ${SECRET}`, SECRET);
    assert.equal(result.ok, true);
  });

  it("refuses to run when the secret is unset, rather than running open", () => {
    // The failure that matters: a deployment that forgot to configure this
    // must not accept everyone. 503 says "not configured", not "denied".
    for (const unset of [undefined, ""]) {
      const result = authorizeCron(`Bearer anything`, unset);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.status, 503);
    }
  });

  it("rejects a wrong, empty or missing token", () => {
    for (const header of [null, "", "Bearer ", "Bearer wrong", SECRET]) {
      const result = authorizeCron(header, SECRET);
      assert.equal(result.ok, false, `header ${JSON.stringify(header)} must not be admitted`);
      assert.equal(result.ok === false && result.status, 401);
    }
  });

  it("does not admit a token that merely starts with the secret", () => {
    assert.equal(authorizeCron(`Bearer ${SECRET}extra`, SECRET).ok, false);
    assert.equal(authorizeCron(`Bearer ${SECRET.slice(0, -1)}`, SECRET).ok, false);
  });

  it("survives a length mismatch instead of throwing", () => {
    // timingSafeEqual throws on unequal lengths; the digest comparison is what
    // stops that becoming a 500 and a length oracle.
    assert.doesNotThrow(() => authorizeCron("Bearer x", SECRET));
  });
});

describe("buildTrackRequest", () => {
  const cookie = "cv_vid=visitor-1; cv_sid=session-1; cv_arm=variant-a";
  const ok = { cookie, "user-agent": "Mozilla/5.0 (Macintosh)" };

  it("takes identity from cookies", () => {
    const result = buildTrackRequest({ slug: "demo-landing" }, headers(ok));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.visitorId, "visitor-1");
    assert.equal(result.value.sessionId, "session-1");
    assert.equal(result.value.armKey, "variant-a");
  });

  it("IGNORES identity supplied in the body", () => {
    // The rule this route exists to enforce. A caller that could name its own
    // visitorId could mint exposures for an arm it was never shown.
    const result = buildTrackRequest(
      {
        slug: "demo-landing",
        visitorId: "attacker",
        sessionId: "attacker",
        armKey: "control",
      },
      headers(ok),
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.visitorId, "visitor-1");
    assert.equal(result.value.sessionId, "session-1");
    assert.equal(result.value.armKey, "variant-a", "the arm must come from the cookie");
  });

  it("IGNORES country supplied in the body, taking it from the edge header", () => {
    // A browser cannot know its country. Forged geo poisons segmentation in a
    // way nobody notices for months.
    const result = buildTrackRequest(
      { slug: "demo-landing", country: "ZZ" },
      headers({ ...ok, "x-vercel-ip-country": "GB" }),
    );
    assert.equal(result.ok === true && result.value.country, "GB");
  });

  it("IGNORES a user agent supplied in the body", () => {
    const result = buildTrackRequest(
      { slug: "demo-landing", userAgent: "not-what-was-sent", device: "bot" },
      headers(ok),
    );
    assert.equal(result.ok === true && result.value.userAgent, "Mozilla/5.0 (Macintosh)");
    assert.equal(result.ok === true && result.value.device, "desktop");
  });

  it("accepts the campaign fields a caller legitimately has", () => {
    const result = buildTrackRequest(
      { slug: "demo-landing", utmSource: "newsletter", referrer: "https://example.com/" },
      headers(ok),
    );
    assert.equal(result.ok === true && result.value.utmSource, "newsletter");
    assert.equal(result.ok === true && result.value.referrer, "https://example.com/");
  });

  it("answers 204 when the proxy never allocated the request", () => {
    // Not an error: a direct call, a cookie-less client, or the unallocated
    // fallback. There is simply no exposure to record.
    for (const partial of [
      "",
      "cv_vid=visitor-1",
      "cv_vid=visitor-1; cv_sid=session-1",
      "cv_sid=session-1; cv_arm=variant-a",
    ]) {
      const result = buildTrackRequest({ slug: "demo-landing" }, headers({ cookie: partial }));
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.status, 204);
    }
  });

  it("rejects a missing or malformed slug", () => {
    for (const body of [{}, { slug: "" }, { slug: "Not A Slug" }, null]) {
      const result = buildTrackRequest(body, headers(ok));
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.status, 400);
    }
  });
});

describe("deviceFrom", () => {
  it("puts a tablet before mobile, since every tablet also says mobile", () => {
    assert.equal(deviceFrom("Mozilla/5.0 (iPad; CPU OS 17_0) Mobile/15E148"), "tablet");
  });

  it("classifies the obvious cases", () => {
    assert.equal(deviceFrom("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)"), "mobile");
    assert.equal(deviceFrom("Mozilla/5.0 (Macintosh; Intel Mac OS X)"), "desktop");
    assert.equal(deviceFrom("Googlebot/2.1"), "bot");
    assert.equal(deviceFrom("HeadlessChrome/120"), "bot");
    assert.equal(deviceFrom(null), null);
    assert.equal(deviceFrom(""), null);
  });
});

describe("interpretOrderWebhook", () => {
  const shopSecret = "shop-secret";
  const stripeSecret = "stripe-secret";
  const secrets = { shopify: shopSecret, stripe: stripeSecret };

  const shopBody = JSON.stringify({
    id: 4242,
    total_price: "129.95",
    currency: "USD",
    created_at: "2026-09-19T10:00:00Z",
    note_attributes: [{ name: "cv_vid", value: "visitor-1" }],
  });

  const shopSig = (body: string, secret = shopSecret) =>
    createHmac("sha256", secret).update(body, "utf8").digest("base64");

  const stripeBody = (created: number) =>
    JSON.stringify({
      id: "evt_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_1",
          amount_total: 24999,
          currency: "usd",
          created,
          client_reference_id: "visitor-1",
        },
      },
    });

  const stripeSig = (body: string, ts: number, secret = stripeSecret) =>
    `t=${ts},v1=${createHmac("sha256", secret).update(`${ts}.${body}`, "utf8").digest("hex")}`;

  it("accepts a correctly signed shopify order", () => {
    const result = interpretOrderWebhook(
      shopBody,
      headers({ "x-shopify-hmac-sha256": shopSig(shopBody) }),
      secrets,
    );
    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.value.valueCents, 12995);
    assert.equal(result.ok === true && result.value.provider, "shopify");
  });

  it("rejects an unsigned request", () => {
    const result = interpretOrderWebhook(shopBody, headers({}), secrets);
    assert.equal(result.ok === false && result.status, 400);
  });

  it("rejects a tampered body under a valid old signature", () => {
    const signature = shopSig(shopBody);
    const tampered = shopBody.replace("129.95", "12995.00");
    const result = interpretOrderWebhook(
      tampered,
      headers({ "x-shopify-hmac-sha256": signature }),
      secrets,
    );
    assert.equal(result.ok === false && result.status, 401);
  });

  it("treats an unset secret as a disabled provider, never as skip-verification", () => {
    // The failure mode worth a test of its own: a deployment missing the
    // secret must reject, not accept. It would otherwise look identical to a
    // working one until someone noticed the revenue was fictional.
    const result = interpretOrderWebhook(
      shopBody,
      headers({ "x-shopify-hmac-sha256": shopSig(shopBody) }),
      { shopify: undefined, stripe: undefined },
    );
    assert.equal(result.ok === false && result.status, 401);
  });

  it("rejects a signature made with a different secret", () => {
    const result = interpretOrderWebhook(
      shopBody,
      headers({ "x-shopify-hmac-sha256": shopSig(shopBody, "someone-elses-secret") }),
      secrets,
    );
    assert.equal(result.ok === false && result.status, 401);
  });

  it("accepts a fresh stripe checkout and rejects a stale one", () => {
    const now = Math.floor(Date.now() / 1000);
    const fresh = stripeBody(now);
    assert.equal(
      interpretOrderWebhook(fresh, headers({ "stripe-signature": stripeSig(fresh, now) }), secrets)
        .ok,
      true,
    );

    const old = now - 3600;
    const stale = stripeBody(old);
    const result = interpretOrderWebhook(
      stale,
      headers({ "stripe-signature": stripeSig(stale, old) }),
      secrets,
    );
    assert.equal(result.ok === false && result.status, 401, "a replay must not be accepted");
  });

  it("answers 202 to a signed event that is not an order", () => {
    // Not a failure. A 4xx would make Stripe retry it forever.
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      id: "evt_2",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_1" } },
    });
    const result = interpretOrderWebhook(
      body,
      headers({ "stripe-signature": stripeSig(body, now) }),
      secrets,
    );
    assert.equal(result.ok === false && result.status, 202);
  });

  it("answers 422 to a signed body that is not an order shape", () => {
    const body = JSON.stringify({ hello: "world" });
    const result = interpretOrderWebhook(
      body,
      headers({ "x-shopify-hmac-sha256": shopSig(body) }),
      secrets,
    );
    assert.equal(result.ok === false && result.status, 422);
  });

  it("answers 400 to signed bytes that are not JSON at all", () => {
    const body = "not json";
    const result = interpretOrderWebhook(
      body,
      headers({ "x-shopify-hmac-sha256": shopSig(body) }),
      secrets,
    );
    assert.equal(result.ok === false && result.status, 400);
  });

  it("verifies before parsing, so a bad signature never reaches the parser", () => {
    // Order of operations, pinned: invalid JSON with an invalid signature must
    // come back 401, not 400. A 400 would prove the parser ran first.
    const result = interpretOrderWebhook(
      "not json",
      headers({ "x-shopify-hmac-sha256": "bm90LWEtc2lnbmF0dXJl" }),
      secrets,
    );
    assert.equal(result.ok === false && result.status, 401);
  });
});
