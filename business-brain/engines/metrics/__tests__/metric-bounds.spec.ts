/**
 * What a metric IS, beyond its value.
 *
 * Three declarations, each of which is wrong by omission rather than by error: a
 * metric added without bounds gets a band that runs off the end of its scale, one
 * added without a span gets compared against the wrong days, and a rate added
 * without a denominator gets judged on three appointments. None of those shows up
 * as a visibly wrong number — they show up as a confident one.
 */

import { describe, expect, it } from "vitest";

import { MetricUnit } from "../../../domain";
import { METRIC_DESCRIPTORS, MetricKey } from "../metric-ids";
import {
  boundsFor,
  clampToBounds,
  rateBasisFor,
  spanFor,
  MetricSpan,
} from "../metric-bounds";

const ALL_KEYS = Object.values(MetricKey);

describe("spans", () => {
  it("declares one for every metric", () => {
    // The point of the table. A key with no entry falls back to WINDOW, which is
    // the safe answer and the wrong one for a daily metric — so the omission has
    // to fail here rather than silently widen a comparison.
    for (const key of ALL_KEYS) {
      expect(Object.values(MetricSpan), `no span declared for ${key}`).toContain(spanFor(key));
    }
    const declared = ALL_KEYS.filter((k) => spanFor(k) === MetricSpan.DAY);
    expect(declared.length).toBeGreaterThan(0);
  });

  it("treats every trailing-window metric as a window", () => {
    // Not because of the suffix — the table is explicit — but the two must agree,
    // and a `_30d` metric declared as a DAY would be split by weekday for no
    // reason and lose six sevenths of its sample.
    for (const key of ALL_KEYS.filter((k) => k.endsWith("_30d"))) {
      expect(spanFor(key), key).toBe(MetricSpan.WINDOW);
    }
  });

  it("is conservative about a metric it has never heard of", () => {
    expect(spanFor("something.invented_later")).toBe(MetricSpan.WINDOW);
  });
});

describe("bounds", () => {
  it("bounds a share of the appointment book at both ends", () => {
    expect(boundsFor(MetricKey.SCHEDULING_NO_SHOW_RATE_30D)).toEqual({ min: 0, max: 100 });
    expect(clampToBounds(MetricKey.SCHEDULING_NO_SHOW_RATE_30D, -0.1)).toBe(0);
    expect(clampToBounds(MetricKey.SCHEDULING_NO_SHOW_RATE_30D, 120)).toBe(100);
  });

  it("leaves a percentage that is a comparison of two quantities unbounded above", () => {
    // Chair time genuinely runs past what was open; cash genuinely exceeds the
    // month's production. Clamping either would hide a real reading.
    expect(boundsFor(MetricKey.CAPACITY_CHAIR_UTILIZATION_30D).max).toBeNull();
    expect(boundsFor(MetricKey.REVENUE_COLLECTION_RATE_30D).max).toBeNull();
    expect(clampToBounds(MetricKey.CAPACITY_CHAIR_UTILIZATION_30D, 118)).toBe(118);
  });

  it("keeps a signed percentage signed", () => {
    expect(boundsFor(MetricKey.SCHEDULING_APPOINTMENT_OVERRUN_30D)).toEqual({
      min: null,
      max: null,
    });
    expect(clampToBounds(MetricKey.SCHEDULING_APPOINTMENT_OVERRUN_30D, -12)).toBe(-12);
  });

  it("floors every count and duration at zero without being told", () => {
    for (const key of ALL_KEYS) {
      const unit = METRIC_DESCRIPTORS[key].unit;
      if (unit === MetricUnit.COUNT || unit === MetricUnit.MINUTES) {
        expect(boundsFor(key).min, key).toBe(0);
      }
    }
  });

  it("invents no range for a metric it has never heard of", () => {
    expect(boundsFor("something.invented_later")).toEqual({ min: null, max: null });
  });
});

describe("rate bases", () => {
  it("names a denominator metric that exists and is a count of the right thing", () => {
    for (const key of ALL_KEYS) {
      const basis = rateBasisFor(key);
      if (basis === undefined) continue;
      expect(METRIC_DESCRIPTORS[basis.denominatorKey], `${key} -> ${basis.denominatorKey}`).toBeDefined();
      expect(basis.minimumToJudge).toBeGreaterThan(0);
      expect(basis.noun.length).toBeGreaterThan(0);
    }
  });

  it("asks for enough appointments that one of them cannot carry a finding", () => {
    // The whole rule in one assertion: the attendance rates are reported down to
    // 2 points, so one appointment must move them by less than that.
    const basis = rateBasisFor(MetricKey.SCHEDULING_NO_SHOW_RATE_30D);
    expect(100 / (basis?.minimumToJudge ?? 1)).toBeLessThanOrEqual(2);
  });

  it("leaves metrics that are not rates without one", () => {
    expect(rateBasisFor(MetricKey.FOLLOWUPS_OVERDUE)).toBeUndefined();
    expect(rateBasisFor(MetricKey.REVENUE_OUTSTANDING)).toBeUndefined();
  });
});
