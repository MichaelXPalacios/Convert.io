import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COOKIE_ASSIGNMENT,
  COOKIE_SESSION,
  COOKIE_VISITOR,
  REDIS_MIRROR_SCHEMA_VERSION,
} from "@convertio/contracts";
import type { MirrorArm, PosteriorMirror } from "@convertio/contracts";
import { mulberry32 } from "../src/bandit.js";
import type { MirrorStore } from "../src/mirror.js";
import { selectForRequest, trackRequestBody } from "../src/select.js";
import type { AssignedSelection, HeaderBearing } from "../src/select.js";

const EXPERIMENT_ID = "00000000-0000-4000-8000-000000000001";
const armId = (n: number) => `00000000-0000-4000-8000-00000000010${n}`;

function arm(overrides: Partial<MirrorArm> & { key: string }): MirrorArm {
  return {
    armId: armId(1),
    isControl: false,
    status: "active",
    alpha: 1,
    beta: 1,
    allocation: 0.5,
    exposuresCount: 0,
    ...overrides,
  };
}

const control = arm({ key: "control", armId: armId(1), isControl: true });
const challenger = arm({ key: "challenger", armId: armId(2) });

function mirror(arms: MirrorArm[] = [control, challenger]): PosteriorMirror {
  return {
    meta: {
      schemaVersion: REDIS_MIRROR_SCHEMA_VERSION,
      experimentId: EXPERIMENT_ID,
      slug: "demo-landing",
      explorationFloor: 0.1,
      minExposures: 1000,
      computedAt: "2026-09-18T00:00:00.000Z",
    },
    arms,
  };
}

/** A request carrying only the headers a test cares about. */
function request(headers: Record<string, string> = {}): HeaderBearing {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { headers: { get: (name) => lower.get(name.toLowerCase()) ?? null } };
}

const storeOf = (result: PosteriorMirror | undefined): MirrorStore => ({
  read: async () => result,
});

const failingStore = (error: Error): MirrorStore => ({
  read: async () => {
    throw error;
  },
});

function sequentialIds(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `id-${n}`;
  };
}

const deps = (store: MirrorStore) => ({
  store,
  newId: sequentialIds(),
  rng: mulberry32(1),
});

async function assigned(store: MirrorStore, req = request()): Promise<AssignedSelection> {
  const selection = await selectForRequest(req, "demo-landing", deps(store));
  assert.equal(selection.kind, "assigned");
  return selection as AssignedSelection;
}

