/**
 * Clinic Score v2 — two-sided, dimensioned, and with a derived movement.
 *
 * The v1 suite (`clinic-health.spec.ts`) still passes untouched, and that is an
 * assertion in itself: with no baselines supplied the score is exactly the
 * deduction ledger it always was. Everything here is about what was ADDED.
 *
 * Three properties get the most attention, because each one is a way the score
 * could quietly start lying:
 *
 *   - **Un-gameable.** A credit must come from a measurement, never from a
 *     clinic having done something on screen.
 *   - **Unmeasured is not perfect.** A dimension nobody could measure must not
 *     score 100, and must not contribute to a movement.
 *   - **Derived, not stored.** The earlier score is recomputed from the earlier
 *     day's metrics through the same rubric, so the two sides are comparable.
 */

import { describe, expect, it } from "vitest";

import { ClinicDimension } from "@/business-brain";
import { buildMetric, MetricKey } from "@/business-brain/engines/metrics/metric-ids";
import {
  BaselineQuality,
  type MetricBaseline,
} from "@/business-brain/engines/baseline";
import {
  compareClinicHealth,
  computeClinicHealth,
  DIMENSION_LABEL,
  SCORE_DIMENSIONS,
  withDelta,
  type HealthContext,
} from "../clinic-health";

const CLINIC = "clinic_score";
const DATE = "2026-09-12";

type Values = Partial<Record<string, number>>;

function metrics(values: Values, date = DATE) {
  return Object.entries(values).map(([key, value]) =>
    buildMetric(key as MetricKey, value as number, CLINIC, date, `${date}T18:00:00.000Z`),
  );
}

/** A judgeable baseline whose current value beats the band in the good direction. */
function beating(key: string, median: number, current: number): MetricBaseline {
  const halfWidth = Math.max(Math.abs(median) * 0.1, 0.5) * 2;
  return {
    key,
    current,
    median,
    mad: 0,
    deviation: halfWidth / 2,
    lower: median - halfWidth,
    upper: median + halfWidth,
    delta: current - median,
    deltaPercent: null,
    observations: 12,
    // Not a rate as far as this fixture is concerned: the scorer reads position
    // and quality, never the denominator.
    sample: null,
    clamped: false,
    quality: BaselineQuality.ADEQUATE,
    position: current < median - halfWidth ? "below" : current > median + halfWidth ? "above" : "inside",
    consecutiveOutside: 3,
    confidence: 0.7,
  };
}

function ctxWith(...baselines: MetricBaseline[]): HealthContext {
  return { baselines: new Map(baselines.map((b) => [b.key, b])) };
}

/** A clinic with two real problems, so credits have something to sit beside. */
const TROUBLED: Values = {
  [MetricKey.REVENUE_OUTSTANDING]: 30_000,
  [MetricKey.FOLLOWUPS_OVERDUE]: 3,
};

// ── Backwards compatibility ──────────────────────────────────────────────────

describe("without baselines, v2 is v1", () => {
  it("scores identically and reports no credits", () => {
    // 30,000 outstanding is -12; 3 overdue recalls is -9. Exactly the v1 ledger.
    const health = computeClinicHealth(metrics(TROUBLED));
    expect(health.score).toBe(79);
    expect(health.credits).toEqual([]);
    expect(health.deductions).toHaveLength(2);
  });

  it("is what a clinic with too little history gets, which is correct", () => {
    // Not a penalty for being new: the deduction ledger is a complete, honest
    // score on its own. Credits are an addition for clinics that have a normal.
    const withoutBaselines = computeClinicHealth(metrics(TROUBLED));
    const withEmptyBaselines = computeClinicHealth(metrics(TROUBLED), { baselines: new Map() });
    expect(withEmptyBaselines.score).toBe(withoutBaselines.score);
  });
});

// ── The credit side ──────────────────────────────────────────────────────────

