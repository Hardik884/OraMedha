/**
 * Achievement Engine — the five gates.
 *
 * Almost every test here asserts that a plausible-looking improvement is NOT
 * reported. That ratio is the design: the failure mode of positive intelligence
 * is not a missed win, it is a page of congratulation a dentist learns to scroll
 * past — and once they scroll past the wins they scroll past the problems beside
 * them too.
 *
 * Each gate gets its own block, and each block includes the case that would slip
 * through if the gate were removed.
 */

import { describe, expect, it } from "vitest";

import { ClinicDimension } from "../../../domain";
import {
  BaselineQuality,
  type MetricBaseline,
} from "../../baseline";
import { MetricKey } from "../../metrics/metric-ids";
import {
  DEFAULT_ACHIEVEMENT_CONFIG,
  deriveAchievements,
} from "../achievement-engine";
import { BaselineWithholdReason, type BaselineWithholding } from "../../baseline";
import { ACHIEVEMENT_SPECS } from "../achievement-catalog";

const CLINIC = "clinic_ach";
const DATE = "2026-09-12";
const NOW = "2026-09-12T09:00:00.000Z";

/**
 * A baseline shaped for a test.
 *
 * Defaults describe the ordinary qualifying case — an adequate baseline, today
 * well below the band, held for three days — so each test states only the one
 * field it is about.
 */
function baseline(over: Partial<MetricBaseline> = {}): MetricBaseline {
  const median = over.median ?? 11;
  const current = over.current ?? 6;
  return {
    key: MetricKey.SCHEDULING_NO_SHOW_RATE_30D,
    current,
    median,
    mad: 1,
    deviation: 1.1,
    lower: median - 2.2,
    upper: median + 2.2,
    delta: current - median,
    deltaPercent: null,
    observations: 8,
    // The default is a rate metric, so it carries a denominator in production
    // too. Sized above the rule, so every test that is not ABOUT the sample
    // behaves as it did before the rule existed.
    sample: {
      key: MetricKey.SCHEDULING_APPOINTMENTS_30D,
      noun: "appointments",
      minimum: 50,
      current: 90,
      median: 88,
      sufficientToday: true,
      daysExcluded: 0,
    },
    clamped: false,
    quality: BaselineQuality.ADEQUATE,
    position: current < median - 2.2 ? "below" : current > median + 2.2 ? "above" : "inside",
    consecutiveOutside: 3,
    confidence: 0.7,
    ...over,
  };
}

function run(
  baselines: readonly MetricBaseline[],
  withheld: readonly BaselineWithholding[] = [],
) {
  return deriveAchievements({
    baselines: new Map(baselines.map((b) => [b.key, b])),
    withheld: new Map(withheld.map((w) => [w.key, w])),
    clinicId: CLINIC,
    date: DATE,
    now: NOW,
  });
}

function rejectionFor(result: ReturnType<typeof run>, key: string) {
  return result.decisions.find((d) => d.metricKey === key)?.rejection;
}

// ── The qualifying case, so the gates are not passing by accident ────────────

describe("a measured improvement", () => {
  it("is reported, with the figures behind it", () => {
    const { achievements } = run([baseline()]);
    expect(achievements).toHaveLength(1);
    expect(achievements[0]).toMatchObject({
      id: `achievement.${MetricKey.SCHEDULING_NO_SHOW_RATE_30D}:${CLINIC}:${DATE}`,
      metricKey: MetricKey.SCHEDULING_NO_SHOW_RATE_30D,
      dimension: ClinicDimension.ATTENDANCE,
      current: 6,
      baseline: 11,
      delta: -5,
      consecutiveDays: 3,
      sustained: true,
      measuredAt: NOW,
    });
  });

  it("reports every catalogued metric it considered, whether or not it qualified", () => {
    // Mirrors the Signal Engine's trace. A clinic with no wins gets an empty list
    // plus seven stated reasons — never silence, which could be mistaken for the
    // check not having run.
    const { decisions } = run([baseline()]);
    expect(decisions).toHaveLength(ACHIEVEMENT_SPECS.length);
    expect(decisions.filter((d) => d.emitted)).toHaveLength(1);
    for (const decision of decisions) {
      expect(decision.reasoning.length).toBeGreaterThan(0);
    }
  });
});

// ── Gate 1: measurable on both sides ─────────────────────────────────────────

