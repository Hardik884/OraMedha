import { describe, expect, it } from "vitest";

import { DiagnosisPattern } from "../../../domain";
import { Severity } from "../../../types";
import { MetricKey } from "../../metrics/metric-ids";
import { DEFAULT_DIAGNOSIS_CONFIG, resolveDiagnosisConfig } from "../config/diagnosis-config";
import {
  addDays,
  dateRange,
  daysBetween,
  fromDayNumber,
  isIsoDate,
  toDayNumber,
} from "../support/dates";
import { computeDiagnosisConfidence, hypothesisConfidence } from "../support/diagnosis-confidence";
import { assessDiagnosisSeverity, worstSeverity } from "../support/diagnosis-severity";
import {
  ALL_DISCRIMINATORS,
  Availability,
  requiredPortMethods,
} from "../support/discriminators";
import { diagnoseRun, evidenceFor, pick } from "./fixtures/diagnose-harness";
import { DATE, HEALTHY, ISOLATED_SIGNAL, metrics, run, shiftDate } from "./fixtures/run-fixtures";

/**
 * A day whose only signal is a large pending-treatment book, at a chosen breach
 * size. Uses `large_pending_treatment_value` (a still-orphan single signal, so it
 * carries forward as one unclustered diagnosis) rather than the follow-up
 * backlog, which now has its own `recall_backlog` matcher. `size` maps to a value
 * above the limit for firing days and below it for a measurably-quiet day, so the
 * persistence tests keep their ascending/descending magnitude ordering.
 */
function backlogDay(size: number, offset: number) {
  return run(
    { ...HEALTHY, [MetricKey.REVENUE_PENDING_TREATMENT_VALUE]: size * 5000 },
    { date: shiftDate(DATE, offset) },
  );
}

function backlogToday(size: number) {
  return run({ ...HEALTHY, [MetricKey.REVENUE_PENDING_TREATMENT_VALUE]: size * 5000 });
}

describe("dates", () => {
  it("round-trips calendar dates through day numbers", () => {
    for (const date of ["1970-01-01", "2000-02-29", "2026-07-26", "2100-03-01"]) {
      expect(fromDayNumber(toDayNumber(date))).toBe(date);
    }
    expect(toDayNumber("1970-01-01")).toBe(0);
  });

  it("handles leap years and month boundaries", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-07-20", "2026-07-26")).toBe(6);
    expect(daysBetween("2026-07-26", "2026-07-20")).toBe(-6);
  });

  it("validates calendar dates rather than just the shape", () => {
    expect(isIsoDate("2026-07-26")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("26-07-2026")).toBe(false);
  });

  it("enumerates an inclusive range and nothing for an inverted one", () => {
    expect(dateRange("2026-07-24", "2026-07-26")).toEqual([
      "2026-07-24",
      "2026-07-25",
      "2026-07-26",
    ]);
    expect(dateRange("2026-07-26", "2026-07-24")).toEqual([]);
  });
});

