/**
 * The training-data readiness contract: deterministic, every failed condition
 * returned, and no route around it for a recomputation, a reconstruction, a
 * staff declaration or a patient identifier.
 */

import { describe, expect, it } from "vitest";

import { EvidenceSource, EvidenceTiming, completionEvidence, objectivelyObserved } from "../../provenance/evidence-quality";
import { assessTrainingObservation, TrainingInvalidReason, type TrainingObservationCandidate } from "..";

const OPTIONS = { clinicId: "clinic_a", graceHours: 3 };

function candidate(over: Partial<TrainingObservationCandidate> = {}): TrainingObservationCandidate {
  return {
    clinicId: "clinic_a",
    describesDate: "2026-09-14",
    describesUntil: "2026-09-14T18:30:00.000Z",
    provenance: "observed_at_time",
    producedAt: "2026-09-14T19:07:00.000Z",
    knowledgeAsOf: "2026-09-14T18:29:59.999Z",
    recordTiming: EvidenceTiming.POINT_IN_TIME,
    unversionedInputs: [],
    gaps: { withheld: [], truncated: [], missing: [] },
    fields: ["metricKey", "value", "describesDate"],
    ...over,
  };
}

describe("assessTrainingObservation", () => {
  it("accepts a reading measured at the time, from state as known then, whole, and naming no patient", () => {
    expect(assessTrainingObservation(candidate(), OPTIONS)).toEqual({ valid: true, reasons: [] });
    // An objectively observed label from a closed window is still valid.
    expect(assessTrainingObservation(candidate({ label: { source: EvidenceSource.OBJECTIVELY_OBSERVED, windowClosed: true, available: true } }), OPTIONS).valid).toBe(true);
  });

  it("refuses future leakage in every form it takes", () => {
    expect(assessTrainingObservation(candidate({ knowledgeAsOf: "2026-09-15T02:00:00.000Z" }), OPTIONS).reasons).toContain(TrainingInvalidReason.FUTURE_LEAKAGE);
    expect(assessTrainingObservation(candidate({ producedAt: "2026-09-15T05:00:00.000Z" }), OPTIONS).reasons).toContain(TrainingInvalidReason.FUTURE_LEAKAGE);
    expect(assessTrainingObservation(candidate({ provenance: "recomputed_later" }), OPTIONS).reasons).toEqual([TrainingInvalidReason.FUTURE_LEAKAGE, TrainingInvalidReason.RECOMPUTED_LATER]);
    expect(assessTrainingObservation(candidate({ knowledgeAsOf: null }), OPTIONS).reasons).toContain(TrainingInvalidReason.FUTURE_LEAKAGE);
  });

  it("refuses a reconstruction where observed evidence is required, and mutable state", () => {
    expect(assessTrainingObservation(candidate({ provenance: "point_in_time_reconstruction" }), OPTIONS).reasons).toEqual([TrainingInvalidReason.RECONSTRUCTED_ONLY]);
    expect(assessTrainingObservation(candidate({ provenance: "point_in_time_reconstruction", unversionedInputs: ["queue_entries"] }), OPTIONS).reasons).toEqual([
      TrainingInvalidReason.MUTABLE_HISTORICAL_STATE,
      TrainingInvalidReason.RECONSTRUCTED_ONLY,
    ]);
    expect(assessTrainingObservation(candidate({ recordTiming: EvidenceTiming.CURRENT_STATE }), OPTIONS).reasons).toEqual([TrainingInvalidReason.MUTABLE_HISTORICAL_STATE]);
  });

  it("refuses unknown provenance, withheld, truncated and missing data", () => {
    expect(assessTrainingObservation(candidate({ provenance: "unknown" }), OPTIONS).reasons).toEqual([TrainingInvalidReason.UNKNOWN_PROVENANCE]);
    expect(assessTrainingObservation(candidate({ recordTiming: EvidenceTiming.UNKNOWN }), OPTIONS).reasons).toEqual([TrainingInvalidReason.UNKNOWN_PROVENANCE]);
    expect(
      assessTrainingObservation(candidate({ gaps: { withheld: ["action_completion"], truncated: ["metric_history"], missing: ["2026-09-13"] } }), OPTIONS).reasons,
    ).toEqual([TrainingInvalidReason.INSUFFICIENT_DATA, TrainingInvalidReason.TRUNCATED_DATA, TrainingInvalidReason.WITHHELD_DATA]);
  });

  it("never accepts a staff declaration, an unavailable label or an open window as a label", () => {
    expect(assessTrainingObservation(candidate({ label: { source: EvidenceSource.STAFF_DECLARED, windowClosed: true, available: true } }), OPTIONS).reasons).toEqual([
      TrainingInvalidReason.LABEL_STAFF_DECLARED,
    ]);
    expect(assessTrainingObservation(candidate({ label: { source: EvidenceSource.SYSTEM_DERIVED, windowClosed: true, available: true } }), OPTIONS).reasons).toEqual([
      TrainingInvalidReason.LABEL_UNAVAILABLE,
    ]);
    expect(assessTrainingObservation(candidate({ label: { source: EvidenceSource.OBJECTIVELY_OBSERVED, windowClosed: false, available: false } }), OPTIONS).reasons).toEqual([
      TrainingInvalidReason.LABEL_UNAVAILABLE,
      TrainingInvalidReason.OUTCOME_WINDOW_OPEN,
    ]);
  });

  it("refuses another clinic and any patient-identifying field", () => {
    expect(assessTrainingObservation(candidate({ clinicId: "clinic_b" }), OPTIONS).reasons).toEqual([TrainingInvalidReason.CLINIC_MISMATCH]);
    expect(assessTrainingObservation(candidate({ fields: ["value", "targetPatientIds"] }), OPTIONS).reasons).toEqual([TrainingInvalidReason.PROHIBITED_IDENTIFIER]);
  });

  it("returns the same reasons in the same order for the same candidate", () => {
    const messy = candidate({ clinicId: "clinic_b", provenance: "recomputed_later", fields: ["phone"], gaps: { withheld: ["x"], truncated: [], missing: [] } });
    const first = assessTrainingObservation(messy, OPTIONS);
    expect(assessTrainingObservation({ ...messy, fields: [...messy.fields] }, OPTIONS)).toEqual(first);
    expect([...first.reasons]).toEqual([...first.reasons].sort());
  });
});

describe("evidence quality", () => {
  it("calls a pressed Done a staff declaration dated when it was declared", () => {
    expect(completionEvidence("declared")).toEqual({ source: "staff_declared", time: "declaration_time" });
    expect(completionEvidence("inferred")).toEqual({ source: "system_derived", time: "derivation_time" });
    expect(completionEvidence("guessed").source).toBe("unknown");
  });

  it("keeps only results that are records of the event itself", () => {
    expect(
      objectivelyObserved([
        { delayDays: 1, source: EvidenceSource.OBJECTIVELY_OBSERVED },
        { delayDays: 2, source: EvidenceSource.STAFF_DECLARED },
        { delayDays: 3, source: EvidenceSource.UNKNOWN },
      ]),
    ).toEqual([1]);
    expect(objectivelyObserved(undefined)).toEqual([]);
  });
});
