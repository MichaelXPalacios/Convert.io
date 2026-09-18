import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mulberry32, sampleBeta, sampleGamma, sampleNormal } from "../lib/bandit.js";

describe("mulberry32", () => {
  it("is deterministic for a given seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i += 1) assert.equal(a(), b());
  });

  it("stays inside [0, 1)", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 10_000; i += 1) {
      const u = rng();
      assert.ok(u >= 0 && u < 1, `draw out of range: ${u}`);
    }
  });
});

describe("sampleNormal", () => {
  it("has approximately zero mean and unit variance", () => {
    const rng = mulberry32(1);
    const n = 50_000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i += 1) {
      const x = sampleNormal(rng);
      sum += x;
      sumSq += x * x;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    assert.ok(Math.abs(mean) < 0.03, `mean was ${mean}`);
    assert.ok(Math.abs(variance - 1) < 0.05, `variance was ${variance}`);
  });
});

describe("sampleGamma", () => {
  it("rejects a non-positive or non-finite shape", () => {
    const rng = mulberry32(1);
    assert.throws(() => sampleGamma(0, rng), /positive finite/);
    assert.throws(() => sampleGamma(-1, rng), /positive finite/);
    assert.throws(() => sampleGamma(Number.NaN, rng), /positive finite/);
  });

  it("has mean approximately equal to its shape", () => {
    for (const shape of [0.5, 1, 3, 20]) {
      const rng = mulberry32(shape * 1000);
      const n = 20_000;
      let sum = 0;
      for (let i = 0; i < n; i += 1) sum += sampleGamma(shape, rng);
      const mean = sum / n;
      assert.ok(
        Math.abs(mean - shape) < 0.05 * shape + 0.02,
        `shape ${shape} produced mean ${mean}`,
      );
    }
  });

  it("returns only positive finite draws", () => {
    const rng = mulberry32(99);
    for (const shape of [0.1, 1, 7]) {
      for (let i = 0; i < 2000; i += 1) {
        const x = sampleGamma(shape, rng);
        assert.ok(Number.isFinite(x) && x > 0, `shape ${shape} produced ${x}`);
      }
    }
  });

  it("terminates on a degenerate source instead of hanging", () => {
    // A source stuck at a single value starves the rejection loop. The attempt
    // cap must turn that into a finite answer.
    const stuck = () => 0;
    const x = sampleGamma(5, stuck);
    assert.ok(Number.isFinite(x), `expected a finite fallback, got ${x}`);
  });
});

describe("sampleBeta", () => {
  it("stays within [0, 1]", () => {
    const rng = mulberry32(3);
    for (let i = 0; i < 20_000; i += 1) {
      const x = sampleBeta(2, 5, rng);
      assert.ok(x >= 0 && x <= 1, `draw out of range: ${x}`);
    }
  });

  it("has mean approximately alpha / (alpha + beta)", () => {
    const cases: Array<[number, number]> = [
      [1, 1],
      [2, 8],
      [30, 10],
      [100, 100],
    ];
    for (const [alpha, beta] of cases) {
      const rng = mulberry32(alpha * 31 + beta);
      const n = 30_000;
      let sum = 0;
      for (let i = 0; i < n; i += 1) sum += sampleBeta(alpha, beta, rng);
      const mean = sum / n;
      const expected = alpha / (alpha + beta);
      assert.ok(
        Math.abs(mean - expected) < 0.01,
        `Beta(${alpha}, ${beta}) produced mean ${mean}, expected ${expected}`,
      );
    }
  });

  it("separates a clearly better arm from a clearly worse one", () => {
    // The property allocation depends on: with enough data, the better arm's
    // draw wins the large majority of head-to-head comparisons.
    const rng = mulberry32(17);
    let betterWins = 0;
    const n = 10_000;
    for (let i = 0; i < n; i += 1) {
      const good = sampleBeta(60, 40, rng);
      const bad = sampleBeta(40, 60, rng);
      if (good > bad) betterWins += 1;
    }
    assert.ok(betterWins / n > 0.95, `better arm won only ${betterWins}/${n}`);
  });
});
