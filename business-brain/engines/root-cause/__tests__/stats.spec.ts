/**
 * The root-cause statistics against values that can be checked by hand or in a
 * statistics table.
 */

import { describe, expect, it } from "vitest";

import { fisherGreater, normalCdf, perComparisonAlpha, rankSumGreater } from "../stats";

describe("root-cause statistics", () => {
  it("computes a one-sided Fisher exact test", () => {
    // Lady tasting tea: 3 of 4 in the group vs 1 of 4 in the rest.
    expect(fisherGreater(3, 4, 1, 4)).toBeCloseTo(0.2429, 4);
    expect(fisherGreater(4, 4, 0, 4)).toBeCloseTo(1 / 70, 6);
    // Nothing more extreme than no events at all.
    expect(fisherGreater(0, 10, 0, 10)).toBe(1);
  });

  it("computes an exact one-sided rank-sum test for small samples", () => {
    // Group entirely above the rest: 1 / C(7, 3).
    expect(rankSumGreater([10, 11, 12], [1, 2, 3, 4])).toBeCloseTo(1 / 35, 6);
    // Identical samples: no evidence at all.
    expect(rankSumGreater([5, 5, 5], [5, 5, 5, 5])).toBe(1);
    expect(rankSumGreater([], [1, 2])).toBe(1);
  });

  it("agrees between the exact and approximate rank-sum tests where both apply", () => {
    const group = Array.from({ length: 30 }, (_, i) => i * 1.3 + 4);
    const rest = Array.from({ length: 30 }, (_, i) => i * 1.1);
    const exact = rankSumGreater(group, rest);
    const approx = rankSumGreater([...group, ...group.map((v) => v + 0.001)], [...rest, ...rest.map((v) => v + 0.001)]);
    expect(exact).toBeGreaterThan(0);
    expect(approx).toBeLessThan(exact);
  });

  it("uses a standard normal CDF", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.6449)).toBeCloseTo(0.95, 4);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 4);
  });

  it("shares a family's budget across its comparisons", () => {
    expect(perComparisonAlpha(0.05, 10)).toBeCloseTo(0.005, 10);
    expect(perComparisonAlpha(0.05, 0)).toBe(0.05);
  });
});
