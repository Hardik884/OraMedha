/**
 * Business Brain — Domain: Clinic Memory
 *
 * What the Business Brain knows about how ONE clinic behaves over time, kept in
 * four layers that never blur:
 *
 *   1. RAW FACTS              the clinic's own tables — appointments, follow-ups,
 *                             payments, completions. Never copied into memory.
 *   2. DERIVED OBSERVATIONS   what the Brain measured on a day: metric_history,
 *                             finding_snapshots. Already stored; append-only.
 *   3. LEARNED PATTERNS       ClinicMemoryEntry — DERIVED from 1 and 2 by a pure
 *                             engine, revalidated on every build, never written by
 *                             hand, a model, or anything else. A stored build is a
 *                             cache of the derivation: delete it and rebuilding from
 *                             the same evidence gives the same entries.
 *   4. HUMAN DECISIONS        ClinicDecisionFact — a person accepting or rejecting a
 *                             proposal, or rejecting a memory. Stored, append-only,
 *                             and the only layer that records intent.
 *
 * ## No prose is memory
 *
 * An entry holds identifiers, codes, dates and numbers. Sentences are rendered
 * from those at read time, so a change of wording can never change what the
 * clinic's memory says, and nothing a model writes can become memory.
 *
 * ## Memory is evidence, not truth
 *
 * Every entry says where it came from, over what period, how often it was seen,
 * how confident the derivation is, whether it still holds on the most recent
 * evidence, and — when it no longer does — why.
 */

/** What kind of pattern an entry describes. */
export const MemoryType = {
  /** This clinic's normal range for one metric, from its own recent readings. */
  NORMAL_RANGE: "normal_range",
  /** A sustained shift in a metric's level: the normal range before and after. */
  HISTORICAL_CHANGE: "historical_change",
  /** One weekday consistently reads outside the clinic's other days. */
  WEEKDAY_PATTERN: "weekday_pattern",
  /** A problem that has been flagged in repeated, separate episodes. */
  RECURRING_PROBLEM: "recurring_problem",
  /** An opportunity shown in repeated, separate episodes. */
  RECURRING_OPPORTUNITY: "recurring_opportunity",
  /** A root-cause concentration seen again and again on recorded days. */
  RECURRING_ROOT_CAUSE: "recurring_root_cause",
  /** An action repeatedly followed by its intended result. */
  ACTION_EFFECTIVE: "action_effective",
  /** An action repeatedly followed by no measurable change. */
  ACTION_NO_CHANGE: "action_no_change",
  /** An action repeatedly recommended and not taken up. */
  ACTION_IGNORED: "action_ignored",
  /** How long an action's intended result typically takes. */
  ACTION_TIME_TO_RESULT: "action_time_to_result",
} as const;

export type MemoryType = (typeof MemoryType)[keyof typeof MemoryType];

/**
 *   active      the most recent evidence still supports it
 *   weakening   the most recent evidence supports it less than the standard
 *   stale       the most recent evidence no longer supports it, or cannot revalidate it
 *   superseded  a newer entry about the same subject replaced it
 *   rejected    the clinic rejected it; kept, never used as support
 */
export type MemoryStatus = "active" | "weakening" | "stale" | "superseded" | "rejected";

/** Why an entry has its status. A code and its numbers — never a sentence. */
export interface MemoryStatusReason {
  readonly code:
    | "held_in_recent_evidence"
    | "partially_held_in_recent_evidence"
    | "contradicted_by_recent_evidence"
    | "not_revalidated"
    | "thin_recent_coverage"
    | "level_shift"
    | "not_recurred_within_interval"
    | "replaced_by_newer_pattern"
    | "rejected_by_clinic";
  readonly detail: Readonly<Record<string, number | string | null>>;
}

/** A pointer to the stored evidence an entry rests on. Counts and ranges, never rows. */
export interface MemoryEvidenceRef {
  readonly kind: "metric_history" | "finding_snapshot" | "action_completion" | "learning" | "decision";
  /** A date range, or the id of a derived object (a learning) or a decision. */
  readonly from: string | null;
  readonly to: string | null;
  readonly ref: string | null;
  readonly count: number;
}

