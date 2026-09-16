/**
 * Business Brain — Domain: Diagnosis
 *
 * A Diagnosis answers exactly two questions about a set of signals:
 *
 *   1. Which of these observations are one story rather than several?
 *   2. What causes are consistent with the evidence, and what would
 *      distinguish them?
 *
 * It is NOT a recommendation. It never tells anyone what to do — that is a
 * later phase.
 *
 * The central discipline: a threshold breach is a fact, a cause is not. Nothing
 * in daily clinic metrics can separate "cancellations rose because reminders
 * stopped sending" from "cancellations rose because of a local flu outbreak".
 * So a Diagnosis never asserts a single cause. It carries every hypothesis the
 * evidence permits, each with an explicit status, plus an explicit list of what
 * measurement would discriminate between them.
 *
 * A diagnosis whose every hypothesis is `undetermined` is a correct, expected
 * output — not a failure.
 */

import type { Confidence, Evidence, Severity } from "../types";
import type { RelatedEntity } from "./shared";
import type { SignalCategory } from "./signal";

/**
 * The correlation patterns the engine can recognise. The string value is part
 * of every diagnosis id and must never be renamed casually.
 */
export const DiagnosisPattern = {
  DEMAND_SUPPLY_MISMATCH: "demand_supply_mismatch",
  SCHEDULE_ATTRITION: "schedule_attrition",
  COLLECTION_GAP: "collection_gap",
  PIPELINE_CONVERSION_FAILURE: "pipeline_conversion_failure",
  THROUGHPUT_CONGESTION: "throughput_congestion",
  PATIENT_BASE_EROSION: "patient_base_erosion",
  RECALL_PROCESS_FAILURE: "recall_process_failure",
  REVENUE_SHORTFALL: "revenue_shortfall",
  CAPACITY_CEILING: "capacity_ceiling",
  // Standalone single-signal readings: a high-value signal that is a real,
  // actionable finding on its own. Each guards on an excluded signal so it never
  // double-reports a story a richer multi-signal pattern already tells.
  ACQUISITION_SHORTFALL: "acquisition_shortfall",
  OUTSTANDING_RECEIVABLES: "outstanding_receivables",
  RECALL_BACKLOG: "recall_backlog",
  /**
   * The one pattern about days that have not happened yet. It needs no guard
   * against the today-patterns: a thin week ahead and an idle chair this
   * morning are different facts about different days, so reporting both is two
   * findings rather than one story told twice.
   */
  FORWARD_SCHEDULE_GAP: "forward_schedule_gap",
  /**
   * Non-attendance concentrated in a few patients. Settles the SAME cause
   * (`patient_level_pattern`) that schedule_attrition can only reach through
   * entity resolution — from a metric, so it is available even when no entity
   * context port is wired up.
   */
  REPEAT_NON_ATTENDANCE: "repeat_non_attendance",
  /**
   * A patient base that has gone quiet: people seen at least once, not seen for
   * a recall interval, with nothing booked.
   *
   * Guarded against BOTH retention signals, which is what keeps it from being a
   * third card about the same patients. When returning volume has fallen, the
   * sharper story is patient_base_erosion / recall_process_failure. When the
   * clinic already has an overdue recall backlog, that list is the clinic's own,
   * more specific record of who to call and recall_backlog owns it. This fires
   * only in the case neither covers — a clinic whose recall list looks clean
   * because nobody ever put these patients on it.
   */
  DORMANT_PATIENT_BASE: "dormant_patient_base",
  /**
   * Appointments taking materially longer than the time booked for them, across
   * the trailing window.
   *
   * A structural fact about how the clinic books, not an event on one day —
   * which is why it is measured over the window and why it is reported even on a
   * day nobody waited. Guarded against the queue signals: when patients DID
   * queue today, throughput_congestion owns the finding and already carries
   * `service_time_variance` as a settleable cause, so reporting both would tell
   * one story twice.
   */
  CHRONIC_APPOINTMENT_OVERRUN: "chronic_appointment_overrun",
  /**
   * A month collecting less than was delivered, without any single day breaching
   * the same-day collection check.
   *
   * Guarded against that daily signal: when it fired, collection_gap has the
   * sharper story with its own persistence classification. What is left is the
   * clinic that passes every daily check while losing a fifth of its production —
   * invisible to a LEVEL (outstanding) and to a DAY (collection_gap) alike.
   */
  PRODUCTION_COLLECTION_GAP: "production_collection_gap",
  /**
   * Chair time going unused across the window rather than on one date.
   *
   * Needs NO guard, and that is a property of the Constraint Engine rather than
   * an oversight: this and demand_supply_mismatch both map to CAPACITY, so a
   * clinic that is quiet today and quiet this month gets one card carrying both
   * findings at the worse severity, never two competing headlines. The two are
   * genuinely different claims — one about a date, one about a habit — and the
   * collapse is exactly what that engine exists for.
   */
  SUSTAINED_IDLE_CAPACITY: "sustained_idle_capacity",
  UNCLUSTERED_SIGNAL: "unclustered_signal",
} as const;

export type DiagnosisPattern = (typeof DiagnosisPattern)[keyof typeof DiagnosisPattern];

/**
 * How the pattern behaved across the supplied history window.
 *
 * `insufficient_history` is not a soft "probably transient" — it means the
 * engine was not given enough days to classify anything, and says so.
 */