describe("credits", () => {
  it("adds points when a metric beats this clinic's own normal range", () => {
    const health = computeClinicHealth(
      metrics({ ...TROUBLED, [MetricKey.SCHEDULING_NO_SHOW_RATE_30D]: 5 }),
      ctxWith(beating(MetricKey.SCHEDULING_NO_SHOW_RATE_30D, 14, 5)),
    );
    expect(health.credits).toHaveLength(1);
    expect(health.credits[0]).toMatchObject({
      points: 4,
      dimension: ClinicDimension.ATTENDANCE,
    });
    // 79 from the debits, plus 4.
    expect(health.score).toBe(83);
  });

  it("states the measurement in the credit's own line, checkable in ten seconds", () => {
    const health = computeClinicHealth(
      metrics(TROUBLED),
      ctxWith(beating(MetricKey.SCHEDULING_NO_SHOW_RATE_30D, 14, 5)),
    );
    expect(health.credits[0]?.detail).toContain("5%");
    expect(health.credits[0]?.detail).toContain("14%");
  });

  it("awards nothing for sitting inside the normal range — that is what normal means", () => {
    const health = computeClinicHealth(
      metrics(TROUBLED),
      ctxWith(beating(MetricKey.SCHEDULING_NO_SHOW_RATE_30D, 14, 14)),
    );
    expect(health.credits).toEqual([]);
  });

  it("awards nothing from a thin baseline", () => {
    // A baseline that cannot establish normal cannot establish that today beat it.
    const thin = { ...beating(MetricKey.SCHEDULING_NO_SHOW_RATE_30D, 14, 5), quality: BaselineQuality.THIN, observations: 3 };
    const health = computeClinicHealth(metrics(TROUBLED), ctxWith(thin));
    expect(health.credits).toEqual([]);
  });

  it("awards nothing when the metric moved the WRONG way", () => {
    const health = computeClinicHealth(
      metrics(TROUBLED),
      ctxWith(beating(MetricKey.SCHEDULING_NO_SHOW_RATE_30D, 8, 30)),
    );
    expect(health.credits).toEqual([]);
  });

  it("caps the total so a clinic can never credit its way out of real problems", () => {
    // Every credit factor qualifying at once: 4+4+3+3+2+2 = 18, capped at 12.
    const health = computeClinicHealth(
      metrics(TROUBLED),
      ctxWith(
        beating(MetricKey.SCHEDULING_NO_SHOW_RATE_30D, 14, 4),
        beating(MetricKey.REVENUE_COLLECTION_RATE_30D, 70, 95),
        beating(MetricKey.CAPACITY_CHAIR_UTILIZATION_30D, 50, 80),
        beating(MetricKey.FOLLOWUPS_OVERDUE, 20, 2),
        beating(MetricKey.QUEUE_AVERAGE_WAITING_TIME, 40, 10),
        beating(MetricKey.TREATMENT_ACCEPTED_PENDING_SCHEDULING, 12, 1),
      ),
    );
    const total = health.credits.reduce((sum, c) => sum + c.points, 0);
    expect(total).toBeLessThanOrEqual(12);
    // And the points each line claims still add up to the score — the cap trims
    // whole credits rather than scaling them, so no line lies about its own value.
    const debits = health.deductions.reduce((sum, d) => sum + d.points, 0);
    expect(health.score).toBe(100 - debits + total);
  });

  it("cannot be moved by anything a user does on screen", () => {
    // The un-gameable property, asserted directly: every credit is a function of
    // the metrics and the baselines. There is no input for "action completed",
    // so completing one changes the score only by changing the data.
    const before = computeClinicHealth(
      metrics({ ...TROUBLED, [MetricKey.FOLLOWUPS_OVERDUE]: 8 }),
      ctxWith(beating(MetricKey.FOLLOWUPS_OVERDUE, 20, 8)),
    );
    const afterDataChanged = computeClinicHealth(
      metrics({ ...TROUBLED, [MetricKey.FOLLOWUPS_OVERDUE]: 2 }),
      ctxWith(beating(MetricKey.FOLLOWUPS_OVERDUE, 20, 2)),
    );
    expect(afterDataChanged.score).toBeGreaterThan(before.score);
  });
});

// ── Dimensions ───────────────────────────────────────────────────────────────