describe("gate 1 — measurable on both sides", () => {
  it("emits nothing at all when there are no baselines", () => {
    const result = run([]);
    expect(result.achievements).toEqual([]);
    expect(rejectionFor(result, MetricKey.SCHEDULING_NO_SHOW_RATE_30D)).toBe("no_baseline");
  });

  it("refuses a rate with too few appointments behind TODAY, band or no band", () => {
    // The band may be perfectly solid; this day cannot be compared against it.
    // Four appointments and one missed reads 25%, and one flat tyre moves it
    // further than anything the clinic could have changed.
    const result = run([
      baseline({
        current: 25,
        position: "above",
        sample: {
          key: MetricKey.SCHEDULING_APPOINTMENTS_30D,
          noun: "appointments",
          minimum: 50,
          current: 4,
          median: 80,
          sufficientToday: false,
          daysExcluded: 0,
        },
      }),
    ]);
    expect(result.achievements).toEqual([]);
    expect(rejectionFor(result, MetricKey.SCHEDULING_NO_SHOW_RATE_30D)).toBe("sample_too_small");
    // And the sentence says which number was short, so a dentist is not left
    // guessing what "not enough data" refers to.
    const decision = result.decisions.find(
      (d) => d.metricKey === MetricKey.SCHEDULING_NO_SHOW_RATE_30D,
    );
    expect(decision?.reasoning).toContain("4 appointments");
    expect(decision?.reasoning).toContain("50");
  });

  it("distinguishes a clinic too small to judge from one never measured", () => {
    // Both have no baseline. They are not the same situation, and only one of
    // them is fixed by waiting.
    const never = run([]);
    expect(rejectionFor(never, MetricKey.SCHEDULING_NO_SHOW_RATE_30D)).toBe("no_baseline");

    const tooSmall = run(
      [],
      [
        {
          key: MetricKey.SCHEDULING_NO_SHOW_RATE_30D,
          reason: BaselineWithholdReason.SAMPLE_TOO_SMALL,
          daysSeen: 30,
          daysUsable: 0,
          minimumSample: 50,
          sampleNoun: "appointments",
        },
      ],
    );
    expect(rejectionFor(tooSmall, MetricKey.SCHEDULING_NO_SHOW_RATE_30D)).toBe(
      "sample_too_small",
    );
    const decision = tooSmall.decisions.find(
      (d) => d.metricKey === MetricKey.SCHEDULING_NO_SHOW_RATE_30D,
    );
    expect(decision?.reasoning).toContain("30 day(s)");
  });

  it("refuses a thin baseline, however good today looks", () => {
    // The gate that stops a three-day-old clinic being told it has improved.
    // Three days cannot establish what normal is, so nothing can beat it.
    const result = run([baseline({ quality: BaselineQuality.THIN, observations: 3 })]);
    expect(result.achievements).toEqual([]);
    expect(rejectionFor(result, MetricKey.SCHEDULING_NO_SHOW_RATE_30D)).toBe(
      "baseline_too_thin",
    );
  });

  it("accepts a strong baseline", () => {
    const result = run([baseline({ quality: BaselineQuality.STRONG, observations: 21 })]);
    expect(result.achievements).toHaveLength(1);
  });

  it("refuses a metric that was not measured today", () => {
    const result = run([baseline({ current: null, position: null, delta: null })]);
    expect(result.achievements).toEqual([]);
    expect(rejectionFor(result, MetricKey.SCHEDULING_NO_SHOW_RATE_30D)).toBe(
      "not_measured_today",
    );
  });
});

// ── Gate 2: beyond normal variation ──────────────────────────────────────────

