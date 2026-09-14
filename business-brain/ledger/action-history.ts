/**
 * Business Brain — Clinic Ledger: action history
 *
 * What the learning loop reads: the clinic's own completed actions over a bounded
 * lookback, what its records say followed each one, the findings it was actually
 * shown day by day, the problems it snoozed, and the stored daily readings of the
 * few metrics an outcome is judged by.
 *
 * ## Shaped so the engines never see a patient
 *
 * A completion still names its targets (the Outcome Engine needs them to detect
 * overlapping actions), but confirmations arrive as DELAYS — "one target showed
 * the intended result 3.2 days after the completion" — with no patient id beside
 * them. Learning is about actions, never about people.
 *
 * ## Absence is stated, never implied
 *
 * A day with no snapshot is a day nobody recorded what was shown: unknown, not
 * "nothing was flagged". A withheld kind is withheld, a capped read is truncated,
 * and both travel on the slice so no consumer can read them as empty.
 */

import type { EvidenceTiming, ResultEvidence } from "../provenance/evidence-quality";
import type { ActionCompletionFact } from "./ledger-facts";

/** A completion as history carries it: the fact plus the headline reading at that moment. */
export interface CompletionHistoryFact extends ActionCompletionFact {
  readonly metricKey: string | null;
  readonly metricValue: number | null;
}

/**
 * What the clinic's records say followed one completion, without naming anyone.
 *
 * `delaysDays` holds one entry per resolvable target that shows the intended
 * result after the completion: the days from the completion to the EARLIEST such
 * record. The engine applies its own horizon; the read applies none beyond `asOf`.
 */
export interface CompletionConfirmationFact {
  readonly completionId: string;
  readonly targeted: number;
  /** Targets that are still live patients in this clinic. */
  readonly resolvable: number;
  /** False when the category's intended result is not recorded anywhere. */
  readonly verifiable: boolean;
  readonly delaysDays: readonly number[];
  /**
   * One entry per resolvable target that shows the result: its delay and the kind
   * of record behind it, preferring an objectively observed record over an
   * earlier declaration. Absent means the evidence kind was not stated, and no
   * consumer may treat an unstated result as observed.
   */
  readonly results?: readonly ResultEvidence[];
  /** Whether the records were read as known at the evidence moment or as they stand now. Absent means unknown. */
  readonly timing?: EvidenceTiming;
}

/** One finding as it was shown on a recorded day. Identifiers and ordinals only. */
export interface SnapshotFinding {
  readonly findingId: string;
  readonly kind: string;
  readonly polarity: string;
  readonly category: string | null;
  readonly role: string;
  readonly rank: number | null;
  readonly severity: string | null;
  readonly actionable: boolean;
  /** Hidden from the briefing that day by an active snooze. */
  readonly suppressed: boolean;
  /**
   * Where the finding was concentrated that day, as codes: the root-cause
   * question, its outcome, and each association's dimension and group key.
   * Absent on snapshots recorded before this was captured — unknown, not "none".
   * Treatment-type groups are never recorded: the type is clinic-entered text.
   */
  readonly rootCauses?: readonly SnapshotRootCause[];
}

export interface SnapshotRootCause {
  readonly question: string;
  readonly outcome: "explained" | "no_concentration" | "insufficient_evidence";
  readonly associations: readonly { readonly dimension: string; readonly group: string }[];
}

/** The findings recorded for one clinic-local business day. */
export interface FindingSnapshotFact {
  readonly clinicId: string;
  readonly date: string;
  readonly findings: readonly SnapshotFinding[];
  /**
   * healthy: recorded from a run in which every stage succeeded. unknown: recorded
   * before run health was tracked. An unknown snapshot with no findings is never
   * supplied at all: it may be a failed run, not a quiet day.
   */
  readonly runHealth?: "healthy" | "unknown";
}

/** A snooze a dentist placed on a problem category. */
export interface DismissalFact {
  readonly clinicId: string;
  readonly category: string;
  readonly dismissedAt: string;
  readonly expiresAt: string;
}

/** Stored readings for one completed business day. Keys absent were not stored. */
export interface MetricReadingDay {
  readonly date: string;
  readonly values: Readonly<Record<string, number>>;
  /**
   * Each stored reading's provenance, by key (see `provenance/metric-provenance.ts`).
   * A key with no entry is of unknown provenance, and evidence about the past may
   * not rest on it.
   */
  readonly provenance?: Readonly<Record<string, string>>;
}

export type ActionHistoryKind =
  | "action_completion"
  | "completion_confirmation"
  | "finding_snapshot"
  | "dismissal"
  | "metric_history";

export interface ActionHistoryScope {
  readonly clinicId: string;
  /** Clinic-local business dates, inclusive. */
  readonly from: string;
  readonly to: string;
  readonly asOf: string;
  /** Most rows per kind. */
  readonly limit: number;
  /** The stored metrics to read. Nothing else from metric_history is loaded. */
  readonly metricKeys: readonly string[];
}

export interface ActionHistorySlice {
  readonly clinicId: string;
  readonly scope: ActionHistoryScope;
  readonly timezone: string;
  readonly completions: readonly CompletionHistoryFact[];
  readonly confirmations: readonly CompletionConfirmationFact[];
  readonly snapshots: readonly FindingSnapshotFact[];
  readonly dismissals: readonly DismissalFact[];
  readonly metricDays: readonly MetricReadingDay[];
  /** Kinds whose read hit the limit. */
  readonly truncated: readonly ActionHistoryKind[];
  /** Kinds this session was not permitted to read, reported rather than empty. */
  readonly withheld: readonly ActionHistoryKind[];
}

/** Bounded, read-only access to one clinic's action history. Throws on a failed read. */
export interface ActionHistoryPort {
  readActionHistory(scope: ActionHistoryScope): Promise<ActionHistorySlice>;
}
