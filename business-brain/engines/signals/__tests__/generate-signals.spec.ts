import { describe, expect, it } from "vitest";

import { SignalType } from "../../../domain";
import { MetricKey, buildMetric } from "../../metrics/metric-ids";
import { EVALUATORS } from "../evaluators/registry";
import type { SignalEvaluator } from "../evaluators/types";
import { evaluateSignals, generateSignals } from "../generate-signals";
import { SignalCategory } from "../../../domain";
import {
  BUSY_CLINIC,
  CLINIC_ID,
  DATE,
  EMPTY_CLINIC,
  HEALTHY_CLINIC,
  HIGH_CANCELLATION_CLINIC,
  LARGE_PIPELINE_BUSY_CLINIC,
  LARGE_PIPELINE_CLINIC,
  LOW_REVENUE_CLINIC,
  NOW,
  OVERDUE_FOLLOWUPS_CLINIC,
  PARTIAL_METRICS_CLINIC,
  TREND_CURRENT,
  metrics,
  previousMetrics,
  type MetricValues,
} from "./fixtures/metric-fixtures";
import type { Metric } from "../../../domain";

function run(values: MetricValues | Metric[], previous?: Metric[]) {
  return generateSignals({
    metrics: Array.isArray(values) ? values : metrics(values),
    previousMetrics: previous,
    clinicId: CLINIC_ID,
    date: DATE,
    now: NOW,
  });
}

function typesOf(values: MetricValues | Metric[], previous?: Metric[]): string[] {
  return run(values, previous).map((signal) => signal.id.split(":")[0].replace("signal.", ""));
}

function summarise(values: MetricValues | Metric[], previous?: Metric[]) {
  return run(values, previous).map((signal) => ({
    type: signal.id.split(":")[0].replace("signal.", ""),
    severity: signal.severity,
    priority: signal.priority,
    confidence: signal.confidence,
  }));
}

