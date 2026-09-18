import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EXPLORATION_FLOOR,
  REDIS_MIRROR_SCHEMA_VERSION,
  type MirrorArm,
  type PosteriorMirror,
} from "@convertio/contracts";
import {
  assignArm,
  assignArmOrControl,
  controlArm,
  effectiveExplorationFloor,
  eligibleArms,
} from "../lib/assign.js";
import { mulberry32 } from "../lib/bandit.js";

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

function mirror(arms: MirrorArm[], explorationFloor = 0.1): PosteriorMirror {
  return {
    meta: {
      schemaVersion: REDIS_MIRROR_SCHEMA_VERSION,
      experimentId: EXPERIMENT_ID,
      slug: "landing",
      explorationFloor,
      minExposures: 1000,
      computedAt: "2026-09-18T00:00:00.000Z",
    },
    arms,
  };
}

const control = arm({ key: "control", armId: armId(1), isControl: true });
const challenger = arm({ key: "challenger", armId: armId(2) });

describe("effectiveExplorationFloor", () => {
  it("never returns less than the hard floor", () => {
    for (const configured of [0, 0.0001, 0.05, 0.09999]) {
      assert.equal(effectiveExplorationFloor(configured), EXPLORATION_FLOOR);
    }
  });

  it("lets configuration widen exploration", () => {
    assert.equal(effectiveExplorationFloor(0.5), 0.5);
    assert.equal(effectiveExplorationFloor(0.25), 0.25);
  });

  it("falls back to the hard floor for a nonsense value", () => {
    assert.equal(effectiveExplorationFloor(Number.NaN), EXPLORATION_FLOOR);
    assert.equal(effectiveExplorationFloor(Number.POSITIVE_INFINITY), EXPLORATION_FLOOR);
  });
});

describe("eligibleArms", () => {
  it("includes active and promoted, excludes paused and retired", () => {
    const m = mirror([
      arm({ key: "a", status: "active" }),
      arm({ key: "b", status: "promoted" }),
      arm({ key: "c", status: "paused" }),
      arm({ key: "d", status: "retired" }),
    ]);
    assert.deepEqual(
      eligibleArms(m).map((a) => a.key),
      ["a", "b"],
    );
  });
});

describe("controlArm", () => {
  it("finds the control", () => {
    assert.equal(controlArm(mirror([control, challenger]))?.key, "control");
  });

  it("returns undefined when there is none", () => {
    assert.equal(controlArm(mirror([challenger])), undefined);
  });
});

