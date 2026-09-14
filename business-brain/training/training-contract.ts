/**
 * Business Brain — Training-data readiness contract.
 *
 * NOT a pipeline, a model or a feature store. A deterministic statement of what a
 * stored observation must prove before it may ever be used to train or evaluate
 * one, so the question is decided once, in one place, before anyone is tempted
 * to answer it with whatever rows are convenient.
 *
 * An observation is VALID only when every condition holds:
 *
 *   clinic_scoped           it names exactly one clinic, the one asked about
 *   provenance_known        how it came to exist is recorded
 *   point_in_time           it was produced from information available by the
 *                           moment it describes (plus the bounded grace window),
 *                           and records nothing learned afterwards
 *   observed_evidence       where observed evidence is required, it is not a
 *                           reconstruction or a recomputation
 *   coverage_complete       nothing it rests on was withheld, truncated or missing
 *   label_observable        a label, where one is needed, is an objectively
 *                           observed record — never a staff declaration alone
 *   outcome_window_closed   a label is read only after its window has closed
 *   no_patient_identifiers  it carries no patient-identifying field
 *
 * Every failed condition is returned, sorted, so two readers of the same row get
 * the same answer and the same reasons.
 *
 * Pure.
 */

import { EvidenceSource, EvidenceTiming } from "../provenance/evidence-quality";
import { MetricProvenance } from "../provenance/metric-provenance";

export const TrainingInvalidReason = {
  CLINIC_MISMATCH: "clinic_mismatch",
  UNKNOWN_PROVENANCE: "unknown_provenance",
  FUTURE_LEAKAGE: "future_leakage",
  RECOMPUTED_LATER: "recomputed_later",
  RECONSTRUCTED_ONLY: "reconstructed_only",
  INSUFFICIENT_DATA: "insufficient_data",
  WITHHELD_DATA: "withheld_data",
  TRUNCATED_DATA: "truncated_data",
  MUTABLE_HISTORICAL_STATE: "mutable_historical_state",
  LABEL_UNAVAILABLE: "label_unavailable",
  LABEL_STAFF_DECLARED: "label_staff_declared",
  OUTCOME_WINDOW_OPEN: "outcome_window_open",
  PROHIBITED_IDENTIFIER: "prohibited_identifier",
} as const;
export type TrainingInvalidReason = (typeof TrainingInvalidReason)[keyof typeof TrainingInvalidReason];

/** Field names that identify a patient and may never appear on a training observation. */
export const PROHIBITED_TRAINING_FIELDS: readonly string[] = [
  "patientId",
  "patient_id",
  "patientIds",
  "targetPatientIds",
  "target_patient_ids",
  "name",
  "phone",
  "email",
  "dateOfBirth",
  "date_of_birth",
  "address",
  "note",
  "notes",
];

export interface TrainingObservationCandidate {
  readonly clinicId: string;
  /** Clinic-local date the observation describes. */
  readonly describesDate: string;
  /** The moment after which nothing may have informed it: the end of that day. */
  readonly describesUntil: string;
  readonly provenance: string;
  /** When it was produced. */
  readonly producedAt: string | null;
  /** The latest moment whose information it could use. */
  readonly knowledgeAsOf: string | null;
  /** How the records beneath it were read. */
  readonly recordTiming: EvidenceTiming;
  /** Inputs read as they stood at production time because nothing versions them. */
  readonly unversionedInputs: readonly string[];
  readonly gaps: {
    readonly withheld: readonly string[];
    readonly truncated: readonly string[];
    readonly missing: readonly string[];
  };
  /** Present when the observation is a labelled example. */
  readonly label?: {
    readonly source: EvidenceSource;
    readonly windowClosed: boolean;
    readonly available: boolean;
  };
  /** Every field the observation would carry, so identifiers can be refused by name. */
  readonly fields: readonly string[];
}

export interface TrainingContractOptions {
  readonly clinicId: string;
  /** Hours after `describesUntil` a production still counts as contemporaneous. */
  readonly graceHours: number;
}

export interface TrainingAssessment {
  readonly valid: boolean;
  readonly reasons: readonly TrainingInvalidReason[];
}

/** Whether a candidate qualifies as a future training observation, and every reason it does not. */
export function assessTrainingObservation(
  candidate: TrainingObservationCandidate,
  options: TrainingContractOptions,
): TrainingAssessment {
  const reasons = new Set<TrainingInvalidReason>();
  if (candidate.clinicId !== options.clinicId) reasons.add(TrainingInvalidReason.CLINIC_MISMATCH);

  const until = Date.parse(candidate.describesUntil);
  const knowledge = candidate.knowledgeAsOf === null ? Number.NaN : Date.parse(candidate.knowledgeAsOf);
  const produced = candidate.producedAt === null ? Number.NaN : Date.parse(candidate.producedAt);

  switch (candidate.provenance) {
    case MetricProvenance.OBSERVED_AT_TIME:
      if (Number.isNaN(produced) || produced > until + options.graceHours * 3_600_000) reasons.add(TrainingInvalidReason.FUTURE_LEAKAGE);
      break;
    case MetricProvenance.POINT_IN_TIME_RECONSTRUCTION:
      // Leak-free by construction, but not what was measured then.
      reasons.add(TrainingInvalidReason.RECONSTRUCTED_ONLY);
      if (candidate.unversionedInputs.length > 0) reasons.add(TrainingInvalidReason.MUTABLE_HISTORICAL_STATE);
      break;
    case MetricProvenance.RECOMPUTED_LATER:
      reasons.add(TrainingInvalidReason.RECOMPUTED_LATER);
      reasons.add(TrainingInvalidReason.FUTURE_LEAKAGE);
      break;
    default:
      reasons.add(TrainingInvalidReason.UNKNOWN_PROVENANCE);
  }

  if (Number.isNaN(knowledge) || Number.isNaN(until) || knowledge > until) reasons.add(TrainingInvalidReason.FUTURE_LEAKAGE);
  if (candidate.recordTiming === EvidenceTiming.CURRENT_STATE) reasons.add(TrainingInvalidReason.MUTABLE_HISTORICAL_STATE);
  if (candidate.recordTiming === EvidenceTiming.UNKNOWN) reasons.add(TrainingInvalidReason.UNKNOWN_PROVENANCE);

  if (candidate.gaps.withheld.length > 0) reasons.add(TrainingInvalidReason.WITHHELD_DATA);
  if (candidate.gaps.truncated.length > 0) reasons.add(TrainingInvalidReason.TRUNCATED_DATA);
  if (candidate.gaps.missing.length > 0) reasons.add(TrainingInvalidReason.INSUFFICIENT_DATA);

  if (candidate.label !== undefined) {
    if (!candidate.label.available) reasons.add(TrainingInvalidReason.LABEL_UNAVAILABLE);
    else if (candidate.label.source === EvidenceSource.STAFF_DECLARED) reasons.add(TrainingInvalidReason.LABEL_STAFF_DECLARED);
    else if (candidate.label.source !== EvidenceSource.OBJECTIVELY_OBSERVED) reasons.add(TrainingInvalidReason.LABEL_UNAVAILABLE);
    if (!candidate.label.windowClosed) reasons.add(TrainingInvalidReason.OUTCOME_WINDOW_OPEN);
  }

  const prohibited = new Set(PROHIBITED_TRAINING_FIELDS);
  if (candidate.fields.some((f) => prohibited.has(f))) reasons.add(TrainingInvalidReason.PROHIBITED_IDENTIFIER);

  const sorted = [...reasons].sort();
  return { valid: sorted.length === 0, reasons: sorted };
}
