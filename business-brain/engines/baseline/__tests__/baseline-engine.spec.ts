/**
 * Baseline Engine — what is normal for this clinic.
 *
 * Two things dominate this suite, and both are about refusing to answer.
 *
 * The first is the small-data rule: below three observations there is no
 * baseline, and below six there is one that must not be judged against. Getting
 * that wrong does not produce a visibly wrong number — it produces a confident
 * one, which is worse.
 *
 * The second is the zero-MAD trap. Small integer metrics read identically for
 * days at a time, and an unfloored MAD collapses the band to a point, at which
 * every subsequent value is "outside this clinic's normal range". That single
 * defect would turn positive intelligence into a daily stream of nonsense, so it
 * gets the most tests here.
 */

import { describe, expect, it } from "vitest";

import { buildMetric, MetricKey } from "../../metrics/metric-ids";
import {
  BaselineDirection,
  BaselineQuality,
  BaselineWithholdReason,
  DEFAULT_BASELINE_CONFIG,
  deriveBaselines,
  hasEnoughHistory,
  hasEnoughSampleToday,
  isImprovement,
  isJudgeable,
  medianAbsoluteDeviation,
  type BaselineHistoryDay,
} from "../baseline-engine";
// The median the baseline engine reuses rather than redefining. Pinned here
// because the bands rest on it, and a change to it would change every baseline.
import { median } from "../../metrics/support/windows";

const CLINIC = "clinic_baseline";
const DATE = "2026-09-12";
const KEY = MetricKey.SCHEDULING_NO_SHOW_RATE_30D;

/**
 * Appointments behind each day's rate, unless a test says otherwise.
 *
 * KEY is a rate, and in production it never travels without its denominator. 90
 * is comfortably past the 50 the rule asks for, so every test that is not ABOUT
 * the denominator reads exactly as it did before the rule existed.
 */
const AMPLE = 90;

/** History days counting back from the day before DATE, oldest first. */
function history(
  values: readonly number[],
  key: string = KEY,
  /** Appointments behind each day, in the same order. */
  denominators?: readonly number[],
): BaselineHistoryDay[] {
  return values.map((value, i) => {
    const day = `2026-09-${String(12 - values.length + i).padStart(2, "0")}`;
    const asOf = `${day}T18:00:00.000Z`;
    const denominator = denominators === undefined ? AMPLE : denominators[i];
    return {
      date: day,
      metrics: [
        buildMetric(key as MetricKey, value, CLINIC, day, asOf),
        ...(denominator === undefined
          ? []
          : [
              buildMetric(
                MetricKey.SCHEDULING_APPOINTMENTS_30D,
                denominator,
                CLINIC,
                day,
                asOf,
              ),
            ]),
      ],
    };
  });
}

function todayIs(value: number, key: string = KEY, denominator: number | null = AMPLE) {
  const asOf = `${DATE}T18:00:00.000Z`;
  return [
    buildMetric(key as MetricKey, value, CLINIC, DATE, asOf),
    ...(denominator === null
      ? []
      : [buildMetric(MetricKey.SCHEDULING_APPOINTMENTS_30D, denominator, CLINIC, DATE, asOf)]),
  ];
}

function baselineFor(
  values: readonly number[],
  current?: number,
  key: string = KEY,
) {
  const result = deriveBaselines({
    history: history(values, key),
    current: current === undefined ? [] : todayIs(current, key),
  });
  return result.byKey.get(key);
}

// ── The statistics themselves ────────────────────────────────────────────────

