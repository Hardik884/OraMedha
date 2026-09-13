import { describe, expect, it } from "vitest";

import { DiagnosisPattern, SignalType } from "../../../domain";
import { MetricKey } from "../../metrics/metric-ids";
import { evaluateDiagnoses, diagnose } from "../diagnose";
import type { PatternMatcher } from "../matchers/types";
import { MATCHERS } from "../matchers/registry";
import {
  diagnoseMetrics,
  diagnoseRun,
  discriminatorSlugs,
  evidenceFor,
  patternsOf,
  pick,
} from "./fixtures/diagnose-harness";
import {
  CLINIC_ID,
  CONTRADICTORY,
  DATE,
  DEMAND_SUPPLY_WITH_PENDING,
  HEALTHY,
  ISOLATED_SIGNAL,
  NOW,
  PRIOR,
  metrics,
  run,
} from "./fixtures/run-fixtures";

describe("diagnose — healthy and isolated runs", () => {
  it("returns no diagnoses for a clinic with no signals", () => {
    const result = diagnoseMetrics(HEALTHY);
    expect(result.diagnoses).toEqual([]);
    expect(result.error).toBeUndefined();
    expect(result.confidenceBasis).toBe("matcher_decidability");
    // No prior period was supplied, so the three trend evaluators skipped and the
    // two matchers that require one — patient_base_erosion and
    // recall_process_failure, both of which need returning_volume_dropping —
    // could not be ruled out. Every other matcher ran and measurably found
    // nothing, forward_schedule_gap included: HEALTHY carries a healthy week
    // ahead, so its rule ran.
    //
    // Derived from MATCHERS rather than written as a literal. The old 0.86 was
    // 12/14 and went stale the moment the registry grew — a failure that said
    // nothing about the behaviour under test.
    expect(result.confidence).toBe(
      Math.round(((MATCHERS.length - 2) / MATCHERS.length) * 100) / 100,
    );

    // With a prior period every evaluator reaches a verdict, and a quiet day then
    // legitimately reports full decidability.
    const complete = diagnoseMetrics(HEALTHY, { previous: PRIOR });
    expect(complete.diagnoses).toEqual([]);
    expect(complete.confidence).toBe(1);
  });

  it("carries a single isolated signal forward as one unclustered diagnosis", () => {
    const result = diagnoseMetrics(ISOLATED_SIGNAL);
    expect(patternsOf(result)).toEqual([DiagnosisPattern.UNCLUSTERED_SIGNAL]);

    const diagnosis = result.diagnoses[0];
    expect(diagnosis.id).toBe(
      `diagnosis.unclustered_signal.${SignalType.CLINICAL_LARGE_PENDING_TREATMENT_VALUE}:${CLINIC_ID}:${DATE}`,
    );
    expect(diagnosis.signalIds).toEqual([
      `signal.${SignalType.CLINICAL_LARGE_PENDING_TREATMENT_VALUE}:${CLINIC_ID}:${DATE}`,
    ]);
    expect(diagnosis.hypotheses).toHaveLength(1);
    expect(diagnosis.hypotheses[0].status).toBe("undetermined");
    // an entirely undetermined diagnosis must still say what would settle it
    expect(discriminatorSlugs(diagnosis)).toEqual(["longer_history_window"]);
    expect(evidenceFor(diagnosis, "unclustered")).toContain(
      "contributed to no pattern",
    );
  });

  it("produces no unclustered diagnosis when every signal is claimed", () => {
    const result = diagnoseMetrics(DEMAND_SUPPLY_WITH_PENDING);
    expect(patternsOf(result)).not.toContain(DiagnosisPattern.UNCLUSTERED_SIGNAL);
    const trace = result.traces.find(
      (entry) => entry.step === DiagnosisPattern.UNCLUSTERED_SIGNAL,
    );
    expect(trace?.reasoning).toContain("Every emitted signal contributed");
  });
});

