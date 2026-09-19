import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  decimalStringToCents,
  normalizeShopifyOrder,
  normalizeStripeEvent,
  parseStripeSignatureHeader,
  verifyShopifySignature,
  verifyStripeSignature,
} from "../src/webhook.js";

const SECRET = "shhh";

const shopifySign = (body: string, secret = SECRET) =>
  createHmac("sha256", secret).update(body, "utf8").digest("base64");

const stripeSign = (body: string, timestamp: number, secret = SECRET) => {
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
};

describe("verifyShopifySignature", () => {
  const body = '{"id":1,"total_price":"10.00"}';

  it("accepts a signature over exactly these bytes", () => {
    assert.equal(verifyShopifySignature(body, shopifySign(body), SECRET), true);
  });

  it("rejects the same payload re-serialized", () => {
    // The whole reason routes must read the raw body. A compact payload can
    // round-trip byte for byte, so this uses a pretty-printed one -- which is
    // exactly what a provider that formats its JSON sends. Parse it, stringify
    // it, and the signature no longer describes the bytes in hand.
    const pretty = '{\n  "id": 1,\n  "total_price": "10.00"\n}';
    const signature = shopifySign(pretty);

    assert.equal(verifyShopifySignature(pretty, signature, SECRET), true);

    const reserialized = JSON.stringify(JSON.parse(pretty));
    assert.notEqual(reserialized, pretty);
    assert.equal(verifyShopifySignature(reserialized, signature, SECRET), false);
  });

  it("rejects a tampered body", () => {
    const signature = shopifySign(body);
    const tampered = body.replace("10.00", "1000.00");
    assert.equal(verifyShopifySignature(tampered, signature, SECRET), false);
  });

  it("rejects the wrong secret", () => {
    assert.equal(verifyShopifySignature(body, shopifySign(body, "other"), SECRET), false);
  });

  it("treats an unset secret as a disabled provider, not an open door", () => {
    assert.equal(verifyShopifySignature(body, shopifySign(body), undefined), false);
    assert.equal(verifyShopifySignature(body, shopifySign(body), ""), false);
  });

  it("rejects a missing header", () => {
    assert.equal(verifyShopifySignature(body, null, SECRET), false);
    assert.equal(verifyShopifySignature(body, "", SECRET), false);
  });
});

describe("verifyStripeSignature", () => {
  const body = '{"id":"evt_1","type":"checkout.session.completed"}';
  const now = () => new Date(1_700_000_000_000);
  const seconds = 1_700_000_000;

  it("accepts a fresh signature", () => {
    const header = stripeSign(body, seconds);
    assert.equal(verifyStripeSignature(body, header, SECRET, { now }), true);
  });

  it("accepts when any v1 matches, for secret rotation", () => {
    const good = stripeSign(body, seconds).split("v1=")[1];
    const header = `t=${seconds},v1=deadbeef,v1=${good}`;
    assert.equal(verifyStripeSignature(body, header, SECRET, { now }), true);
  });

  it("rejects a replay outside the tolerance", () => {
    const header = stripeSign(body, seconds - 600);
    assert.equal(verifyStripeSignature(body, header, SECRET, { now }), false);
  });

  it("accepts inside the tolerance", () => {
    const header = stripeSign(body, seconds - 60);
    assert.equal(verifyStripeSignature(body, header, SECRET, { now }), true);
  });

  it("rejects a signature over a different timestamp than it claims", () => {
    // The timestamp is part of the signed payload, so moving it invalidates.
    const signature = stripeSign(body, seconds).split("v1=")[1];
    const header = `t=${seconds - 30},v1=${signature}`;
    assert.equal(verifyStripeSignature(body, header, SECRET, { now }), false);
  });

  it("treats an unset secret as a disabled provider", () => {
    assert.equal(verifyStripeSignature(body, stripeSign(body, seconds), undefined, { now }), false);
  });

  it("rejects a malformed header", () => {
    assert.equal(verifyStripeSignature(body, "nonsense", SECRET, { now }), false);
    assert.equal(verifyStripeSignature(body, `t=abc,v1=x`, SECRET, { now }), false);
  });
});