describe("selectForRequest", () => {
  it("assigns an arm to a first-time visitor and sets all three cookies", async () => {
    const selection = await assigned(storeOf(mirror()));

    assert.ok(["control", "challenger"].includes(selection.arm.key));
    assert.equal(selection.identity.isNewVisitor, true);
    assert.equal(selection.identity.isNewSession, true);
    assert.equal(selection.setCookies.length, 3);
    assert.equal(selection.shouldTrack, true);
  });

  it("reports not-under-test when the slug has no mirror", async () => {
    const selection = await selectForRequest(request(), "unknown", deps(storeOf(undefined)));
    assert.equal(selection.kind, "not-under-test");
  });

  it("reports unavailable rather than throwing when the mirror read fails", async () => {
    const selection = await selectForRequest(
      request(),
      "demo-landing",
      deps(failingStore(new Error("upstash is down"))),
    );
    assert.equal(selection.kind, "unavailable");
    assert.match(
      selection.kind === "unavailable" ? selection.error.message : "",
      /upstash is down/,
    );
  });

  it("wraps a non-Error rejection", async () => {
    const store: MirrorStore = {
      read: async () => {
        throw "a string, not an Error";
      },
    };
    const selection = await selectForRequest(request(), "demo-landing", deps(store));
    assert.equal(selection.kind, "unavailable");
    assert.ok(
      selection.kind === "unavailable" && selection.error instanceof Error,
      "a thrown string must still arrive as an Error",
    );
  });

  it("reports unavailable when the mirror has no arm to fall back to", async () => {
    // A mirror whose only arm is paused and which has no control is a worker
    // bug; the page still has to render something.
    const selection = await selectForRequest(
      request(),
      "demo-landing",
      deps(storeOf(mirror([arm({ key: "orphan", status: "paused" })]))),
    );
    assert.equal(selection.kind, "unavailable");
    assert.match(
      selection.kind === "unavailable" ? selection.error.message : "",
      /no eligible arm/,
    );
  });

  it("honours the assignment cookie so a refresh does not reshuffle the page", async () => {
    const req = request({
      cookie: `${COOKIE_VISITOR}=v; ${COOKIE_SESSION}=s; ${COOKIE_ASSIGNMENT}=challenger`,
    });
    const selection = await assigned(storeOf(mirror()), req);

    assert.equal(selection.arm.key, "challenger");
    assert.equal(selection.assignment.reason, "sticky");
    assert.equal(selection.shouldTrack, false);
  });

  it("does not rewrite the visitor cookie for a returning visitor", async () => {
    const req = request({ cookie: `${COOKIE_VISITOR}=v; ${COOKIE_SESSION}=s` });
    const selection = await assigned(storeOf(mirror()), req);

    assert.equal(selection.identity.visitorId, "v");
    assert.ok(!selection.setCookies.some((c) => c.startsWith(`${COOKIE_VISITOR}=`)));
    assert.equal(selection.setCookies.length, 2);
  });

  it("keeps the visitor but tracks again when the session has expired", async () => {
    // The pageview that makes a long attribution window pay off.
    const req = request({ cookie: `${COOKIE_VISITOR}=v; ${COOKIE_ASSIGNMENT}=challenger` });
    const selection = await assigned(storeOf(mirror()), req);

    assert.equal(selection.identity.visitorId, "v");
    assert.equal(selection.identity.isNewSession, true);
    assert.equal(selection.shouldTrack, true);
  });

  it("tracks again when a stale assignment cookie forces a new arm", async () => {
    const req = request({
      cookie: `${COOKIE_VISITOR}=v; ${COOKIE_SESSION}=s; ${COOKIE_ASSIGNMENT}=retired-arm`,
    });
    const selection = await assigned(storeOf(mirror()), req);

    assert.notEqual(selection.arm.key, "retired-arm");
    assert.notEqual(selection.assignment.reason, "sticky");
    assert.equal(selection.shouldTrack, true);
  });

  it("ignores an assignment cookie naming an arm that is no longer eligible", async () => {
    const req = request({
      cookie: `${COOKIE_VISITOR}=v; ${COOKIE_SESSION}=s; ${COOKIE_ASSIGNMENT}=challenger`,
    });
    const paused = mirror([control, arm({ key: "challenger", status: "paused" })]);
    const selection = await assigned(storeOf(paused), req);

    assert.equal(selection.arm.key, "control");
    assert.equal(selection.shouldTrack, true);
  });

  it("can drop Secure for local http development", async () => {
    const selection = await selectForRequest(request(), "demo-landing", {
      ...deps(storeOf(mirror())),
      secureCookies: false,
    });
    assert.equal(selection.kind, "assigned");
    for (const cookie of (selection as AssignedSelection).setCookies) {
      assert.ok(!cookie.includes("Secure"), cookie);
    }
  });

  it("never returns an ineligible arm across many requests", async () => {
    const m = mirror([
      control,
      challenger,
      arm({ key: "paused", status: "paused" }),
      arm({ key: "retired", status: "retired" }),
    ]);
    const store = storeOf(m);
    const rng = mulberry32(99);

    for (let i = 0; i < 500; i += 1) {
      const selection = await selectForRequest(request(), "demo-landing", {
        store,
        newId: sequentialIds(),
        rng,
      });
      assert.equal(selection.kind, "assigned");
      const key = (selection as AssignedSelection).arm.key;
      assert.ok(key === "control" || key === "challenger", `returned ineligible arm ${key}`);
    }
  });
});

describe("trackRequestBody", () => {
  it("carries the identity and arm the visitor was actually given", async () => {
    const req = request({
      "user-agent": "Mozilla/5.0",
      referer: "https://ads.example/click",
      "x-vercel-ip-country": "US",
    });
    const selection = await assigned(storeOf(mirror()), req);
    const body = trackRequestBody(selection, req);

    assert.equal(body["slug"], "demo-landing");
    assert.equal(body["armKey"], selection.arm.key);
    assert.equal(body["visitorId"], selection.identity.visitorId);
    assert.equal(body["sessionId"], selection.identity.sessionId);
    assert.equal(body["userAgent"], "Mozilla/5.0");
    assert.equal(body["referrer"], "https://ads.example/click");
    assert.equal(body["country"], "US");
  });

  it("uses null, not undefined, for headers the request did not carry", async () => {
    const req = request();
    const selection = await assigned(storeOf(mirror()), req);
    const body = trackRequestBody(selection, req);

    assert.equal(body["userAgent"], null);
    assert.equal(body["referrer"], null);
    assert.equal(body["country"], null);
  });
});