describe("persistence classification", () => {
  it("never assumes a baseline when no history was supplied", () => {
    const diagnosis = pick(
      diagnoseRun(backlogToday(22)),
      DiagnosisPattern.UNCLUSTERED_SIGNAL,
    );
    expect(diagnosis.persistence).toBe("insufficient_history");
    expect(evidenceFor(diagnosis, "persistence")).toContain("no baseline was assumed");

    const withHistory = pick(
      diagnoseRun(backlogToday(22), {
        history: [backlogDay(22, -3), backlogDay(22, -2), backlogDay(22, -1)],
      }),
      DiagnosisPattern.UNCLUSTERED_SIGNAL,
    );
    // the missing-history penalty is the only difference
    expect(diagnosis.confidence).toBeLessThan(withHistory.confidence);
  });

  it("classifies a five-day streak as sustained and raises severity one band", () => {
    const history = [-5, -4, -3, -2, -1].map((offset) => backlogDay(11, offset));
    const diagnosis = pick(
      diagnoseRun(backlogToday(11), { history }),
      DiagnosisPattern.UNCLUSTERED_SIGNAL,
    );
    expect(diagnosis.persistence).toBe("sustained");
    // the signal itself is floored at low; sustained raises it to medium
    expect(diagnosis.severity).toBe(Severity.MEDIUM);
    expect(evidenceFor(diagnosis, "severity")).toContain("moves up one band");
  });

  it("classifies ascending breach magnitudes as worsening", () => {
    const history = [backlogDay(11, -3), backlogDay(14, -2), backlogDay(18, -1)];
    const diagnosis = pick(
      diagnoseRun(backlogToday(40), { history }),
      DiagnosisPattern.UNCLUSTERED_SIGNAL,
    );
    expect(diagnosis.persistence).toBe("worsening");
    const persistence = evidenceFor(diagnosis, "persistence");
    expect(persistence).toContain("mean breach magnitude rose");
  });

  it("classifies descending breach magnitudes as improving and lowers severity", () => {
    const history = [backlogDay(40, -3), backlogDay(30, -2), backlogDay(22, -1)];
    const diagnosis = pick(
      diagnoseRun(backlogToday(13), { history }),
      DiagnosisPattern.UNCLUSTERED_SIGNAL,
    );
    expect(diagnosis.persistence).toBe("improving");
    expect(evidenceFor(diagnosis, "severity")).toContain("moves down one band");
  });

  it("treats a calendar gap as unknown rather than as a healthy day", () => {
    // Days -5, -3, -2 and -1 supplied; -4 is missing entirely. The consecutive run
    // ending today would otherwise be long enough to call sustained.
    const gapped = [
      backlogDay(11, -5),
      backlogDay(11, -3),
      backlogDay(11, -2),
      backlogDay(11, -1),
    ];
    const diagnosis = pick(
      diagnoseRun(backlogToday(11), { history: gapped }),
      DiagnosisPattern.UNCLUSTERED_SIGNAL,
    );
    // it must not claim sustained on the strength of a day it never saw
    expect(diagnosis.persistence).toBe("intermittent");
    const persistence = evidenceFor(diagnosis, "persistence");
    expect(persistence).toContain("cannot support a sustained");
    expect(persistence).toContain(`unknown on [${shiftDate(DATE, -4)}]`);

    const complete = pick(
      diagnoseRun(backlogToday(11), {
        history: [backlogDay(11, -3), backlogDay(11, -2), backlogDay(11, -1)],
      }),
      DiagnosisPattern.UNCLUSTERED_SIGNAL,
    );
    expect(complete.persistence).toBe("sustained");
    // the unknown day is penalised
    expect(diagnosis.confidence).toBeLessThan(complete.confidence);
    expect(evidenceFor(diagnosis, "confidence")).toContain("history day(s) unknown");
  });

  it("distinguishes a day whose evaluator skipped from a day that was quiet", () => {
    // Day -2 supplies no follow-up metric at all, so its evaluator skipped and the
    // day's state is unknown rather than quiet.
    const blindDay = run(
      { [MetricKey.QUEUE_PATIENTS_WAITING]: 1 },
      { date: shiftDate(DATE, -2) },
    );
    const diagnosis = pick(
      diagnoseRun(backlogToday(11), {
        history: [backlogDay(11, -3), blindDay, backlogDay(11, -1)],
      }),
      DiagnosisPattern.UNCLUSTERED_SIGNAL,
    );
    expect(diagnosis.persistence).toBe("intermittent");
    expect(evidenceFor(diagnosis, "persistence")).toContain(
      `unknown on [${shiftDate(DATE, -2)}]`,
    );

    // Whereas a day that measurably had no backlog is a real quiet day.
    const quietDay = backlogDay(2, -2);
    const withQuietDay = pick(
      diagnoseRun(backlogToday(11), {
        history: [backlogDay(11, -3), quietDay, backlogDay(11, -1)],
      }),
      DiagnosisPattern.UNCLUSTERED_SIGNAL,
    );
    expect(evidenceFor(withQuietDay, "persistence")).toContain(
      `measurably quiet on [${shiftDate(DATE, -2)}]`,
    );
    expect(withQuietDay.confidence).toBeGreaterThan(diagnosis.confidence);
  });
});