describe("parseStripeSignatureHeader", () => {
  it("collects every v1", () => {
    const parsed = parseStripeSignatureHeader("t=1,v1=a,v0=ignored,v1=b");
    assert.deepEqual(parsed, { timestamp: "1", signatures: ["a", "b"] });
  });

  it("is undefined without a timestamp or without any v1", () => {
    assert.equal(parseStripeSignatureHeader("v1=a"), undefined);
    assert.equal(parseStripeSignatureHeader("t=1"), undefined);
  });
});

describe("decimalStringToCents", () => {
  it("does not lose the cent that floating point loses", () => {
    // 129.95 * 100 is 12994.999999999998 in IEEE 754.
    assert.equal(decimalStringToCents("129.95"), 12995);
    assert.equal(decimalStringToCents("0.07"), 7);
    assert.equal(decimalStringToCents("1.10"), 110);
  });

  it("handles whole numbers and a single decimal place", () => {
    assert.equal(decimalStringToCents("10"), 1000);
    assert.equal(decimalStringToCents("10.5"), 1050);
  });

  it("truncates beyond two decimals rather than rounding into money", () => {
    assert.equal(decimalStringToCents("1.999"), 199);
  });

  it("refuses negative and malformed values", () => {
    assert.equal(decimalStringToCents("-5.00"), undefined);
    assert.equal(decimalStringToCents("free"), undefined);
    assert.equal(decimalStringToCents(""), undefined);
  });
});

describe("normalizeShopifyOrder", () => {
  const order = {
    id: 4242,
    total_price: "129.95",
    currency: "usd",
    created_at: "2026-09-19T10:00:00Z",
    email: "buyer@example.com",
    note_attributes: [{ name: "cv_vid", value: "visitor-1" }],
  };

  it("normalizes money, currency and the visitor id", () => {
    const result = normalizeShopifyOrder(order);
    assert.equal(result?.provider, "shopify");
    assert.equal(result?.externalOrderId, "4242");
    assert.equal(result?.valueCents, 12995);
    assert.equal(result?.currency, "USD");
    assert.equal(result?.visitorId, "visitor-1");
  });

  it("is unattributable when checkout carried no visitor id", () => {
    const result = normalizeShopifyOrder({ ...order, note_attributes: [] });
    assert.equal(result?.visitorId, null);
  });

  it("returns undefined for a shape it cannot read", () => {
    assert.equal(normalizeShopifyOrder({ id: 1 }), undefined);
    assert.equal(normalizeShopifyOrder({ ...order, total_price: "lots" }), undefined);
    assert.equal(normalizeShopifyOrder({ ...order, created_at: "never" }), undefined);
  });
});

describe("normalizeStripeEvent", () => {
  const event = {
    id: "evt_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_123",
        amount_total: 12995,
        currency: "usd",
        created: 1_700_000_000,
        client_reference_id: "visitor-1",
        customer_email: "buyer@example.com",
      },
    },
  };

  it("takes the session id as the order id, not the event id", () => {
    // The event id changes on redelivery; the session id is the order.
    const result = normalizeStripeEvent(event);
    assert.equal(result?.externalOrderId, "cs_123");
    assert.equal(result?.valueCents, 12995);
    assert.equal(result?.visitorId, "visitor-1");
  });

  it("ignores every other event type", () => {
    assert.equal(normalizeStripeEvent({ ...event, type: "payment_intent.succeeded" }), undefined);
  });

  it("falls back to the metadata key for the visitor id", () => {
    const result = normalizeStripeEvent({
      ...event,
      data: {
        object: {
          ...event.data.object,
          client_reference_id: null,
          metadata: { cv_vid: "visitor-2" },
        },
      },
    });
    assert.equal(result?.visitorId, "visitor-2");
  });

  it("is undefined without an amount", () => {
    const result = normalizeStripeEvent({
      ...event,
      data: { object: { ...event.data.object, amount_total: null } },
    });
    assert.equal(result, undefined);
  });
});
