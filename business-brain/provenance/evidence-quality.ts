/**
 * Business Brain — Evidence quality for actions and their results.
 *
 * Not every record that "an action happened" or "the result arrived" is the same
 * kind of evidence, and the Outcome and Learning Engines must never add them up
 * as though they were.
 *
 *   staff_declared        a person's statement: "Mark as done" on a card, or a
 *                         follow-up closed with no attended visit on record
 *   objectively_observed  a record of the event itself, captured by the database
 *                         when it was written: a payment row, an appointment
 *                         booked, a follow-up closed alongside an attended visit
 *   system_derived        worked out by OraMedha from other records: an inferred
 *                         completion, a metric reading
 *   unknown               nothing says which
 *
 * A contact attempt ("patient was called") is staff_declared unless a delivery
 * record exists, and none does in this schema.
 *
 * ## When the evidence was known
 *
 *   point_in_time  read from recorded state history, bounded to what was on record
 *                  at the moment the evidence is judged
 *   current_state  read from records as they stand now — a later cancellation or
 *                  deletion has already been applied, and updated_at / created_at
 *                  stood in for when things happened
 *   unknown        not stated
 *
 * Pure.
 */

export const EvidenceSource = {
  STAFF_DECLARED: "staff_declared",
  OBJECTIVELY_OBSERVED: "objectively_observed",
  SYSTEM_DERIVED: "system_derived",
  UNKNOWN: "unknown",
} as const;
export type EvidenceSource = (typeof EvidenceSource)[keyof typeof EvidenceSource];

export const EvidenceTiming = {
  POINT_IN_TIME: "point_in_time",
  CURRENT_STATE: "current_state",
  UNKNOWN: "unknown",
} as const;
export type EvidenceTiming = (typeof EvidenceTiming)[keyof typeof EvidenceTiming];

/**
 * What a completion's `completedAt` means. A declared completion is dated when
 * Done was pressed; nothing records when the work itself was done.
 */
export const CompletionTimeMeaning = {
  DECLARATION_TIME: "declaration_time",
  DERIVATION_TIME: "derivation_time",
} as const;
export type CompletionTimeMeaning = (typeof CompletionTimeMeaning)[keyof typeof CompletionTimeMeaning];

/** A completion's own evidence source, from how it was recorded. */
export function completionEvidence(source: string): { readonly source: EvidenceSource; readonly time: CompletionTimeMeaning } {
  if (source === "declared") return { source: EvidenceSource.STAFF_DECLARED, time: CompletionTimeMeaning.DECLARATION_TIME };
  if (source === "inferred") return { source: EvidenceSource.SYSTEM_DERIVED, time: CompletionTimeMeaning.DERIVATION_TIME };
  return { source: EvidenceSource.UNKNOWN, time: CompletionTimeMeaning.DECLARATION_TIME };
}

/** One target's result after an action: how long it took, and what kind of record shows it. */
export interface ResultEvidence {
  readonly delayDays: number;
  readonly source: EvidenceSource;
}

/** Only results that are records of the event itself. */
export function objectivelyObserved(results: readonly ResultEvidence[] | undefined): number[] {
  return (results ?? []).filter((r) => r.source === EvidenceSource.OBJECTIVELY_OBSERVED).map((r) => r.delayDays);
}