describe("assignArm", () => {
  it("throws when no arm is eligible", () => {
    const m = mirror([arm({ key: "a", status: "paused" })]);
    assert.throws(() => assignArm(m, { rng: mulberry32(1) }), /no eligible arm/);
  });

  it("honours a sticky key that still names an eligible arm", () => {
    const m = mirror([control, challenger]);
    const result = assignArm(m, { rng: mulberry32(1), stickyArmKey: "challenger" });
    assert.equal(result.arm.key, "challenger");
    assert.equal(result.reason, "sticky");
  });

  it("ignores a sticky key naming an arm that is no longer eligible", () => {
    const m = mirror([control, arm({ key: "challenger", status: "paused" })]);
    const result = assignArm(m, { rng: mulberry32(1), stickyArmKey: "challenger" });
    assert.equal(result.arm.key, "control");
    assert.notEqual(result.reason, "sticky");
  });

  it("ignores a sticky key that names nothing at all", () => {
    const m = mirror([control, challenger]);
    const result = assignArm(m, { rng: mulberry32(1), stickyArmKey: "deleted-arm" });
    assert.notEqual(result.reason, "sticky");
  });

  it("reports the enforced floor, not the configured one", () => {
    const m = mirror([control, challenger], 0.01);
    const result = assignArm(m, { rng: mulberry32(1) });
    assert.equal(result.explorationFloor, EXPLORATION_FLOOR);
  });

  it("returns the only eligible arm without consulting randomness", () => {
    const m = mirror([control]);
    const exploded = () => {
      throw new Error("rng must not be called for a single-arm experiment");
    };
    const result = assignArm(m, { rng: exploded });
    assert.equal(result.arm.key, "control");
  });

  it("gives a badly losing arm at least the exploration floor", () => {
    // The challenger's posterior is hopeless. Thompson sampling alone would
    // starve it; the floor is what keeps it measurable.
    const m = mirror([
      arm({ key: "control", armId: armId(1), isControl: true, alpha: 900, beta: 100 }),
      arm({ key: "challenger", armId: armId(2), alpha: 1, beta: 500 }),
    ]);

    const rng = mulberry32(2024);
    const n = 40_000;
    let challengerShare = 0;
    for (let i = 0; i < n; i += 1) {
      if (assignArm(m, { rng }).arm.key === "challenger") challengerShare += 1;
    }

    const share = challengerShare / n;
    // Uniform exploration hands it half of the floor's traffic.
    const expected = EXPLORATION_FLOOR / 2;
    assert.ok(
      share > expected * 0.8,
      `challenger got ${share}, expected at least about ${expected}`,
    );
  });

  it("sends the clear majority of traffic to a clearly better arm", () => {
    const m = mirror([
      arm({ key: "control", armId: armId(1), isControl: true, alpha: 20, beta: 200 }),
      arm({ key: "challenger", armId: armId(2), alpha: 200, beta: 20 }),
    ]);

    const rng = mulberry32(5150);
    const n = 20_000;
    let winner = 0;
    for (let i = 0; i < n; i += 1) {
      if (assignArm(m, { rng }).arm.key === "challenger") winner += 1;
    }

    const share = winner / n;
    // Exploitation takes (1 - floor) of traffic, exploration splits the rest.
    assert.ok(share > 0.9, `better arm got only ${share}`);
    assert.ok(share < 1, "the floor must keep some traffic on the other arm");
  });

  it("splits roughly evenly between two identical arms", () => {
    const m = mirror([control, challenger]);
    const rng = mulberry32(31337);
    const n = 20_000;
    let controlCount = 0;
    for (let i = 0; i < n; i += 1) {
      if (assignArm(m, { rng }).arm.key === "control") controlCount += 1;
    }
    const share = controlCount / n;
    assert.ok(Math.abs(share - 0.5) < 0.03, `control got ${share}`);
  });

  it("only ever returns an eligible arm", () => {
    const m = mirror([
      control,
      challenger,
      arm({ key: "paused", status: "paused" }),
      arm({ key: "retired", status: "retired" }),
    ]);
    const rng = mulberry32(8);
    for (let i = 0; i < 5_000; i += 1) {
      const key = assignArm(m, { rng }).arm.key;
      assert.ok(key === "control" || key === "challenger", `returned ineligible arm ${key}`);
    }
  });
});

describe("assignArmOrControl", () => {
  it("falls back to the control when allocation cannot proceed", () => {
    // Every non-control arm is ineligible and the control itself is retired,
    // which the schema forbids — so this is a broken mirror, and the page must
    // still render.
    const m = mirror([
      arm({ key: "control", armId: armId(1), isControl: true, status: "retired" }),
    ]);
    const result = assignArmOrControl(m, { rng: mulberry32(1) });
    assert.equal(result?.arm.key, "control");
    assert.equal(result?.reason, "control_fallback");
  });

  it("returns undefined when there is no control to fall back to", () => {
    const m = mirror([arm({ key: "a", status: "paused" })]);
    assert.equal(assignArmOrControl(m, { rng: mulberry32(1) }), undefined);
  });

  it("passes through a normal allocation untouched", () => {
    const m = mirror([control, challenger]);
    const result = assignArmOrControl(m, { rng: mulberry32(1) });
    assert.ok(result !== undefined);
    assert.notEqual(result.reason, "control_fallback");
  });
});