describe("diagnose — overlapping and contradictory signals", () => {
  it("lets one signal contribute to several diagnoses at once", () => {
    const result = diagnoseMetrics(DEMAND_SUPPLY_WITH_PENDING);
    const lowUtilization = `signal.${SignalType.OPERATIONAL_LOW_CHAIR_UTILIZATION}:${CLINIC_ID}:${DATE}`;
    const claiming = result.diagnoses.filter((diagnosis) =>
      diagnosis.signalIds.includes(lowUtilization),
    );
    expect(claiming.map((d) => d.pattern).sort()).toEqual([
      DiagnosisPattern.DEMAND_SUPPLY_MISMATCH,
      DiagnosisPattern.PIPELINE_CONVERSION_FAILURE,
    ]);
  });

  it("emits both patterns for contradictory signals and records the conflict", () => {
    const result = diagnoseMetrics(CONTRADICTORY);
    const patterns = patternsOf(result);
    expect(patterns).toContain(DiagnosisPattern.DEMAND_SUPPLY_MISMATCH);
    expect(patterns).toContain(DiagnosisPattern.UNCLUSTERED_SIGNAL);

    const mismatch = pick(result, DiagnosisPattern.DEMAND_SUPPLY_MISMATCH);
    expect(evidenceFor(mismatch, "signal-conflict")).toContain(
      "cannot hold simultaneously",
    );
    // the near-full signal is not silently dropped
    const unclustered = result.diagnoses.find((d) =>
      d.id.includes(SignalType.OPERATIONAL_NEAR_FULL_CAPACITY),
    );
    expect(unclustered).toBeDefined();
  });
});