export interface MemorySubject {
  readonly kind: "metric" | "category" | "opportunity" | "root_cause";
  /** Metric key, category, opportunity type, or `<question>.<dimension>`. */
  readonly key: string;
  /** Weekday (0 Sunday … 6 Saturday), root-cause group key, or change date. */
  readonly qualifier: string | null;
}

export interface ClinicMemoryEntry {
  /** `memory.<type>:<subject key>[:<qualifier>]:<clinicId>` — stable across builds. */
  readonly id: string;
  readonly clinicId: string;
  readonly type: MemoryType;
  readonly subject: MemorySubject;
  readonly status: MemoryStatus;
  readonly statusReason: MemoryStatusReason;
  /** The measured numbers the pattern consists of. */
  readonly facts: Readonly<Record<string, number | string | null>>;
  readonly evidence: {
    readonly refs: readonly MemoryEvidenceRef[];
    readonly observationCount: number;
    readonly firstObserved: string;
    readonly lastObserved: string;
    readonly supportingPeriod: { readonly from: string; readonly to: string };
    /** Share of the supporting period with evidence recorded. */
    readonly coverage: number;
  };
  /** Data completeness behind the entry, after status. Never a probability. */
  readonly confidence: number;
  /**
   * How the entry was checked against the most recent evidence, and what must be
   * seen before it can be checked again. Driven by evidence counts and the clinic's
   * own cadence — never a calendar expiry.
   */
  readonly revalidation: {
    readonly basis:
      | "recent_28_days"
      | "last_recurrence_interval"
      | "last_6_weekday_occurrences"
      | "last_28_recorded_days"
      | "last_5_closed_outcomes"
      | "clinic_completion_cadence";
    readonly window: { readonly from: string; readonly to: string } | null;
    readonly holds: boolean | null;
    /** The evidence the next build needs to revalidate, by name and count. */
    readonly requires: Readonly<Record<string, number>>;
  };
  readonly supersededBy: string | null;
}

// ── Human decisions ───────────────────────────────────────────────────────────

/** One recorded human decision. Append-only; the latest per target governs. */
export interface ClinicDecisionFact {
  readonly id: string;
  readonly clinicId: string;
  readonly target: { readonly type: "proposal" | "memory"; readonly id: string };
  /** For a proposal, its kind; null for a memory. */
  readonly proposalKind: string | null;
  readonly subject: string;
  readonly decision: "accepted" | "rejected" | "revoked";
  readonly decidedAt: string;
  /** What the evidence was when the decision was made, as numbers and codes. */
  readonly basis: Readonly<Record<string, number | string | null>>;
}

/** The decision currently governing one target, and whether it still rests on live evidence. */
export interface ResolvedDecision {
  readonly target: { readonly type: "proposal" | "memory"; readonly id: string };
  readonly proposalKind: string | null;
  readonly subject: string;
  readonly decision: "accepted" | "rejected";
  readonly decidedAt: string;
  readonly basis: Readonly<Record<string, number | string | null>>;
  /** Decisions superseded by this one for the same target, oldest first. */
  readonly history: readonly { readonly decision: string; readonly decidedAt: string }[];
  /**
   * An accepted decision whose evidence is no longer current — the proposal is no
   * longer produced, or the memory behind it is not active. Flagged for review;
   * never withdrawn automatically.
   */
  readonly needsReview: boolean;
}

export interface ClinicMemory {
  readonly clinicId: string;
  /** The last completed business day the evidence runs to. */
  readonly builtFor: string;
  readonly derivationVersion: string;
  readonly window: { readonly from: string; readonly to: string };
  readonly entries: readonly ClinicMemoryEntry[];
  readonly decisions: readonly ResolvedDecision[];
  readonly coverage: {
    readonly metricDays: number;
    readonly recordedDays: number;
    readonly outcomes: number;
    /** History kinds withheld or cut short; no positive memory rests on them. */
    readonly gaps: readonly string[];
  };
  /** Deterministic digest of entries and decisions: equal evidence, equal digest. */
  readonly digest: string;
}