describe("generateSignals — scenarios", () => {
  it("healthy clinic produces no signals", () => {
    expect(run(HEALTHY_CLINIC)).toEqual([]);
  });

  it("busy clinic fires near-capacity and never low utilization", () => {
    expect(summarise(BUSY_CLINIC)).toEqual([
      {
        type: SignalType.OPERATIONAL_NEAR_FULL_CAPACITY,
        severity: "medium",
        priority: "medium",
        confidence: 1,
      },
    ]);
  });

  it("low revenue clinic fires the three financial signals", () => {
    expect(summarise(LOW_REVENUE_CLINIC)).toEqual([
      {
        type: SignalType.REVENUE_COLLECTION_LAGGING_COMPLETIONS,
        severity: "high",
        priority: "high",
        confidence: 1,
      },
      {
        type: SignalType.REVENUE_HIGH_OUTSTANDING,
        severity: "critical",
        priority: "critical",
        confidence: 1,
      },
      {
        type: SignalType.REVENUE_LOW_DAILY_REVENUE,
        severity: "high",
        priority: "high",
        confidence: 1,
      },
    ]);
  });

  it("high cancellation clinic fires both rate signals", () => {
    expect(summarise(HIGH_CANCELLATION_CLINIC)).toEqual([
      {
        type: SignalType.SCHEDULING_HIGH_CANCELLATION_RATE,
        severity: "critical",
        priority: "critical",
        confidence: 1,
      },
      {
        type: SignalType.SCHEDULING_HIGH_NO_SHOW_RATE,
        severity: "high",
        priority: "high",
        confidence: 1,
      },
    ]);
  });

  it("large pipeline clinic stalls only while the schedule is thin", () => {
    expect(summarise(LARGE_PIPELINE_CLINIC)).toEqual([
      {
        type: SignalType.SCHEDULING_LOW_APPOINTMENT_VOLUME,
        severity: "medium",
        priority: "medium",
        confidence: 1,
      },
      {
        type: SignalType.CLINICAL_ACCEPTED_TREATMENTS_UNSCHEDULED,
        severity: "high",
        priority: "high",
        confidence: 1,
      },
      {
        type: SignalType.CLINICAL_LARGE_PENDING_TREATMENT_VALUE,
        severity: "critical",
        priority: "critical",
        confidence: 1,
      },
      {
        type: SignalType.CLINICAL_PIPELINE_STALLED,
        severity: "critical",
        priority: "critical",
        confidence: 0.85,
      },
      {
        type: SignalType.OPERATIONAL_LOW_CHAIR_UTILIZATION,
        severity: "high",
        priority: "high",
        confidence: 1,
      },
    ]);

    expect(typesOf(LARGE_PIPELINE_BUSY_CLINIC)).toEqual([
      SignalType.CLINICAL_ACCEPTED_TREATMENTS_UNSCHEDULED,
      SignalType.CLINICAL_LARGE_PENDING_TREATMENT_VALUE,
    ]);
  });

  it("overdue follow-ups clinic fires the backlog signal", () => {
    expect(summarise(OVERDUE_FOLLOWUPS_CLINIC)).toEqual([
      {
        type: SignalType.RETENTION_FOLLOWUP_BACKLOG,
        severity: "critical",
        priority: "critical",
        confidence: 1,
      },
    ]);
  });

  it("empty clinic produces no criticals and no divide-by-zero", () => {
    const summary = summarise(EMPTY_CLINIC);
    expect(summary).toEqual([
      {
        type: SignalType.SCHEDULING_LOW_APPOINTMENT_VOLUME,
        severity: "high",
        priority: "high",
        confidence: 1,
      },
      {
        type: SignalType.ACQUISITION_LOW_NEW_PATIENTS,
        severity: "medium",
        priority: "medium",
        confidence: 1,
      },
    ]);
    expect(summary.some((s) => s.severity === "critical")).toBe(false);
    const values = JSON.stringify(run(EMPTY_CLINIC));
    expect(values).not.toContain("null");
    expect(values).not.toContain("Infinity");
  });

  it("partial metrics still fire the unaffected evaluators", () => {
    expect(summarise(PARTIAL_METRICS_CLINIC)).toEqual([
      {
        type: SignalType.OPERATIONAL_LONG_WAITING_TIME,
        severity: "high",
        priority: "high",
        confidence: 1,
      },
      {
        type: SignalType.OPERATIONAL_QUEUE_BACKLOG,
        severity: "high",
        priority: "high",
        confidence: 1,
      },
    ]);
  });

  it("empty metrics array returns no signals without throwing", () => {
    const result = evaluateSignals({
      metrics: [],
      clinicId: CLINIC_ID,
      date: DATE,
      now: NOW,
    });
    expect(result.signals).toEqual([]);
    expect(result.error).toBeUndefined();
    // every evaluator skipped for missing metrics, so coverage is 0 — not 1
    expect(result.confidence).toBe(0);
    expect(result.confidenceBasis).toBe("input_coverage");
    // one index trace, one trace per evaluator, one run summary. Derived from the
    // registry: a literal here goes stale the moment a rule is added, and its
    // failure says nothing about the behaviour being tested.
    expect(result.traces).toHaveLength(EVALUATORS.length + 2);
    expect(result.traces.filter((t) => t.reasoning.startsWith("Skipped:"))).toHaveLength(
      EVALUATORS.length,
    );
  });
});

describe("generateSignals — prior period", () => {
  it("fires all three trend evaluators when a prior period is supplied", () => {
    expect(summarise(TREND_CURRENT, previousMetrics())).toEqual([
      {
        type: SignalType.REVENUE_OUTSTANDING_INCREASING,
        severity: "critical",
        priority: "critical",
        confidence: 1,
      },
      {
        type: SignalType.RETENTION_RETURNING_VOLUME_DROPPING,
        severity: "critical",
        priority: "critical",
        confidence: 1,
      },
      {
        type: SignalType.OPERATIONAL_QUEUE_BACKLOG,
        severity: "low",
        priority: "low",
        confidence: 1,
      },
      {
        type: SignalType.OPERATIONAL_QUEUE_BUILDING_UP,
        severity: "critical",
        priority: "critical",
        confidence: 1,
      },
    ]);
  });

  it("skips the trend evaluators when no prior period is supplied", () => {
    expect(typesOf(TREND_CURRENT)).toEqual([SignalType.OPERATIONAL_QUEUE_BACKLOG]);

    const result = evaluateSignals({
      metrics: metrics(TREND_CURRENT),
      clinicId: CLINIC_ID,
      date: DATE,
      now: NOW,
    });
    const trendSteps = [
      SignalType.REVENUE_OUTSTANDING_INCREASING,
      SignalType.RETENTION_RETURNING_VOLUME_DROPPING,
      SignalType.OPERATIONAL_QUEUE_BUILDING_UP,
    ];
    for (const step of trendSteps) {
      const trace = result.traces.find((t) => t.step === step);
      expect(trace?.reasoning).toBe(
        "Skipped: No prior-period metrics were supplied for comparison.",
      );
    }
  });
});