describe("median", () => {
  it("takes the middle value of an odd-length series", () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it("averages the two middle values of an even-length series", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("is unmoved by an extreme outlier, which is why it is used at all", () => {
    // One implant month, or one Saturday closure. A mean of this series is 28.4;
    // the median is 10, which is what the clinic would recognise as normal.
    expect(median([9, 10, 10, 11, 102])).toBe(10);
  });

  it("does not mutate the caller's array", () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe("medianAbsoluteDeviation", () => {
  it("measures the typical distance from the middle", () => {
    // Distances from the median of 10 are 1, 0, 0, 1, 92 -> median 1.
    expect(medianAbsoluteDeviation([9, 10, 10, 11, 102])).toBe(1);
  });

  it("is zero for a series that never varies", () => {
    // Returned RAW. The flooring that stops this collapsing the band happens in
    // deriveBaselines and is recorded separately, so both facts stay visible.
    expect(medianAbsoluteDeviation([4, 4, 4, 4, 4, 4])).toBe(0);
  });
});

// ── Small data ───────────────────────────────────────────────────────────────

describe("insufficient history", () => {
  it("produces no baseline at all below the minimum observations", () => {
    const result = deriveBaselines({ history: history([10, 11]), current: todayIs(3) });
    expect(result.baselines).toEqual([]);
    expect(result.byKey.get(KEY)).toBeUndefined();
    // Named, not silently dropped: a caller can tell the metric was seen and
    // withheld from one it never had.
    expect(result.withheldKeys).toContain(KEY);
  });

  it("marks three to five observations as thin, and thin is not judgeable", () => {
    const baseline = baselineFor([10, 11, 12], 3);
    expect(baseline?.quality).toBe(BaselineQuality.THIN);
    expect(isJudgeable(baseline!)).toBe(false);
  });

  it("marks six observations as adequate — the small-data rule's own line", () => {
    const baseline = baselineFor([10, 11, 12, 10, 11, 12], 3);
    expect(baseline?.quality).toBe(BaselineQuality.ADEQUATE);
    expect(isJudgeable(baseline!)).toBe(true);
  });

  it("marks fourteen observations as strong", () => {
    const baseline = baselineFor(Array.from({ length: 14 }, () => 10), 3);
    expect(baseline?.quality).toBe(BaselineQuality.STRONG);
  });

  it("reports confidence from the quality band, never from the numbers", () => {
    // Confidence here is data completeness. A tight band over four days is not
    // more trustworthy than a loose one over a month, and must not read as such.
    const thin = baselineFor([10, 10, 10], 3);
    const strong = baselineFor(Array.from({ length: 20 }, () => 10), 3);
    expect(thin?.confidence).toBe(DEFAULT_BASELINE_CONFIG.confidenceByQuality.thin);
    expect(strong?.confidence).toBe(DEFAULT_BASELINE_CONFIG.confidenceByQuality.strong);
  });
});

// ── Outliers and the zero-MAD trap ───────────────────────────────────────────

describe("outlier handling", () => {
  it("keeps the band where the clinic actually runs, despite one extreme day", () => {
    // A mean/stddev band over this series would centre near 24 and be wide enough
    // to swallow everything. The median stays at 10.
    const baseline = baselineFor([9, 10, 10, 11, 10, 102], 10);
    expect(baseline?.median).toBe(10);
    expect(baseline?.position).toBe("inside");
  });

  it("does not widen the band just because an outlier appeared", () => {
    const without = baselineFor([9, 10, 10, 11, 10, 9], 10);
    const withOutlier = baselineFor([9, 10, 10, 11, 10, 9, 102], 10);
    // The MAD absorbs the outlier without growing, so a real change the following
    // week is still detectable. This is the whole argument for MAD over stddev.
    expect(withOutlier?.deviation).toBe(without?.deviation);
  });
});

describe("the zero-MAD trap", () => {
  it("floors the deviation so an unvarying series does not make every change an anomaly", () => {
    // Six identical days. Raw MAD is 0; an unfloored band would be [10, 10] and
    // the next value of 11 would read as "outside this clinic's normal range".
    const baseline = baselineFor([10, 10, 10, 10, 10, 10], 11);
    expect(baseline?.mad).toBe(0);
    expect(baseline?.deviation).toBeGreaterThan(0);
    expect(baseline?.position).toBe("inside");
  });

  it("records the raw MAD alongside the floored deviation", () => {
    // Both facts stay visible: the clinic genuinely did not vary, AND the band
    // was widened. Collapsing them into one number would hide the widening.
    const baseline = baselineFor([4, 4, 4, 4, 4, 4], 4);
    expect(baseline?.mad).toBe(0);
    expect(baseline?.deviation).toBe(DEFAULT_BASELINE_CONFIG.absoluteDeviationFloor);
  });

  it("floors relative to the median, so the band scales with the metric", () => {
    // An unvarying ₹200,000 outstanding balance must not get the same ±0.5 band
    // as an unvarying count of 4 overdue recalls.
    const large = baselineFor(
      Array.from({ length: 8 }, () => 200_000),
      200_000,
      MetricKey.REVENUE_OUTSTANDING,
    );
    expect(large?.deviation).toBe(200_000 * DEFAULT_BASELINE_CONFIG.relativeDeviationFloor);
  });

  it("uses the absolute floor when the median is zero and a relative floor collapses too", () => {
    const zero = baselineFor([0, 0, 0, 0, 0, 0], 1, MetricKey.FOLLOWUPS_OVERDUE);
    expect(zero?.deviation).toBe(DEFAULT_BASELINE_CONFIG.absoluteDeviationFloor);
  });
});

// ── The band, and where today sits ───────────────────────────────────────────

describe("the normal band", () => {
  it("places a value inside, above or below its own range", () => {
    const values = [10, 12, 11, 13, 10, 12];
    expect(baselineFor(values, 11)?.position).toBe("inside");
    expect(baselineFor(values, 40)?.position).toBe("above");
    expect(baselineFor(values, 1)?.position).toBe("below");
  });

  it("reports the delta and its share of the median", () => {
    const baseline = baselineFor([10, 10, 10, 10, 10, 10], 4);
    expect(baseline?.median).toBe(10);
    expect(baseline?.delta).toBe(-6);
    expect(baseline?.deltaPercent).toBe(-60);
  });

  it("withholds deltaPercent rather than dividing by a zero median", () => {
    const baseline = baselineFor([0, 0, 0, 0, 0, 0], 3, MetricKey.FOLLOWUPS_OVERDUE);
    expect(baseline?.delta).toBe(3);
    expect(baseline?.deltaPercent).toBeNull();
  });

  it("keeps a baseline for a metric not measured today, with a null current", () => {
    // Null, never zero. A metric the clinic could not measure today has not
    // fallen to nothing.
    const baseline = baselineFor([10, 10, 10, 10, 10, 10]);
    expect(baseline?.current).toBeNull();
    expect(baseline?.delta).toBeNull();
    expect(baseline?.position).toBeNull();
    expect(baseline?.consecutiveOutside).toBe(0);
  });
});

describe("consecutive days outside the band", () => {
  it("is zero when today is inside the range", () => {
    expect(baselineFor([10, 10, 10, 10, 10, 10], 10)?.consecutiveOutside).toBe(0);
  });

  it("counts today alone when only today has broken out", () => {
    expect(baselineFor([10, 10, 10, 10, 10, 10], 3)?.consecutiveOutside).toBe(1);
  });

  it("counts the run of recent days on the same side, today included", () => {
    // Four settled days at 10, then two at 3, then today at 3 -> 3 days running.
    expect(baselineFor([10, 10, 10, 10, 3, 3], 3)?.consecutiveOutside).toBe(3);
  });

  it("does not count a day that broke out on the OTHER side", () => {
    // Yesterday was unusually high; today is unusually low. That is not a
    // two-day run of improvement, and counting it as one would invent a trend.
    const baseline = baselineFor([10, 10, 10, 10, 10, 40], 3);
    expect(baseline?.consecutiveOutside).toBe(1);
  });
});

// ── Direction ────────────────────────────────────────────────────────────────

describe("isImprovement", () => {
  it("reads a fall as good for a lower-is-better metric", () => {
    const baseline = baselineFor([10, 10, 10, 10, 10, 10], 3)!;
    expect(isImprovement(baseline, BaselineDirection.LOWER_IS_BETTER)).toBe(true);
    expect(isImprovement(baseline, BaselineDirection.HIGHER_IS_BETTER)).toBe(false);
  });

  it("reads a rise as good for a higher-is-better metric", () => {
    const baseline = baselineFor([50, 50, 50, 50, 50, 50], 80)!;
    expect(isImprovement(baseline, BaselineDirection.HIGHER_IS_BETTER)).toBe(true);
    expect(isImprovement(baseline, BaselineDirection.LOWER_IS_BETTER)).toBe(false);
  });

  it("is never true for a value inside the normal range", () => {
    const baseline = baselineFor([10, 11, 10, 12, 10, 11], 10)!;
    expect(isImprovement(baseline, BaselineDirection.LOWER_IS_BETTER)).toBe(false);
  });
});

// ── Determinism and hygiene ──────────────────────────────────────────────────

describe("determinism", () => {
  it("ignores the order history was loaded in", () => {
    const days = history([9, 14, 10, 12, 11, 13]);
    const forward = deriveBaselines({ history: days, current: todayIs(11) });
    const backward = deriveBaselines({ history: [...days].reverse(), current: todayIs(11) });
    expect(backward.baselines).toEqual(forward.baselines);
  });

  it("keeps the last entry when a date is supplied twice", () => {
    // A caller re-supplying a day is correcting it, the same rule the
    // persistence window applies.
    const days = history([10, 10, 10, 10, 10, 10]);
    const corrected: BaselineHistoryDay[] = [
      ...days,
      { date: days[0].date, metrics: todayIs(999) },
    ];
    const result = deriveBaselines({ history: corrected, current: todayIs(10) });
    expect(result.byKey.get(KEY)?.observations).toBe(6);
  });

  it("excludes today from the band it is judged against", () => {
    // Folding today in would pull the median toward it and understate every
    // change — a self-comparison dressed as a baseline.
    const baseline = baselineFor([10, 10, 10, 10, 10, 10], 3);
    expect(baseline?.median).toBe(10);
    expect(baseline?.observations).toBe(6);
  });

  it("skips non-finite values rather than poisoning the series", () => {
    const days = history([10, 10, 10, 10, 10, 10]);
    days.push({
      date: "2026-09-11",
      metrics: [buildMetric(KEY, Number.NaN, CLINIC, "2026-09-11", "2026-09-11T18:00:00.000Z")],
    });
    const result = deriveBaselines({ history: days, current: todayIs(10) });
    expect(result.byKey.get(KEY)?.median).toBe(10);
  });

  it("sorts output by key so two runs over the same data are identical", () => {
    const days: BaselineHistoryDay[] = Array.from({ length: 6 }, (_, i) => {
      const day = `2026-09-0${i + 1}`;
      return {
        date: day,
        metrics: [
          buildMetric(MetricKey.REVENUE_OUTSTANDING, 5000, CLINIC, day, `${day}T18:00:00.000Z`),
          buildMetric(KEY, 10, CLINIC, day, `${day}T18:00:00.000Z`),
          buildMetric(MetricKey.FOLLOWUPS_OVERDUE, 4, CLINIC, day, `${day}T18:00:00.000Z`),
        ],
      };
    });
    const keys = deriveBaselines({ history: days, current: [] }).baselines.map((b) => b.key);
    expect(keys).toEqual([...keys].sort());
  });
});

// ── Denominators, and the bands that ran off the end of the scale ────────────

describe("rates with too little behind them", () => {
  /**
   * This is the defect the rule exists for, reproduced.
   *
   * Five appointments a week: one missed appointment is twenty points, so the
   * spread of those swings became the band, and the band ran from below zero to
   * two thirds of the appointment book. Both ends are wrong — a clinic cannot
   * miss a negative share of its appointments — and the whole range is an
   * artefact of the denominator rather than a description of the clinic.
   */
  it("excludes days whose denominator was too small to carry a rate", () => {
    const tiny = [0, 20, 0, 0, 40, 0, 20, 0];
    const result = deriveBaselines({
      history: history(tiny, KEY, tiny.map(() => 5)),
      current: todayIs(20, KEY, 5),
    });

    expect(result.byKey.get(KEY)).toBeUndefined();
    const withheld = result.withheldByKey.get(KEY);
    expect(withheld?.reason).toBe(BaselineWithholdReason.SAMPLE_TOO_SMALL);
    // Says both halves: it WAS measured, on every one of those days, and none of
    // them could carry the rate. "No history" would be the wrong sentence.
    expect(withheld?.daysSeen).toBe(8);
    expect(withheld?.daysUsable).toBe(0);
    expect(withheld?.minimumSample).toBe(50);
  });

  it("builds the band from the days that qualify and ignores the rest", () => {
    // Six ordinary weeks at 10%, plus two quiet days where one missed
    // appointment out of four read as 25%. Before the rule those two days
    // doubled the band; now they are not evidence about the rate at all.
    const values = [10, 10, 11, 9, 10, 10, 25, 25];
    const denominators = [90, 88, 91, 87, 92, 90, 4, 4];
    const baseline = deriveBaselines({
      history: history(values, KEY, denominators),
      current: todayIs(10),
    }).byKey.get(KEY);

    expect(baseline?.observations).toBe(6);
    expect(baseline?.median).toBe(10);
    expect(baseline?.sample?.daysExcluded).toBe(2);
    expect(baseline?.sample?.median).toBe(90);
  });

  it("keeps the band but refuses to judge TODAY against it on a thin day", () => {
    const baseline = deriveBaselines({
      history: history([10, 10, 11, 9, 10, 10]),
      // Four appointments today, one missed: 25%, and meaningless.
      current: todayIs(25, KEY, 4),
    }).byKey.get(KEY);

    // The band is solid. It is this DAY that cannot be compared against it, and
    // the two questions are answered separately.
    expect(hasEnoughHistory(baseline!)).toBe(true);
    expect(hasEnoughSampleToday(baseline!)).toBe(false);
    expect(isJudgeable(baseline!)).toBe(false);
    expect(baseline?.sample?.current).toBe(4);
    expect(baseline?.sample?.minimum).toBe(50);
    // Still measured, still positioned. Withholding the READING would be a
    // different and wrong answer: the clinic really did miss one of four.
    expect(baseline?.current).toBe(25);
    expect(baseline?.position).toBe("above");
  });

  it("refuses to judge a day whose denominator was never measured", () => {
    const baseline = deriveBaselines({
      history: history([10, 10, 11, 9, 10, 10]),
      current: todayIs(25, KEY, null),
    }).byKey.get(KEY);

    expect(baseline?.sample?.current).toBeNull();
    expect(hasEnoughSampleToday(baseline!)).toBe(false);
  });

  it("leaves metrics that are not rates alone", () => {
    // A count of overdue recalls has no denominator that could be thin, so it
    // must not acquire one by accident.
    const baseline = deriveBaselines({
      history: history([4, 5, 4, 6, 4, 5], MetricKey.FOLLOWUPS_OVERDUE, []),
      current: todayIs(2, MetricKey.FOLLOWUPS_OVERDUE, null),
    }).byKey.get(MetricKey.FOLLOWUPS_OVERDUE);

    expect(baseline?.sample).toBeNull();
    expect(isJudgeable(baseline!)).toBe(true);
  });
});

describe("bands stay inside the scale", () => {
  it("never reports a negative share of the appointment book", () => {
    const baseline = deriveBaselines({
      history: history([1, 0, 2, 0, 3, 0]),
      current: todayIs(1),
    }).byKey.get(KEY);

    expect(baseline?.lower).toBe(0);
    expect(baseline?.clamped).toBe(true);
    // Today at 1% sits inside a band the clamp did not distort: the reading is
    // unchanged, only the impossible end of the range was cut.
    expect(baseline?.position).toBe("inside");
  });

  it("never reports more than the whole book being missed", () => {
    const baseline = deriveBaselines({
      history: history([96, 97, 98, 97, 96, 99]),
      current: todayIs(97),
    }).byKey.get(KEY);

    expect(baseline?.upper).toBe(100);
    expect(baseline?.clamped).toBe(true);
  });

  it("floors a count at zero", () => {
    const baseline = deriveBaselines({
      history: history([1, 0, 1, 0, 1, 0], MetricKey.FOLLOWUPS_OVERDUE, []),
      current: todayIs(0, MetricKey.FOLLOWUPS_OVERDUE, null),
    }).byKey.get(MetricKey.FOLLOWUPS_OVERDUE);

    expect(baseline?.lower).toBe(0);
  });

  it("leaves a signed percentage signed", () => {
    // Appointment overrun is a divergence, not a share: finishing early is a
    // negative reading and clamping it at zero would erase half the metric.
    const key = MetricKey.SCHEDULING_APPOINTMENT_OVERRUN_30D;
    const baseline = deriveBaselines({
      history: history([-5, -4, -6, -5, -4, -5], key, []).map((day, i) => ({
        ...day,
        metrics: [
          ...day.metrics,
          buildMetric(
            MetricKey.SCHEDULING_MEASURED_VISITS_30D,
            40,
            CLINIC,
            day.date,
            `${day.date}T18:00:00.000Z`,
          ),
        ],
        ...(i === -1 ? {} : {}),
      })),
      current: [
        ...todayIs(-5, key, null),
        buildMetric(
          MetricKey.SCHEDULING_MEASURED_VISITS_30D,
          40,
          CLINIC,
          DATE,
          `${DATE}T18:00:00.000Z`,
        ),
      ],
    }).byKey.get(key);

    expect(baseline?.lower).toBeLessThan(0);
    expect(baseline?.clamped).toBe(false);
  });
});

// ── Multi-clinic isolation ───────────────────────────────────────────────────

describe("multi-clinic isolation", () => {
  it("derives from the metrics it was handed, never from another clinic's ids", () => {
    // The engine is pure and clinic-agnostic by design — the caller scopes the
    // history. This pins the property that matters: two clinics' identical data
    // yield identical bands, and one clinic's values cannot reach the other's.
    const quiet = deriveBaselines({
      history: history([4, 4, 5, 4, 5, 4]),
      current: todayIs(4),
    });
    const busy = deriveBaselines({
      history: history([28, 30, 29, 31, 30, 29]),
      current: todayIs(29),
    });

    expect(quiet.byKey.get(KEY)?.median).toBe(4);
    expect(busy.byKey.get(KEY)?.median).toBe(29.5);
    // The quiet clinic's normal day is far outside the busy clinic's band, and
    // vice versa — which is the entire point of a per-clinic baseline.
    expect(quiet.byKey.get(KEY)?.position).toBe("inside");
    expect(busy.byKey.get(KEY)?.position).toBe("inside");
  });
});