describe("dimensions", () => {
  it("always reports all six, and only those six", () => {
    const health = computeClinicHealth(metrics(TROUBLED));
    expect(health.dimensions.map((d) => d.dimension)).toEqual(SCORE_DIMENSIONS);
    expect(health.dimensions).toHaveLength(6);
  });

  it("does not include an Acquisition dimension", () => {
    // One noisy daily count is not a dimension. Explicitly pinned so nobody adds
    // it back without reading why.
    const labels = computeClinicHealth(metrics(TROUBLED)).dimensions.map((d) => d.label);
    expect(labels).not.toContain("Acquisition");
    expect(labels).toEqual(SCORE_DIMENSIONS.map((d) => DIMENSION_LABEL[d]));
  });

  it("groups each itemised line under the dimension its category belongs to", () => {
    const health = computeClinicHealth(metrics(TROUBLED));
    const financial = health.dimensions.find(
      (d) => d.dimension === ClinicDimension.FINANCIAL_HEALTH,
    );
    const retention = health.dimensions.find(
      (d) => d.dimension === ClinicDimension.RETENTION_RECALL,
    );
    expect(financial?.debits).toBe(12);
    expect(retention?.debits).toBe(9);
    expect(financial?.score).toBe(88);
  });

  it("marks a dimension nobody could measure as unmeasured, not as perfect", () => {
    // The most flattering possible lie: a clinic that never used the queue
    // reading 100 on Patient flow. Withheld is not zero, and it is not 100.
    const health = computeClinicHealth(metrics(TROUBLED));
    const flow = health.dimensions.find((d) => d.dimension === ClinicDimension.PATIENT_FLOW);
    expect(flow?.measured).toBe(false);
  });

  it("marks a dimension as measured when its metric produced a value, even a good one", () => {
    const health = computeClinicHealth(
      metrics({ ...TROUBLED, [MetricKey.QUEUE_AVERAGE_WAITING_TIME]: 8 }),
    );
    const flow = health.dimensions.find((d) => d.dimension === ClinicDimension.PATIENT_FLOW);
    expect(flow?.measured).toBe(true);
    // Measured and clean: no debit, so full marks — which is a real statement
    // here in a way it would not be for an unmeasured dimension.
    expect(flow?.score).toBe(100);
  });

  it("folds credits into their dimension's score", () => {
    const health = computeClinicHealth(
      metrics({ ...TROUBLED, [MetricKey.FOLLOWUPS_OVERDUE]: 3 }),
      ctxWith(beating(MetricKey.SCHEDULING_NO_SHOW_RATE_30D, 14, 5)),
    );
    const attendance = health.dimensions.find(
      (d) => d.dimension === ClinicDimension.ATTENDANCE,
    );
    expect(attendance?.credits).toBe(4);
    expect(attendance?.measured).toBe(true);
  });
});

// ── The movement ─────────────────────────────────────────────────────────────

describe("score deltas", () => {
  const since = { date: "2026-09-05", daysAgo: 7 };

  it("reports the signed movement and the earlier score", () => {
    const previous = computeClinicHealth(
      metrics({ [MetricKey.REVENUE_OUTSTANDING]: 60_000, [MetricKey.FOLLOWUPS_OVERDUE]: 5 }),
    );
    const current = computeClinicHealth(metrics({ [MetricKey.REVENUE_OUTSTANDING]: 12_000 }));
    const delta = compareClinicHealth(current, previous, since);

    // Previously -18 and -15 => 67. Now -6 => 94.
    expect(delta.previousScore).toBe(67);
    expect(delta.points).toBe(27);
    expect(delta.since).toBe("2026-09-05");
    expect(delta.daysAgo).toBe(7);
  });

  it("names the dimensions that moved, largest first", () => {
    const previous = computeClinicHealth(
      metrics({ [MetricKey.REVENUE_OUTSTANDING]: 60_000, [MetricKey.FOLLOWUPS_OVERDUE]: 5 }),
    );
    const current = computeClinicHealth(
      metrics({ [MetricKey.REVENUE_OUTSTANDING]: 12_000, [MetricKey.FOLLOWUPS_OVERDUE]: 5 }),
    );
    const delta = compareClinicHealth(current, previous, since);

    expect(delta.contributors).toHaveLength(1);
    expect(delta.contributors[0]).toMatchObject({
      dimension: ClinicDimension.FINANCIAL_HEALTH,
      label: "Financial health",
      points: 12,
    });
  });

  it("reports a negative movement as negative", () => {
    const previous = computeClinicHealth(metrics({ [MetricKey.REVENUE_OUTSTANDING]: 12_000 }));
    const current = computeClinicHealth(metrics({ [MetricKey.REVENUE_OUTSTANDING]: 60_000 }));
    const delta = compareClinicHealth(current, previous, since);
    expect(delta.points).toBe(-12);
    expect(delta.contributors[0]?.points).toBe(-12);
  });

  it("omits a dimension that was unmeasured on either side", () => {
    // A dimension measured today and not last week would otherwise appear to
    // have swung from 100 — a movement manufactured entirely from a data gap.
    const previous = computeClinicHealth(metrics({ [MetricKey.REVENUE_OUTSTANDING]: 12_000 }));
    const current = computeClinicHealth(
      metrics({
        [MetricKey.REVENUE_OUTSTANDING]: 12_000,
        [MetricKey.QUEUE_AVERAGE_WAITING_TIME]: 45,
      }),
    );
    const delta = compareClinicHealth(current, previous, since);
    expect(delta.contributors.map((c) => c.dimension)).not.toContain(
      ClinicDimension.PATIENT_FLOW,
    );
  });

  it("omits dimensions that did not move at all", () => {
    const same = metrics(TROUBLED);
    const delta = compareClinicHealth(
      computeClinicHealth(same),
      computeClinicHealth(same),
      since,
    );
    expect(delta.points).toBe(0);
    expect(delta.contributors).toEqual([]);
  });

  it("attaches to a score without recomputing it", () => {
    // withDelta is deliberately separate so the score itself stays a pure
    // function of one day's metrics — the property that stops it drifting.
    const health = computeClinicHealth(metrics(TROUBLED));
    const previous = computeClinicHealth(metrics({ [MetricKey.REVENUE_OUTSTANDING]: 60_000 }));
    const withMovement = withDelta(health, compareClinicHealth(health, previous, since));
    expect(withMovement.score).toBe(health.score);
    expect(withMovement.delta?.points).toBe(health.score - previous.score);
  });

  it("is derived from stored metrics, needing no stored score", () => {
    // The whole mechanism: an earlier day's metrics through the SAME rubric. This
    // is what makes "82 up 6" possible with no new table and no write.
    const storedLastWeek = metrics(
      { [MetricKey.REVENUE_OUTSTANDING]: 60_000 },
      "2026-09-05",
    );
    const previous = computeClinicHealth(storedLastWeek);
    const current = computeClinicHealth(metrics({ [MetricKey.REVENUE_OUTSTANDING]: 8_000 }));
    expect(compareClinicHealth(current, previous, since).points).toBe(16);
  });
});