describe("gate 2 — beyond this clinic's normal variation", () => {
  it("refuses a value that is merely better than the median", () => {
    // The gate that matters most for noise. Half of all days beat the median by
    // definition, so without this the engine would emit a win every other day.
    const result = run([baseline({ current: 10, median: 11, position: "inside", delta: -1 })]);
    expect(result.achievements).toEqual([]);
    expect(rejectionFor(result, MetricKey.SCHEDULING_NO_SHOW_RATE_30D)).toBe(
      "inside_normal_range",
    );
  });

  it("refuses a value outside the band in the WORSE direction", () => {
    // A no-show rate of 30% against a normal of 11% is outside the band and is
    // emphatically not an achievement.
    const result = run([
      baseline({ current: 30, median: 11, position: "above", delta: 19 }),
    ]);
    expect(result.achievements).toEqual([]);
    expect(rejectionFor(result, MetricKey.SCHEDULING_NO_SHOW_RATE_30D)).toBe(
      "wrong_direction",
    );
  });

  it("reads the improving direction correctly for a higher-is-better metric", () => {
    // Collection rate rising is a win; the same movement on no-shows would not be.
    const result = run([
      baseline({
        key: MetricKey.REVENUE_COLLECTION_RATE_30D,
        median: 74,
        current: 88,
        lower: 70,
        upper: 78,
        delta: 14,
        position: "above",
      }),
    ]);
    expect(result.achievements).toHaveLength(1);
    expect(result.achievements[0]?.dimension).toBe(ClinicDimension.FINANCIAL_HEALTH);
  });
});

// ── Gate 3: absolute minimum ─────────────────────────────────────────────────

describe("gate 3 — the metric's own absolute floor", () => {
  it("refuses a statistically clean movement that is too small to matter", () => {
    // A very tight band makes a 1-point drop "outside the normal range". It is
    // still one point, and this clinic's no-show floor is two.
    const result = run([
      baseline({
        median: 11,
        current: 10,
        mad: 0.1,
        deviation: 0.2,
        lower: 10.6,
        upper: 11.4,
        delta: -1,
        position: "below",
      }),
    ]);
    expect(result.achievements).toEqual([]);
    expect(rejectionFor(result, MetricKey.SCHEDULING_NO_SHOW_RATE_30D)).toBe(
      "below_minimum_delta",
    );
  });

  it("accepts a movement exactly at the floor", () => {
    const result = run([
      baseline({
        median: 11,
        current: 9,
        mad: 0.1,
        deviation: 0.2,
        lower: 10.6,
        upper: 11.4,
        delta: -2,
        position: "below",
      }),
    ]);
    expect(result.achievements).toHaveLength(1);
  });
});

// ── Gate 4: not already good ─────────────────────────────────────────────────

describe("gate 4 — the clinic was not already good at this", () => {
  it("refuses an improvement on a metric this clinic had already solved", () => {
    // Normal of 3% no-shows going to 0.5% is arithmetic, not news — and reporting
    // it implies a change the clinic would not recognise as one.
    const result = run([
      baseline({ median: 3, current: 0.4, lower: 0.9, upper: 5.1, delta: -2.6, position: "below" }),
    ]);
    expect(result.achievements).toEqual([]);
    expect(rejectionFor(result, MetricKey.SCHEDULING_NO_SHOW_RATE_30D)).toBe("already_good");
  });

  it("judges the gate on the BASELINE, not on today", () => {
    // The distinction: a clinic whose normal is 11% and is now at 3% HAS changed
    // something worth reporting, even though 3% is itself excellent. Judging
    // today's value would suppress exactly the biggest wins.
    const result = run([
      baseline({ median: 11, current: 3, lower: 8.8, upper: 13.2, delta: -8, position: "below" }),
    ]);
    expect(result.achievements).toHaveLength(1);
  });

  it("applies the gate in the right direction for a higher-is-better metric", () => {
    const result = run([
      baseline({
        key: MetricKey.CAPACITY_CHAIR_UTILIZATION_30D,
        median: 88,
        current: 96,
        lower: 84,
        upper: 92,
        delta: 8,
        position: "above",
      }),
    ]);
    expect(result.achievements).toEqual([]);
    expect(rejectionFor(result, MetricKey.CAPACITY_CHAIR_UTILIZATION_30D)).toBe("already_good");
  });
});

// ── Gate 5: sustained, or labelled ───────────────────────────────────────────