describe("history supplied as metrics only", () => {
  it("re-derives signals and reaches the same conclusion as supplied runs", () => {
    // Matches backlogToday(11) = 11 * 5000 so today and history share one signal.
    const values = { ...HEALTHY, [MetricKey.REVENUE_PENDING_TREATMENT_VALUE]: 55_000 };
    const offsets = [-3, -2, -1];
    const historyMetricsOnly = offsets.map((offset) => ({
      date: shiftDate(DATE, offset),
      metrics: metrics(values, { date: shiftDate(DATE, offset) }),
    }));
    const history = offsets.map((offset) =>
      run(values, {
        date: shiftDate(DATE, offset),
        previous: metrics(values, { date: shiftDate(DATE, offset - 1) }),
      }),
    );

    const derived = diagnoseRun(backlogToday(11), { historyMetricsOnly });
    const supplied = diagnoseRun(backlogToday(11), { history });

    expect(derived.diagnoses).toEqual(supplied.diagnoses);
    expect(pick(derived, DiagnosisPattern.UNCLUSTERED_SIGNAL).persistence).toBe(
      "sustained",
    );
  });

  it("records in the trace that the history was re-derived", () => {
    const result = diagnoseRun(backlogToday(11), {
      historyMetricsOnly: [
        {
          date: shiftDate(DATE, -1),
          metrics: metrics(
            { ...HEALTHY, [MetricKey.FOLLOWUPS_OVERDUE]: 11 },
            { date: shiftDate(DATE, -1) },
          ),
        },
      ],
    });
    const prepare = result.traces[0];
    expect(prepare.step).toBe("prepare-input");
    expect(prepare.reasoning).toContain("1 re-derived from metrics");
    expect(prepare.evidence.some((e) => e.description.startsWith("Re-derived"))).toBe(
      true,
    );
  });

  it("prefers a supplied run over re-deriving the same date", () => {
    const result = diagnoseRun(backlogToday(11), {
      history: [backlogDay(11, -1)],
      historyMetricsOnly: [
        { date: shiftDate(DATE, -1), metrics: metrics(HEALTHY, { date: shiftDate(DATE, -1) }) },
      ],
    });
    expect(
      result.traces[0].evidence.some((e) =>
        e.description.includes("Skipped re-deriving"),
      ),
    ).toBe(true);
  });
});

describe("severity derivation", () => {
  it("takes the worst contributing severity then adjusts for persistence", () => {
    const base = {
      contributing: [Severity.LOW, Severity.MEDIUM] as const,
      pattern: DiagnosisPattern.COLLECTION_GAP,
      config: DEFAULT_DIAGNOSIS_CONFIG,
    };
    expect(worstSeverity([...base.contributing])).toBe(Severity.MEDIUM);
    expect(
      assessDiagnosisSeverity({ ...base, persistence: "transient" }).severity,
    ).toBe(Severity.MEDIUM);
    expect(
      assessDiagnosisSeverity({ ...base, persistence: "sustained" }).severity,
    ).toBe(Severity.HIGH);
    expect(
      assessDiagnosisSeverity({ ...base, persistence: "worsening" }).severity,
    ).toBe(Severity.HIGH);
    expect(
      assessDiagnosisSeverity({ ...base, persistence: "improving" }).severity,
    ).toBe(Severity.LOW);
  });

  it("clamps at the band boundaries and records the clamp", () => {
    const critical = assessDiagnosisSeverity({
      contributing: [Severity.CRITICAL],
      persistence: "worsening",
      pattern: DiagnosisPattern.COLLECTION_GAP,
      config: DEFAULT_DIAGNOSIS_CONFIG,
    });
    expect(critical.severity).toBe(Severity.CRITICAL);

    const info = assessDiagnosisSeverity({
      contributing: [Severity.INFO],
      persistence: "improving",
      pattern: DiagnosisPattern.COLLECTION_GAP,
      config: DEFAULT_DIAGNOSIS_CONFIG,
    });
    expect(info.severity).toBe(Severity.INFO);

    const capped = assessDiagnosisSeverity({
      contributing: [Severity.CRITICAL],
      persistence: "sustained",
      pattern: DiagnosisPattern.CAPACITY_CEILING,
      config: DEFAULT_DIAGNOSIS_CONFIG,
    });
    expect(capped.severity).toBe(Severity.HIGH);
    expect(capped.clamped).toBe(true);
    expect(capped.reasoning).toContain("pattern clamp");
  });
});