describe("generateSignals — determinism and ordering", () => {
  it("produces byte-identical output on repeated runs", () => {
    const input = {
      metrics: metrics(LARGE_PIPELINE_CLINIC),
      previousMetrics: previousMetrics(),
      clinicId: CLINIC_ID,
      date: DATE,
      now: NOW,
    };
    const first = generateSignals(input);
    const second = generateSignals(input);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.every((s) => s.generatedAt === NOW)).toBe(true);
  });

  it("is insensitive to input metric order", () => {
    const forward = metrics(LOW_REVENUE_CLINIC);
    const reversed = [...forward].reverse();
    expect(generateSignals({
      metrics: reversed,
      clinicId: CLINIC_ID,
      date: DATE,
      now: NOW,
    }).map((s) => s.id)).toEqual(generateSignals({
      metrics: forward,
      clinicId: CLINIC_ID,
      date: DATE,
      now: NOW,
    }).map((s) => s.id));
  });

  it("orders by category then id, not by severity", () => {
    const signals = run(LARGE_PIPELINE_CLINIC);
    const order = [
      SignalCategory.FINANCIAL,
      SignalCategory.SCHEDULING,
      SignalCategory.CLINICAL,
      SignalCategory.RETENTION,
      SignalCategory.OPERATIONAL,
    ];
    const ranks = signals.map((s) => order.indexOf(s.category ?? SignalCategory.OPERATIONAL));
    expect([...ranks]).toEqual([...ranks].sort((a, b) => a - b));
    // severity is deliberately not monotonic in the output
    expect(signals.map((s) => s.severity)).toEqual([
      "medium",
      "high",
      "critical",
      "critical",
      "high",
    ]);
  });

  it("uses stable ids that overwrite rather than duplicate per clinic-day", () => {
    expect(run(OVERDUE_FOLLOWUPS_CLINIC)[0].id).toBe(
      "signal.retention.followup_backlog:clinic_123:2026-07-26",
    );
  });
});

describe("generateSignals — input validation", () => {
  it("rejects metrics from more than one clinic", () => {
    const mixed = [
      ...metrics({ [MetricKey.FOLLOWUPS_OVERDUE]: 22 }),
      ...metrics({ [MetricKey.QUEUE_PATIENTS_WAITING]: 9 }, { clinicId: "clinic_999" }),
    ];
    const result = evaluateSignals({
      metrics: mixed,
      clinicId: CLINIC_ID,
      date: DATE,
      now: NOW,
    });
    expect(result.error?.code).toBe("SIGNAL_ENGINE_MIXED_CLINIC");
    expect(result.signals).toEqual([]);
    expect(generateSignals({ metrics: mixed, clinicId: CLINIC_ID, date: DATE, now: NOW })).toEqual(
      [],
    );
  });

  it("rejects prior-period metrics from another clinic", () => {
    const result = evaluateSignals({
      metrics: metrics(HEALTHY_CLINIC),
      previousMetrics: metrics({ [MetricKey.REVENUE_OUTSTANDING]: 1 }, { clinicId: "other" }),
      clinicId: CLINIC_ID,
      date: DATE,
      now: NOW,
    });
    expect(result.error?.code).toBe("SIGNAL_ENGINE_MIXED_CLINIC");
  });

  it("keeps the latest timestamp for duplicate keys", () => {
    const early = buildMetric(
      MetricKey.FOLLOWUPS_OVERDUE,
      11,
      CLINIC_ID,
      DATE,
      "2026-07-26T09:00:00.000Z",
    );
    const late = buildMetric(
      MetricKey.FOLLOWUPS_OVERDUE,
      40,
      CLINIC_ID,
      DATE,
      "2026-07-26T18:00:00.000Z",
    );
    const forward = run([early, late]);
    const reversed = run([late, early]);
    expect(forward[0].severity).toBe("critical");
    expect(reversed).toEqual(forward);
  });

  it("treats non-finite values as absent and records it in the trace", () => {
    const broken = buildMetric(MetricKey.FOLLOWUPS_OVERDUE, NaN, CLINIC_ID, DATE, NOW);
    const result = evaluateSignals({
      metrics: [broken],
      clinicId: CLINIC_ID,
      date: DATE,
      now: NOW,
    });
    expect(result.signals).toEqual([]);
    const indexTrace = result.traces[0];
    expect(indexTrace.step).toBe("index-metrics");
    expect(indexTrace.evidence[0].description).toContain("not finite");
    expect(
      result.traces.find((t) => t.step === SignalType.RETENTION_FOLLOWUP_BACKLOG)?.reasoning,
    ).toContain("Skipped:");
  });

  it("ignores unrecognised metric keys without throwing", () => {
    const unknown: Metric = {
      id: "unknown.metric:clinic_123:2026-07-26",
      name: "Unknown Metric",
      value: 5,
      unit: "count",
      category: "operational",
      timestamp: NOW,
    };
    const result = evaluateSignals({
      metrics: [unknown, ...metrics({ [MetricKey.FOLLOWUPS_OVERDUE]: 22 })],
      clinicId: CLINIC_ID,
      date: DATE,
      now: NOW,
    });
    expect(result.signals).toHaveLength(1);
    expect(result.traces[0].evidence.some((e) => e.description.includes("unrecognised"))).toBe(
      true,
    );
  });
});