// ── Multi-clinic isolation ───────────────────────────────────────────────────

describe("multi-clinic isolation", () => {
  it("reads only the metrics it was handed", () => {
    // The score is a pure function of its arguments, so isolation is the caller's
    // job — but a regression that made it reach for anything ambient would show
    // up here as two clinics scoring the same.
    const quiet = computeClinicHealth(
      metrics({ [MetricKey.REVENUE_OUTSTANDING]: 2_000 }),
    );
    const struggling = computeClinicHealth(
      metrics({ [MetricKey.REVENUE_OUTSTANDING]: 80_000, [MetricKey.FOLLOWUPS_OVERDUE]: 6 }),
    );
    expect(quiet.score).toBe(98);
    expect(struggling.score).toBe(67);
  });

  it("credits one clinic's baseline without touching another's score", () => {
    const shared = metrics({
      [MetricKey.REVENUE_OUTSTANDING]: 30_000,
      [MetricKey.SCHEDULING_NO_SHOW_RATE_30D]: 5,
    });
    // Clinic A normally runs at 14% no-shows, so 5% is a genuine improvement.
    const a = computeClinicHealth(shared, ctxWith(beating(MetricKey.SCHEDULING_NO_SHOW_RATE_30D, 14, 5)));
    // Clinic B normally runs at 5%, so the identical figure earns nothing.
    const b = computeClinicHealth(shared, ctxWith(beating(MetricKey.SCHEDULING_NO_SHOW_RATE_30D, 5, 5)));
    expect(a.credits).toHaveLength(1);
    expect(b.credits).toHaveLength(0);
    expect(a.score).toBeGreaterThan(b.score);
  });
});

// ── Hygiene ──────────────────────────────────────────────────────────────────

describe("determinism", () => {
  it("returns the same result for the same input", () => {
    const input = metrics(TROUBLED);
    const ctx = ctxWith(beating(MetricKey.SCHEDULING_NO_SHOW_RATE_30D, 14, 5));
    expect(computeClinicHealth(input, ctx)).toEqual(computeClinicHealth(input, ctx));
  });

  it("never reports a score outside 0..100", () => {
    const floored = computeClinicHealth(
      metrics({
        [MetricKey.REVENUE_OUTSTANDING]: 500_000,
        [MetricKey.FOLLOWUPS_OVERDUE]: 40,
        [MetricKey.TREATMENT_ACCEPTED_PENDING_SCHEDULING]: 40,
        [MetricKey.SCHEDULING_NO_SHOW_RATE_30D]: 60,
        [MetricKey.CAPACITY_CHAIR_UTILIZATION]: 5,
        [MetricKey.QUEUE_AVERAGE_WAITING_TIME]: 90,
      }),
    );
    expect(floored.score).toBeGreaterThanOrEqual(0);

    const capped = computeClinicHealth(
      metrics({ [MetricKey.SCHEDULING_NO_SHOW_RATE_30D]: 2 }),
      ctxWith(
        beating(MetricKey.SCHEDULING_NO_SHOW_RATE_30D, 14, 2),
        beating(MetricKey.REVENUE_COLLECTION_RATE_30D, 70, 98),
        beating(MetricKey.CAPACITY_CHAIR_UTILIZATION_30D, 50, 82),
      ),
    );
    expect(capped.score).toBeLessThanOrEqual(100);
  });
});