describe("confidence derivation", () => {
  it("blends optional completeness from a floor rather than zeroing it", () => {
    const shared = {
      config: DEFAULT_DIAGNOSIS_CONFIG,
      contributingConfidences: [1],
      persistence: "sustained" as const,
      unknownHistoryDays: 0,
      skippedRequiredEvaluators: 0,
    };
    expect(
      computeDiagnosisConfidence({ ...shared, optionalDeclared: 2, optionalPresent: 0 })
        .confidence,
    ).toBe(0.7);
    expect(
      computeDiagnosisConfidence({ ...shared, optionalDeclared: 2, optionalPresent: 1 })
        .confidence,
    ).toBe(0.85);
    expect(
      computeDiagnosisConfidence({ ...shared, optionalDeclared: 2, optionalPresent: 2 })
        .confidence,
    ).toBe(1);
    expect(
      computeDiagnosisConfidence({ ...shared, optionalDeclared: 0, optionalPresent: 0 })
        .confidence,
    ).toBe(1);
  });

  it("charges for skipped required evaluators but not for measured absence", () => {
    const shared = {
      config: DEFAULT_DIAGNOSIS_CONFIG,
      optionalDeclared: 0,
      optionalPresent: 0,
      contributingConfidences: [1],
      persistence: "sustained" as const,
      unknownHistoryDays: 0,
    };
    expect(
      computeDiagnosisConfidence({ ...shared, skippedRequiredEvaluators: 0 }).confidence,
    ).toBe(1);
    expect(
      computeDiagnosisConfidence({ ...shared, skippedRequiredEvaluators: 2 }).confidence,
    ).toBe(0.8);
  });

  it("can never exceed the weakest contributing signal", () => {
    const assessment = computeDiagnosisConfidence({
      config: DEFAULT_DIAGNOSIS_CONFIG,
      optionalDeclared: 0,
      optionalPresent: 0,
      contributingConfidences: [1, 0.6, 0.85],
      persistence: "sustained",
      unknownHistoryDays: 0,
      skippedRequiredEvaluators: 0,
    });
    expect(assessment.confidence).toBe(0.6);
    expect(assessment.signalCap).toBe(0.6);
  });

  it("caps an undetermined hypothesis below a confident-looking value", () => {
    expect(hypothesisConfidence("supported", 0.9, DEFAULT_DIAGNOSIS_CONFIG)).toBe(0.9);
    expect(hypothesisConfidence("contradicted", 0.9, DEFAULT_DIAGNOSIS_CONFIG)).toBe(0.9);
    expect(hypothesisConfidence("undetermined", 0.9, DEFAULT_DIAGNOSIS_CONFIG)).toBe(0.5);
    expect(hypothesisConfidence("undetermined", 0.4, DEFAULT_DIAGNOSIS_CONFIG)).toBe(0.4);
  });

  it("honours config overrides without mutating the defaults", () => {
    const resolved = resolveDiagnosisConfig({
      persistence: { sustainedDays: 5 },
      confidence: { minimumToEmit: 0.9 },
    });
    expect(resolved.persistence.sustainedDays).toBe(5);
    expect(resolved.persistence.minimumHistoryDays).toBe(3);
    expect(DEFAULT_DIAGNOSIS_CONFIG.persistence.sustainedDays).toBe(3);
    // signal thresholds come along so discrimination uses the same numbers
    expect(resolved.signals.appointments.minimumDailyAppointments).toBe(5);
  });
});

describe("discriminator catalogue", () => {
  it("has a unique slug per entry", () => {
    const slugs = ALL_DISCRIMINATORS.map((spec) => spec.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("names a port method for every entity-level entry and none for the others", () => {
    for (const spec of ALL_DISCRIMINATORS) {
      if (spec.availability === Availability.REQUIRES_ENTITY_DATA) {
        expect(spec.portMethod, spec.slug).toBeTruthy();
      } else {
        expect(spec.portMethod, spec.slug).toBeNull();
      }
    }
  });

  it("keeps the port surface justified by discriminators that actually exist", () => {
    // Every method the port declares must be demanded by a discriminator, and
    // every discriminator's method must exist on the port. The port is not allowed
    // to grow speculatively.
    expect(requiredPortMethods()).toEqual([
      "listAppointmentArrivals",
      "listCancellationEvents",
      "listCompletedTreatments",
      "listNoShowHistory",
      "listOutstandingBalances",
      "listPendingTreatments",
    ]);
  });

  it("attaches only catalogued discriminators to real diagnoses", () => {
    const known = new Set(ALL_DISCRIMINATORS.map((spec) => spec.slug));
    const result = diagnoseRun(run(ISOLATED_SIGNAL));
    for (const diagnosis of result.diagnoses) {
      for (const discriminator of diagnosis.discriminators) {
        expect(known.has(discriminator.id.split("#d.")[1])).toBe(true);
        // every discriminator points at hypotheses that exist on the diagnosis
        for (const hypothesisId of discriminator.wouldSeparate) {
          expect(diagnosis.hypotheses.some((h) => h.id === hypothesisId)).toBe(true);
        }
      }
    }
  });
});