describe("generateSignals — failure isolation", () => {
  it("catches a throwing evaluator and keeps the run alive", () => {
    const broken: SignalEvaluator = {
      type: SignalType.REVENUE_HIGH_OUTSTANDING,
      category: SignalCategory.FINANCIAL,
      requiredMetrics: [],
      evaluate() {
        throw new Error("boom");
      },
    };
    const working: SignalEvaluator = {
      type: SignalType.RETENTION_FOLLOWUP_BACKLOG,
      category: SignalCategory.RETENTION,
      requiredMetrics: [MetricKey.FOLLOWUPS_OVERDUE],
      evaluate: (ctx) => ({
        kind: "no_signal",
        reason: `evaluated with ${ctx.metrics.size} metric(s)`,
      }),
    };
    const supplied = metrics(HEALTHY_CLINIC);
    const result = evaluateSignals(
      { metrics: supplied, clinicId: CLINIC_ID, date: DATE, now: NOW },
      [broken, working],
    );
    expect(result.error).toBeUndefined();
    expect(result.traces[1].reasoning).toBe("Skipped: evaluator threw (boom).");
    // Derived from the fixture rather than restated: this test is about the
    // surviving evaluator still seeing the full metric set, not about how many
    // metrics the engine happens to define today.
    expect(result.traces[2].reasoning).toContain(
      `evaluated with ${supplied.length} metric(s)`,
    );
  });
});

describe("generateSignals — confidence suppression", () => {
  it("suppresses a signal below the minimum confidence and traces it", () => {
    const staleTimestamp = "2026-07-20T10:00:00.000Z";
    const result = evaluateSignals(
      {
        metrics: metrics({ [MetricKey.FOLLOWUPS_OVERDUE]: 40 }, { date: "2026-07-20", timestamp: staleTimestamp }),
        clinicId: CLINIC_ID,
        date: DATE,
        now: NOW,
        config: { confidence: { stalePeriodPenalty: 0.7, minimumToEmit: 0.5 } },
      },
    );
    expect(result.signals).toEqual([]);
    const trace = result.traces.find(
      (t) => t.step === SignalType.RETENTION_FOLLOWUP_BACKLOG,
    );
    expect(trace?.reasoning).toContain("suppressed: confidence");
  });

  it("applies the stale-period penalty when metrics describe another day", () => {
    const signals = generateSignals({
      metrics: metrics(
        { [MetricKey.FOLLOWUPS_OVERDUE]: 40, [MetricKey.FOLLOWUPS_DUE_TODAY]: 2 },
        { date: "2026-07-20", timestamp: "2026-07-20T10:00:00.000Z" },
      ),
      clinicId: CLINIC_ID,
      date: DATE,
      now: NOW,
    });
    expect(signals[0].confidence).toBe(0.8);
  });

  it("does not treat a metric for today as stale because its UTC instant falls on the previous calendar day", () => {
    // 01:00 in Asia/Kolkata on DATE is 19:30 UTC the day before. The metric
    // describes DATE — its id says so — and must not be docked for the offset.
    const previousUtcDay = `${new Date(Date.parse(`${DATE}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10)}T19:30:00.000Z`;
    const signals = generateSignals({
      metrics: metrics({ [MetricKey.FOLLOWUPS_OVERDUE]: 40, [MetricKey.FOLLOWUPS_DUE_TODAY]: 2 }, { timestamp: previousUtcDay }),
      clinicId: CLINIC_ID,
      date: DATE,
      now: NOW,
    });
    expect(signals[0].confidence).toBe(1);
  });
});
