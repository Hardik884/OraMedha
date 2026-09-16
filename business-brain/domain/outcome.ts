/**
 * Business Brain — Domain: Outcome
 *
 * What happened after an action was completed.
 *
 * ## The distinction this whole file exists to hold
 *
 * COMPLETED means someone says they did it.
 * VERIFIED means the clinic's own data confirms the intended result.
 *
 * They are not the same claim and they must never be printed as though they
 * were. A staff member pressing Done is a statement about intent and memory; a
 * follow-up row moving to `completed` for one of the eight patients that action
 * targeted is a measurement. The first is worth recording and the second is
 * worth reporting, and an Outcome carries both separately so a reader is never
 * shown one when the evidence only supports the other.
 *
 * ## And the one it refuses to make
 *
 * Nothing here says an action CAUSED anything. There is no control group, no
 * randomisation, and one dominant confounder: a clinic that works its recall
 * list this week is also a clinic paying attention this week, and that same
 * attention moves numbers the action never touched. Worse, an action is
 * recommended precisely BECAUSE a number was unusually bad, and unusually bad
 * numbers improve on their own — so a naive causal model would report a success
 * almost every time and every report would feel like confirmation.
 *
 * So the vocabulary below tops out at "observed after". The sequence is stated;
 * the arrow is not.
 */

import type { CompletionTimeMeaning, EvidenceSource, EvidenceTiming } from "../provenance/evidence-quality";
import type { Value } from "./value";

/**
 * The terminal status of an action.
 *
 * Only COMPLETED is produced today. The other three are part of the vocabulary a
 * later tranche needs (an action ignored, failed or cancelled is a real signal
 * about a recommendation's usefulness) and nothing records them yet.
 */