export type Persistence =
  | "insufficient_history"
  | "transient"
  | "intermittent"
  | "sustained"
  | "worsening"
  | "improving";

/**
 * What the available evidence does to a hypothesis.
 *
 * - `supported`: evidence positively favours it.
 * - `contradicted`: evidence positively rules against it.
 * - `undetermined`: consistent with the data, and NOT distinguishable from the
 *   alternatives using what is available. This is the honest default.
 */
export type HypothesisStatus = "supported" | "contradicted" | "undetermined";

/** One candidate explanation for a pattern. */
export interface Hypothesis {
  /** Stable id, `<diagnosisId>#h.<slug>`. */
  readonly id: string;
  /** Factual and testable. Never advisory. */
  readonly statement: string;
  readonly status: HypothesisStatus;
  /**
   * Data completeness behind this hypothesis, never a probability that it is
   * true. Undetermined hypotheses are capped by configuration so they can never
   * present as high-confidence.
   */
  readonly confidence: Confidence;
  readonly supporting: Evidence[];
  readonly contradicting: Evidence[];
  /**
   * What measurements are missing. Empty if and only if the status is not
   * `undetermined`: a hypothesis the engine settled needs nothing further, and
   * a hypothesis it could not settle must say what it would take.
   */
  readonly requiredData: readonly string[];
}

/**
 * How a finding has behaved across the supplied history window.
 *
 * ADDITIVE, and deliberately narrow. The full assessment — every fired date,
 * every unknown date, the breach trend — is already recorded in the diagnosis's
 * `persistence` evidence note, which is the right home for an audit trail. But a
 * projection that wants to tell a dentist "third day running" had to reach into
 * that note's untyped `data` bag to find the number, which is both fragile and a
 * layering mistake: the view should read typed domain fields, not parse evidence.
 *
 * So this carries exactly the counts a reader needs, typed, and nothing else. It
 * duplicates no logic — {@link classifyPersistence} computes all of it already
 * and the builder copies it across.
 */
export interface PersistenceDetail {
  /**
   * Consecutive days the finding has held, TODAY INCLUDED. Always at least 1.
   *
   * An unknown day breaks the chain rather than extending it: a day whose
   * evaluator could not run cannot be claimed as a day the problem persisted.
   */
  readonly consecutiveDays: number;
  /** Prior days in the window on which at least one contributing signal fired. */
  readonly priorFiredDays: number;
  /** Days in the window whose state could not be determined. */
  readonly unknownDays: number;
  /** History days actually supplied, gaps excluded. */
  readonly historyDaysSupplied: number;
  /**
   * True when unknown days prevented a sustained / worsening / improving call.
   *
   * Load-bearing for the view: the classification was capped by missing data
   * rather than by the clinic's behaviour, so presenting it as "on and off" would
   * state something about the clinic that was really a statement about the data.
   */
  readonly cappedByUnknown: boolean;
}

/** A measurement that would separate two or more hypotheses. */
export interface Discriminator {
  /** Stable id, `<diagnosisId>#d.<slug>`. */
  readonly id: string;
  /** What measurement would separate the hypotheses, stated factually. */
  readonly description: string;
  /** Ids of the hypotheses this measurement would separate. */
  readonly wouldSeparate: readonly string[];
  /**
   * What it would take to obtain the measurement. The set of non-`available`
   * discriminators the engine produces is the specification for the next phase.
   */
  readonly availability:
    | "available"
    | "requires_entity_data"
    | "requires_new_metric"
    | "requires_data_capture"
    | "requires_longer_history";
}

/**
 * One correlated story, with competing explanations and no recommendation.
 *
 * Invariants (enforced in code and tests):
 * - `hypotheses` is never empty.
 * - if every hypothesis is `undetermined`, at least one discriminator is present.
 * - `summary` and every evidence description state measurements and logic only.
 */
export interface Diagnosis {
  /** Stable id, `diagnosis.<pattern>:<clinicId>:<date>`. */
  readonly id: string;
  readonly pattern: DiagnosisPattern;
  readonly title: string;
  /** Factual restatement of the correlated observations. Never advice. */
  readonly summary: string;
  readonly category: SignalCategory;
  readonly severity: Severity;
  /**
   * Data completeness and pattern completeness — never a probability that any
   * cause is correct. Capped by the weakest contributing signal.
   */
  readonly confidence: Confidence;
  readonly persistence: Persistence;
  /**
   * The counts behind {@link persistence}, for a projection that wants to say
   * "third day running" rather than only "sustained".
   *
   * Optional because a Diagnosis built without a history window has no window to
   * describe. Absent means "not classified", never "one day".
   */
  readonly persistenceDetail?: PersistenceDetail;
  /** Ids of the signals that contributed to this pattern. */
  readonly signalIds: readonly string[];
  readonly metricIds: readonly string[];
  readonly hypotheses: readonly Hypothesis[];
  readonly discriminators: readonly Discriminator[];
  /** Clinic-level only in this phase; entity drill-down is a later phase. */
  readonly relatedEntities: readonly RelatedEntity[];
  readonly evidence: Evidence[];
  /** ISO-8601, injected. The engine never reads the system clock. */
  readonly generatedAt: string;
}