describe("diagnose — ordering and determinism", () => {
  it("orders by pattern then id, never by severity or confidence", () => {
    const result = diagnoseMetrics(DEMAND_SUPPLY_WITH_PENDING);
    const order = Object.values(DiagnosisPattern);
    const ranks = result.diagnoses.map((d) => order.indexOf(d.pattern));
    expect([...ranks]).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("produces byte-identical output on repeated runs", () => {
    const current = run(DEMAND_SUPPLY_WITH_PENDING, { previous: PRIOR });
    const history = [
      run(DEMAND_SUPPLY_WITH_PENDING, { date: "2026-07-23" }),
      run(DEMAND_SUPPLY_WITH_PENDING, { date: "2026-07-24" }),
      run(DEMAND_SUPPLY_WITH_PENDING, { date: "2026-07-25" }),
    ];
    const input = { current, history, clinicId: CLINIC_ID, now: NOW };

    const first = diagnose(input);
    const second = diagnose(input);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.every((d) => d.generatedAt === NOW)).toBe(true);
    expect(
      first.every((d) =>
        d.evidence.every((item) => item.capturedAt === NOW),
      ),
    ).toBe(true);
  });

  it("is insensitive to history order and dedupes a repeated date", () => {
    const current = run(DEMAND_SUPPLY_WITH_PENDING);
    const days = [
      run(DEMAND_SUPPLY_WITH_PENDING, { date: "2026-07-23" }),
      run(DEMAND_SUPPLY_WITH_PENDING, { date: "2026-07-24" }),
      run(DEMAND_SUPPLY_WITH_PENDING, { date: "2026-07-25" }),
    ];
    const ascending = diagnoseRun(current, { history: days });
    const shuffled = diagnoseRun(current, {
      history: [days[2], days[0], days[1]],
    });
    expect(shuffled.diagnoses).toEqual(ascending.diagnoses);

    const duplicated = diagnoseRun(current, {
      history: [...days, run(HEALTHY, { date: "2026-07-25" })],
    });
    // the later run for 2026-07-25 replaces the earlier one
    expect(
      pick(duplicated, DiagnosisPattern.DEMAND_SUPPLY_MISMATCH).persistence,
    ).not.toBe(pick(ascending, DiagnosisPattern.DEMAND_SUPPLY_MISMATCH).persistence);
  });
});

describe("diagnose — input validation", () => {
  it("rejects history from a different clinic", () => {
    const result = diagnoseRun(run(DEMAND_SUPPLY_WITH_PENDING), {
      history: [
        run(DEMAND_SUPPLY_WITH_PENDING, {
          date: "2026-07-25",
          clinicId: "clinic_999",
        }),
      ],
    });
    expect(result.error?.code).toBe("DIAGNOSIS_ENGINE_MIXED_CLINIC");
    expect(result.diagnoses).toEqual([]);
    expect(result.confidence).toBeUndefined();
    expect(result.error?.details).toMatchObject({ foreignClinicIds: ["clinic_999"] });
  });

  it("rejects a run date that is not a calendar date", () => {
    const result = evaluateDiagnoses({
      current: { date: "26-07-2026", signals: [], metrics: [], trace: [] },
      clinicId: CLINIC_ID,
      now: NOW,
    });
    expect(result.error?.code).toBe("DIAGNOSIS_ENGINE_INVALID_DATE");
  });

  it("ignores signal types it does not recognise instead of throwing", () => {
    const retired = {
      id: `signal.retention.retired_signal:${CLINIC_ID}:${DATE}`,
      title: "Retired signal",
      description: "A signal type produced by an older Signal Engine.",
      severity: "medium" as const,
      priority: "medium" as const,
      relatedEntities: [],
      generatedAt: NOW,
      confidence: 1,
    };
    const base = run(HEALTHY);
    const result = diagnoseRun({
      ...base,
      signals: [...base.signals, retired],
    });
    expect(result.error).toBeUndefined();
    // it matches no pattern, so it is carried forward rather than lost
    expect(patternsOf(result)).toEqual([DiagnosisPattern.UNCLUSTERED_SIGNAL]);
  });

  it("returns an empty array from the pure core when input is rejected", () => {
    expect(
      diagnose({
        current: { date: "not-a-date", signals: [], metrics: [], trace: [] },
        clinicId: CLINIC_ID,
        now: NOW,
      }),
    ).toEqual([]);
  });
});

describe("diagnose — failure isolation", () => {
  it("catches a throwing matcher and keeps the run alive", () => {
    const broken: PatternMatcher = {
      pattern: "demand_supply_mismatch",
      category: "operational",
      requiredSignals: [SignalType.OPERATIONAL_LOW_CHAIR_UTILIZATION],
      optionalSignals: [],
      rule: "deliberately broken",
      match() {
        throw new Error("boom");
      },
    };
    const result = evaluateDiagnoses(
      {
        current: run(DEMAND_SUPPLY_WITH_PENDING),
        clinicId: CLINIC_ID,
        now: NOW,
      },
      [broken, ...MATCHERS.filter((m) => m.pattern !== "demand_supply_mismatch")],
    );
    expect(result.error).toBeUndefined();
    expect(
      result.traces.find((t) => t.step === "demand_supply_mismatch")?.reasoning,
    ).toBe("Not matched: matcher threw (boom).");
    // the surviving matchers still produced their diagnoses
    expect(patternsOf(result)).toContain(DiagnosisPattern.PIPELINE_CONVERSION_FAILURE);
  });
});

describe("diagnose — trace and confidence", () => {
  it("traces every matcher including the non-matches, with reasons", () => {
    const result = diagnoseMetrics(HEALTHY);
    const steps = result.traces.map((t) => t.step);
    expect(steps[0]).toBe("prepare-input");
    expect(steps[steps.length - 1]).toBe("summarise-run");
    for (const matcher of MATCHERS) expect(steps).toContain(matcher.pattern);
    expect(steps).toContain(DiagnosisPattern.UNCLUSTERED_SIGNAL);
    expect(result.traces.every((t) => t.engine === "DiagnosisEngine")).toBe(true);
    expect(
      result.traces
        .filter((t) => t.reasoning.startsWith("Not matched:"))
        .every((t) => t.reasoning.length > "Not matched:".length + 5),
    ).toBe(true);
  });

  it("reports low decidability, not 1.0, when the evaluators could not run", () => {
    // Queue metrics only: most evaluators skipped, so most patterns are undecidable.
    const blind = run({
      [MetricKey.QUEUE_PATIENTS_WAITING]: 9,
      [MetricKey.QUEUE_AVERAGE_WAITING_TIME]: 55,
    });
    const result = diagnoseRun(blind);
    expect(result.confidenceBasis).toBe("emitted_diagnoses");

    const quietButBlind = diagnoseRun(run({ [MetricKey.FOLLOWUPS_DUE_TODAY]: 4 }));
    expect(quietButBlind.diagnoses).toEqual([]);
    expect(quietButBlind.confidenceBasis).toBe("matcher_decidability");
    expect(quietButBlind.confidence).toBe(0);
  });

  it("scopes ids to the clinic-day so a re-run overwrites rather than duplicates", () => {
    const first = diagnoseMetrics(DEMAND_SUPPLY_WITH_PENDING);
    const second = diagnoseRun(
      run(DEMAND_SUPPLY_WITH_PENDING, { date: DATE }),
    );
    expect(second.diagnoses.map((d) => d.id)).toEqual(
      first.diagnoses.map((d) => d.id),
    );
    expect(first.diagnoses[0].id).toContain(`:${CLINIC_ID}:${DATE}`);
  });

  it("rejects current-run metrics from two clinics", () => {
    const mixed = [
      ...metrics({ [MetricKey.FOLLOWUPS_OVERDUE]: 22 }),
      ...metrics({ [MetricKey.QUEUE_PATIENTS_WAITING]: 9 }, { clinicId: "clinic_777" }),
    ];
    const result = diagnoseRun({
      date: DATE,
      signals: [],
      metrics: mixed,
      trace: [],
    });
    expect(result.error?.code).toBe("DIAGNOSIS_ENGINE_MIXED_CLINIC");
  });
});