export const OutcomeStatus = {
  COMPLETED: "completed",
  IGNORED: "ignored",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

export type OutcomeStatus = (typeof OutcomeStatus)[keyof typeof OutcomeStatus];

/**
 * How the completion was learned.
 *
 * Kept distinct rather than collapsed, because the two carry different
 * evidential weight. A declared completion is someone's word; an inferred one is
 * a derivation from data. Reporting an inference as a declaration would credit a
 * clinic with a decision it never made.
 */
export const CompletionSource = {
  /** A staff member pressed Done. */
  DECLARED: "declared",
  /** Derived from clinic data changing, with nobody saying so. */
  INFERRED: "inferred",
} as const;

export type CompletionSource = (typeof CompletionSource)[keyof typeof CompletionSource];

/**
 * How strongly the evidence connects the action to what followed.
 *
 * Four rungs. The first two describe ONE completion against the metric today; the
 * upper two are reached only through the explicit, windowed evidence requirements
 * in `engines/outcome/attribution.ts`, and only when the caller supplies the
 * clinic's own measured history.
 *
 * None of them is a causal claim. There is no control group and no
 * randomisation, so no amount of evidence here licenses "caused": the strongest
 * wording anywhere is "repeatedly associated with".
 *
 * Nothing climbs because time passed. Evidence is read at a fixed horizon after
 * the completion; waiting longer changes nothing, and a window that has not
 * closed cannot reach either upper rung.
 *
 * A worsening is NEVER attributed to an action, in either direction of the
 * ladder: the harm of telling a clinic its work made things worse far exceeds the
 * benefit of occasionally being right.
 */
export const OutcomeAttribution = {
  /**
   * The action was completed and nothing measurable can be said about what
   * followed. The honest default, and the correct answer for any action with no
   * identifiable population and no headline metric.
   */
  INSUFFICIENT_EVIDENCE: "insufficient_evidence",
  /**
   * The action was completed and the metric was measurable on both sides, so the
   * sequence can be stated: it read X then, it reads Y now.
   *
   * Makes no causal claim. "Observed after" is the whole of the assertion.
   */
  OBSERVED_AFTER: "observed_after",
  /**
   * Every windowed requirement held for this completion: the headline metric
   * moved beyond this clinic's normal variation within the fixed horizon, the
   * targeted patients show the intended result, the movement is concentrated in
   * them, and no competing explanation was found.
   *
   * Still an association. "Likely contributed" says the evidence is consistent
   * with the action playing a part, not that it did.
   */
  LIKELY_CONTRIBUTED: "likely_contributed",
  /**
   * This completion met the likely-contributed standard AND so did earlier
   * comparable completions at this clinic, consistently, across separate weeks.
   * Repetition within one clinic, never a benchmark across clinics.
   */
  STRONG_EVIDENCE: "strong_evidence",
} as const;

export type OutcomeAttribution =
  (typeof OutcomeAttribution)[keyof typeof OutcomeAttribution];

/**
 * One completion, as the engine reads it.
 *
 * A narrow, stable shape rather than a database row — the same discipline
 * `ClinicDataSnapshot` applies, so the engine never couples to the schema.
 */
export interface ActionCompletionRecord {
  readonly id: string;
  /** The ConstraintCategory the completed action belonged to. */
  readonly category: string;
  /** The stable constraint id the card carried, tying it to the run. */
  readonly constraintId: string;
  /** ISO-8601 moment of completion. */
  readonly completedAt: string;
  readonly source: CompletionSource;
  /** Patient ids the action targeted. Empty when the action targeted nobody. */
  readonly targetPatientIds: readonly string[];
  /** Headline metric key, when the category has one. */
  readonly metricKey?: string;
  /** That metric's reading at the moment of completion. */
  readonly metricValueAtCompletion?: number;
}

/**
 * What the clinic's own data says about the targets of one completion.
 *
 * Supplied by the adapter, which resolves it with a clinic-scoped query. The
 * engine never queries anything itself.
 *
 * `confirmed` counts targets for which the intended result is now present in the
 * data — a completed follow-up, a recorded payment, a booked appointment —
 * recorded AFTER the completion moment. `resolvable` is how many of the targets
 * still exist as live patients in the clinic, which is the honest denominator: a
 * patient deleted since cannot be confirmed and must not be counted as a miss.
 */
export interface TargetVerification {
  readonly completionId: string;
  /** Targets named on the completion record. */
  readonly targeted: number;
  /** Of those, how many still resolve to a live patient in this clinic. */
  readonly resolvable: number;
  /** Of the resolvable targets, how many show the intended result, on any kind of record. */
  readonly confirmed: number;
  /**
   * Of those, how many show it on a record of the event itself (a payment row, a
   * booking, a follow-up closed alongside an attended visit) rather than on a
   * staff member's say-so. Absent means the kind was not determined.
   */
  readonly observed?: number;
  /** How the results were read: as known at the moment, or from current rows. Absent means unknown. */
  readonly timing?: EvidenceTiming;
  /**
   * False when this category's intended result is not something the schema can
   * confirm at all.
   *
   * Load-bearing: a `verifiable: false` completion with `confirmed: 0` must never
   * read as "none of them worked". It means nobody looked, because nothing could.
   */
  readonly verifiable: boolean;
}

/**
 * The measured movement of the headline metric across a completion.
 *
 * `improved` is computed by the engine from the metric's own direction, and it is
 * the field the view gates on. A metric that moved the wrong way is reported
 * factually here and is NOT surfaced as an outcome line — see the note on
 * OutcomeAttribution about never attributing a worsening.
 */
export interface OutcomeMetricMovement {
  readonly key: string;
  /** Reading at the moment of completion. */
  readonly before: number;
  /** Reading now. */
  readonly after: number;
  /** `after - before`. Signed; its meaning depends on the metric's direction. */
  readonly delta: number;
  /** Whether the movement is in the direction that helps for this metric. */
  readonly improved: boolean;
}

/**
 * The recorded result of performing an action.
 */
export interface Outcome {
  /** Stable id, `outcome.<completionId>`. */
  readonly id: string;
  /** The completion this outcome describes. */
  readonly completionId: string;
  /** The ConstraintCategory the action belonged to. */
  readonly category: string;
  readonly constraintId: string;
  /** How the action ended. Always `completed` in this tranche. */
  readonly status: OutcomeStatus;
  readonly source: CompletionSource;
  readonly completedAt: string;
  /** How strongly the evidence connects the action to what followed. */
  readonly attribution: OutcomeAttribution;
  /**
   * Entity-level facts about the targets, when the category allows them.
   *
   * Exposed as verified FACTS, deliberately without being promoted to a stronger
   * attribution rung. Concentration of the improvement in exactly the targeted
   * patients is the evidence a later `likely_contributed` will rest on; recording
   * it now means that rung can be built without re-deriving history.
   */
  readonly targets?: TargetVerification;
  /** The headline metric's movement, when measurable on both sides. */
  readonly metric?: OutcomeMetricMovement;
  /** Why the attribution landed where it did. Factual; never advisory. */
  readonly reasoning: string;
  /**
   * The windowed evidence behind the rung, when the caller supplied history.
   * Absent otherwise — and then the rung is exactly what it always was.
   */
  readonly evidence?: AttributionEvidence;
  /**
   * What became of the finding the action answered, when recorded runs since the
   * completion allow it to be said. Completing an action never implies this.
   */
  readonly resolution?: FindingResolution;
  /** Optional realised value. Never produced in this tranche. */
  readonly value?: Value;
  /** ISO-8601 timestamp of when the outcome was assessed. Injected. */
  readonly recordedAt: string;
  /**
   * What kind of evidence each half of the outcome rests on. Always present, so
   * no consumer can mistake a staff declaration for an observed result by
   * reading around it.
   */
  readonly evidenceQuality: OutcomeEvidenceQuality;
}

/** The evidence behind an outcome, by kind and by when it was known. */
export interface OutcomeEvidenceQuality {
  /** The action itself: a staff declaration, or derived from clinic data. */
  readonly completion: EvidenceSource;
  /** What `completedAt` records: when Done was pressed, never when the work was done. */
  readonly completionTime: CompletionTimeMeaning;
  /**
   * The targets' results, when a population was checked: how many rest on a
   * record of the event, how many on a staff record or an unstated one, and how
   * they were read. Null when nothing could be checked.
   */
  readonly results: {
    readonly objectivelyObserved: number;
    readonly notObserved: number;
    readonly timing: EvidenceTiming;
  } | null;
  /** Whether everything the upper rungs rest on was on record by the moment it stands for. */
  readonly pointInTime: boolean;
}

// ── Windowed evidence ─────────────────────────────────────────────────────────

/** One requirement of the attribution ladder, and whether it held. */
export interface AttributionRequirement {
  readonly key:
    | "window_closed"
    | "metric_measured_at_horizon"
    | "baseline_established"
    | "beyond_normal_variation"
    | "targets_sufficient"
    | "targets_confirmed"
    | "concentrated_in_targets"
    | "competing_explanations_checked"
    | "no_competing_explanation"
    | "data_complete"
    | "evidence_point_in_time"
    | "repeated_across_comparable_actions"
    | "consistent_across_comparable_actions"
    | "spread_across_weeks";
  /** True held, false did not, null could not be determined (and so did not hold). */
  readonly met: boolean | null;
  readonly detail: string;
}

/** Something other than the action that could account for what followed. */
export interface CompetingExplanation {
  readonly kind: "pre_existing_trend" | "overlapping_action" | "simultaneous_shift";
  readonly detail: string;
}

export interface AttributionEvidence {
  /** Days after completion at which the evidence is read. Fixed per category. */
  readonly horizonDays: number | null;
  /** ISO-8601 end of the window, or null when the category has no horizon. */
  readonly windowEndsAt: string | null;
  /** "open" until the horizon has passed; nothing above observed_after before then. */
  readonly window: "open" | "closed" | "not_applicable";
  readonly metric: {
    readonly key: string;
    readonly atCompletion: number;
    /** The stored reading at the horizon (within tolerance), or null when absent. */
    readonly atHorizon: number | null;
    readonly horizonDate: string | null;
    /** Helpful-direction change at the horizon; negative when it worsened. */
    readonly improvement: number | null;
    /** Half-width of this clinic's normal band before the completion, or null. */
    readonly normalVariation: number | null;
    /** Stored days the band rests on. */
    readonly baselineDays: number;
  } | null;
  readonly targets: {
    readonly verifiable: boolean;
    readonly resolvable: number;
    /** Targets showing the intended result within the horizon. */
    /** Targets whose result within the horizon is on a record of the event itself. */
    readonly confirmedWithinWindow: number;
    /** Targets whose result within the horizon rests only on a staff record, or an unstated one. Never counted. */
    readonly declaredWithinWindow: number;
    /** Median days from completion to the result, across confirmed targets. */
    readonly medianDaysToResult: number | null;
    /** Days from completion to each result within the horizon, ascending. No patient beside them. */
    readonly daysToResult: readonly number[];
  } | null;
  readonly competing: readonly CompetingExplanation[];
  readonly requirements: readonly AttributionRequirement[];
  /** Earlier comparable completions at this clinic whose evidence was read. */
  readonly comparable: {
    readonly assessable: number;
    readonly likelyContributed: number;
    readonly distinctWeeks: number;
  };
  /**
   * How far the evidence supports the rung. Reduced by competing explanations and
   * gaps; data completeness, never a probability that the action worked.
   */
  readonly confidence: number;
}

// ── Resolution ────────────────────────────────────────────────────────────────

export const ResolutionStatus = {
  /** The finding is still flagged, with no sign of improvement. */
  STILL_ACTIVE: "still_active",
  /** Still flagged, but less severely or with its metric recovering. */
  IMPROVING: "improving",
  /** Absent on enough consecutive recorded days since the completion. */
  RESOLVED: "resolved",
  /** The action's intended result was observed, and the finding is still flagged. */
  OUTCOME_OBSERVED_UNRESOLVED: "outcome_observed_unresolved",
  /** Too few recorded days since the completion to say. */
  INSUFFICIENT_EVIDENCE: "insufficient_evidence",
} as const;

export type ResolutionStatus = (typeof ResolutionStatus)[keyof typeof ResolutionStatus];

export interface FindingResolution {
  readonly status: ResolutionStatus;
  /** The finding the action answered, `finding.<kind>:<constraintId>`. */
  readonly parentFindingId: string;
  /** Recorded days (snapshots and today) after the completion date. */
  readonly observedDays: number;
  /** Most recent recorded day on which the category was flagged, or null. */
  readonly lastFlaggedOn: string | null;
  /** Consecutive most-recent recorded days on which it was not flagged. */
  readonly consecutiveClearDays: number;
  readonly statement: string;
}
