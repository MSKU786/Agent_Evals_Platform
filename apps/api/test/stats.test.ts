import { describe, expect, it } from "vitest";
import {
  bootstrapMeanCI,
  holm,
  mean,
  pairedDiffs,
  perTaskConfigMeans,
  signFlipPValue,
  verdictFromCI,
} from "../src/stats/stats";

describe("mean / perTaskConfigMeans / pairedDiffs", () => {
  it("averages reps into per-task per-config means", () => {
    const trials = [
      { taskId: "t1", configId: "A", score: 1 },
      { taskId: "t1", configId: "A", score: 0 }, // A on t1: 0.5
      { taskId: "t1", configId: "B", score: 1 },
      { taskId: "t1", configId: "B", score: 1 }, // B on t1: 1.0
      { taskId: "t2", configId: "A", score: 0 },
      { taskId: "t2", configId: "B", score: 0 },
    ];
    const m = perTaskConfigMeans(trials);
    expect(m.get("t1")!.get("A")).toBe(0.5);
    expect(m.get("t1")!.get("B")).toBe(1);
    // paired diffs B - A: t1 => 0.5, t2 => 0
    expect(pairedDiffs(m, "A", "B").sort()).toEqual([0, 0.5]);
    expect(mean([0, 0.5])).toBe(0.25);
  });
});

describe("bootstrapMeanCI", () => {
  it("is degenerate when all values are equal", () => {
    const { point, ci } = bootstrapMeanCI([0.5, 0.5, 0.5, 0.5], { seed: 7 });
    expect(point).toBe(0.5);
    expect(ci).toEqual({ lo: 0.5, hi: 0.5 });
  });

  it("is reproducible for a fixed seed and brackets the mean", () => {
    const data = [0, 0.2, 0.4, 0.6, 0.8, 1];
    const a = bootstrapMeanCI(data, { seed: 42, resamples: 2000 });
    const b = bootstrapMeanCI(data, { seed: 42, resamples: 2000 });
    expect(a).toEqual(b); // deterministic
    expect(a.ci.lo).toBeLessThanOrEqual(a.point);
    expect(a.point).toBeLessThanOrEqual(a.ci.hi);
  });
});

describe("signFlipPValue", () => {
  it("returns 1 when the effect is exactly zero", () => {
    expect(signFlipPValue([0.3, -0.3, 0.3, -0.3], { seed: 1 })).toBe(1);
  });

  it("is small for a strong consistent effect", () => {
    const p = signFlipPValue([0.4, 0.5, 0.6, 0.5, 0.45, 0.55, 0.5, 0.5], { seed: 1 });
    expect(p).toBeLessThan(0.05);
  });
});

describe("verdictFromCI", () => {
  it("better when CI is entirely above 0", () => {
    expect(verdictFromCI({ lo: 0.1, hi: 0.3 }, 5)).toBe("better");
  });
  it("worse when entirely below 0", () => {
    expect(verdictFromCI({ lo: -0.3, hi: -0.1 }, 5)).toBe("worse");
  });
  it("no-difference when it straddles 0", () => {
    expect(verdictFromCI({ lo: -0.1, hi: 0.2 }, 5)).toBe("no-difference");
  });
  it("insufficient-data with fewer than 2 tasks", () => {
    expect(verdictFromCI({ lo: 0.1, hi: 0.3 }, 1)).toBe("insufficient-data");
  });
});

describe("holm", () => {
  it("applies step-down adjustment in input order", () => {
    // sorted: 0.01(*3)=0.03, 0.03(*2)=0.06, 0.04(*1)=0.04 -> monotone 0.06
    expect(holm([0.01, 0.04, 0.03])).toEqual([0.03, 0.06, 0.06]);
  });
});