describe("gate 5 — sustained, or labelled as a single day", () => {
  it("marks a two-day run as sustained", () => {
    const { achievements } = run([baseline({ consecutiveOutside: 2 })]);
    expect(achievements[0]?.sustained).toBe(true);
  });

  it("still reports a single day, but marked unsustained", () => {
    // Not suppressed: it is a real reading. Marked, so the view can say "first
    // day" instead of implying a trend that has not formed.
    const { achievements } = run([baseline({ consecutiveOutside: 1 })]);
    expect(achievements).toHaveLength(1);
    expect(achievements[0]?.sustained).toBe(false);
    expect(achievements[0]?.consecutiveDays).toBe(1);
  });

  it("puts sustained improvements ahead of single days, whatever their size", () => {
    // A big one-day move must not outrank a smaller improvement that has held.
    const { achievements } = run([
      baseline({ consecutiveOutside: 1, current: 1, delta: -10 }),
      baseline({
        key: MetricKey.REVENUE_COLLECTION_RATE_30D,
        median: 74,
        current: 84,
        lower: 70,
        upper: 78,
        delta: 10,
        position: "above",
        consecutiveOutside: 5,
      }),
    ]);
    expect(achievements[0]?.metricKey).toBe(MetricKey.REVENUE_COLLECTION_RATE_30D);
    expect(achievements[1]?.sustained).toBe(false);
  });
});

// ── The cap, and determinism ─────────────────────────────────────────────────

describe("the cap", () => {
  it("never returns more than the configured maximum", () => {
    // The hard limit is the design. Six wins beside one problem buries the
    // problem, which is the failure this whole layer has to avoid.
    const all = [
      baseline(),
      baseline({
        key: MetricKey.SCHEDULING_CANCELLATION_RATE_30D,
        median: 14,
        current: 6,
        lower: 11,
        upper: 17,
        delta: -8,
        position: "below",
      }),
      baseline({
        key: MetricKey.REVENUE_COLLECTION_RATE_30D,
        median: 70,
        current: 90,
        lower: 66,
        upper: 74,
        delta: 20,
        position: "above",
      }),
      baseline({
        key: MetricKey.FOLLOWUPS_OVERDUE,
        median: 18,
        current: 4,
        lower: 14,
        upper: 22,
        delta: -14,
        position: "below",
      }),
      baseline({
        key: MetricKey.QUEUE_AVERAGE_WAITING_TIME,
        median: 40,
        current: 15,
        lower: 32,
        upper: 48,
        delta: -25,
        position: "below",
      }),
    ];
    const { achievements, decisions } = run(all);
    expect(achievements).toHaveLength(DEFAULT_ACHIEVEMENT_CONFIG.maximum);
    // All five still show as qualifying in the trace — the cap is a presentation
    // limit, not a claim that the others did not happen.
    expect(decisions.filter((d) => d.emitted)).toHaveLength(5);
  });
});

describe("determinism", () => {
  it("produces byte-identical output across runs over identical input", () => {
    const input = [
      baseline(),
      baseline({
        key: MetricKey.FOLLOWUPS_OVERDUE,
        median: 18,
        current: 4,
        lower: 14,
        upper: 22,
        delta: -14,
        position: "below",
      }),
    ];
    expect(run(input)).toEqual(run(input));
  });

  it("scopes every id to the clinic and date it was measured for", () => {
    // Multi-tenant hygiene: two clinics' achievements must never collide on id,
    // and yesterday's must never be mistaken for today's.
    const a = deriveAchievements({
      baselines: new Map([[MetricKey.SCHEDULING_NO_SHOW_RATE_30D, baseline()]]),
      clinicId: "clinic_a",
      date: DATE,
      now: NOW,
    });
    const b = deriveAchievements({
      baselines: new Map([[MetricKey.SCHEDULING_NO_SHOW_RATE_30D, baseline()]]),
      clinicId: "clinic_b",
      date: DATE,
      now: NOW,
    });
    expect(a.achievements[0]?.id).toContain("clinic_a");
    expect(b.achievements[0]?.id).toContain("clinic_b");
    expect(a.achievements[0]?.id).not.toBe(b.achievements[0]?.id);
  });
});

// ── The catalogue itself ─────────────────────────────────────────────────────

describe("the catalogue", () => {
  it("covers all six score dimensions", () => {
    // A dimension with no achievable metric can never produce a win, which would
    // make the strip silently biased toward whichever parts of the clinic happen
    // to be represented.
    const covered = new Set(ACHIEVEMENT_SPECS.map((s) => s.dimension));
    expect(covered.size).toBe(Object.keys(ClinicDimension).length);
  });

  it("names a real metric key for every entry", () => {
    const known = new Set<string>(Object.values(MetricKey));
    for (const spec of ACHIEVEMENT_SPECS) {
      expect(known, `unknown metric key ${spec.metricKey}`).toContain(spec.metricKey);
    }
  });

  it("declares no metric twice", () => {
    const keys = ACHIEVEMENT_SPECS.map((s) => s.metricKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
