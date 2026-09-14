/**
 * Business Brain — Domain: Finding
 *
 * One shape for everything the Business Brain has to say, so it can be weighed
 * as ONE list instead of four modules competing for the same screen.
 *
 * A Finding is a NORMALISED VIEW of an object an existing producer already
 * emitted — a Constraint, an Opportunity, an Achievement, an action Outcome. It
 * adds no detection of its own. Every figure on it is copied from, or computed
 * directly out of, the source object, and `source` names that object so any
 * finding can be traced back to the engine that decided it exists.
 *
 * ## Kinds, by tense and polarity — never by new logic
 *
 *   problem           a loss or shortfall that has already happened
 *   operational_risk  a standing process condition that keeps costing while it lasts
 *   early_warning     a measured shortfall in time still ahead
 *   opportunity       a measured surplus paired with measured demand
 *   win               a measured improvement, or what was observed after an action
 *
 * The kind of a constraint comes from a fixed table keyed on its category (see
 * the normaliser). Nothing here predicts anything: an early warning is a
 * forward-looking MEASUREMENT (the coming week is thinly booked), not a forecast.
 */

import type { Confidence, Severity } from "../types";
import type { Persistence } from "./diagnosis";
import type { RootCauseAnalysis } from "./root-cause";
import type { MetricTrajectory, TrajectoryLifecycle } from "./trajectory";

export const FindingKind = {
  PROBLEM: "problem",
  OPERATIONAL_RISK: "operational_risk",
  EARLY_WARNING: "early_warning",
  OPPORTUNITY: "opportunity",
  WIN: "win",
} as const;

export type FindingKind = (typeof FindingKind)[keyof typeof FindingKind];

/** The existing object a finding normalises. */
export interface FindingSource {
  readonly producer: "constraint" | "opportunity" | "achievement" | "outcome" | "trajectory";
  readonly id: string;
}

/** What the finding is about, so two findings about one thing can be recognised. */
export const FindingResource = {
  RECEIVABLES: "receivables",
  PLANNED_TREATMENT: "planned_treatment",
  CHAIR_TIME_TODAY: "chair_time_today",
  CHAIR_TIME_AHEAD: "chair_time_ahead",
  LOST_APPOINTMENTS: "lost_appointments",
  RECALL: "recall",
  LAPSED_PATIENTS: "lapsed_patients",
  PATIENT_FLOW: "patient_flow",
  BOOKING_TEMPLATE: "booking_template",
  NEW_PATIENTS: "new_patients",
  /** A win is about one measured metric. */
  METRIC: "metric",
} as const;

export type FindingResource = (typeof FindingResource)[keyof typeof FindingResource];

/** A recorded figure the finding rests on, with its unit. */
export interface FindingMeasure {
  readonly value: number;
  readonly unit: "currency" | "minutes" | "patients" | "appointments" | "treatments" | "count" | "percentage" | "days";
  readonly label: string;
}

/** Recognised gaps in the data behind a finding. Each lowers confidence; none zeroes it. */
export interface DataQualityNote {
  readonly note: string;
  /** How much confidence this gap removed. */
  readonly penalty: number;
}

export type FindingTrend = "worsening" | "steady" | "improving" | "unknown";

/** Everything the prioritiser is allowed to read. Nothing else counts. */
export interface FindingEvidence {
  /** Severity, for findings produced by a constraint. */
  readonly severity: Severity | null;
  /** Priority the Opportunity Engine assigned from its own measured rules. */
  readonly opportunityPriority: "low" | "medium" | "high" | "critical" | null;
  /** The primary recorded amount at stake, when one is measured. */
  readonly impact: FindingMeasure | null;
  /** Other measured quantities: affected patients, open minutes. */
  readonly scope: readonly FindingMeasure[];
  /** ISO-8601 moment after which acting is no longer possible, when there is one. */
  readonly expiresAt: string | null;
  /** The producer's own timeframe, when it set one. */
  readonly timeframe: "today" | "this_week" | "soon" | "ongoing" | null;
  readonly persistence: Persistence | null;
  readonly consecutiveDays: number | null;
  readonly trend: FindingTrend;
  /** Confidence after data-quality penalties, floored above zero. */
  readonly confidence: Confidence;
  /** The producer's confidence before penalties. */
  readonly sourceConfidence: Confidence;
  readonly dataQuality: readonly DataQualityNote[];
  /** Whether prepared actions exist for it. */
  readonly actionable: boolean;
  readonly primaryActionId: string | null;
  /**
   * How the metrics behind this finding have been moving, lead trajectory first.
   * Empty when no tracked metric describes it. The evidence behind every
   * trajectory statement travels here, unabridged.
   */
  readonly trajectories: readonly MetricTrajectory[];
  /** The lead trajectory's lifecycle, when there is one. */
  readonly lifecycle: TrajectoryLifecycle | null;
  /**
   * Where this finding is concentrated in the ledger, when the Root-Cause Engine
   * investigated it. Evidence ON the finding — never a finding of its own. An
   * analysis that found nothing, or had too little to look at, is kept too.
   */
  readonly rootCauses: readonly RootCauseAnalysis[];
  /**
   * What this clinic's memory says about the finding, when a memory was supplied
   * and an ACTIVE entry supports it. Supporting evidence only: no ranking factor
   * reads it, and it never changes stakes, urgency, trend or confidence.
   */
  readonly memory?: FindingMemoryContext;
}

/** Memory context on one finding. Identifiers and numbers; the sentence is rendered at read time. */
export interface FindingMemoryContext {
  /** The finding's category has recurred in separate episodes. */
  readonly recurrence: {
    readonly memoryId: string;
    readonly episodes: number;
    readonly windowDays: number;
    readonly typicalResolutionDays: number | null;
    readonly confidence: number;
    readonly builtFor: string;
  } | null;
  /** The lead metric today, against this clinic's own active normal range. */
  readonly normalRange: {
    readonly memoryId: string;
    readonly metricKey: string;
    readonly label: string;
    readonly current: number;
    readonly median: number;
    readonly lower: number;
    readonly upper: number;
    readonly direction: "above" | "below" | null;
    readonly confidence: number;
    readonly builtFor: string;
  } | null;
}

export interface Finding {
  /** `finding.<kind>:<source id>` */
  readonly id: string;
  readonly kind: FindingKind;
  readonly polarity: "negative" | "positive" | "opportunity";
  readonly source: FindingSource;
  readonly clinicId: string;
  readonly date: string;
  /** Short name, copied from the producer. */
  readonly title: string;
  readonly resource: FindingResource;
  /** Constraint category, when the source is a constraint or links to one. */
  readonly category: string | null;
  /** The constraint this finding is, or is attached to. */
  readonly constraintId: string | null;
  readonly evidence: FindingEvidence;
}

// ── Prioritisation output ────────────────────────────────────────────────────

/** The ordinal facts a ranking decision is made from, in the order they are compared. */
export interface RankFactors {
  /** 0 (info) … 4 (critical), from severity or opportunity priority. */
  readonly stakes: number;
  readonly confidenceBand: "high" | "moderate" | "low";
  /** Stakes after a low-confidence finding is lowered one level. */
  readonly effectiveStakes: number;
  /** 3 within 24h, 2 within 72h, 1 within 7 days, 0 no deadline. */
  readonly urgency: number;
  /** 2 worsening, 1 steady or unknown, 0 improving. */
  readonly trend: number;
  readonly consecutiveDays: number;
  readonly affectedPatients: number | null;
  /**
   * 1 when a root-cause analysis located where the finding is concentrated with
   * at least moderate confidence, else 0. A tie-break only: a located problem is
   * readier to act on, not more serious.
   */
  readonly located: number;
}

export type FindingRole = "top" | "next" | "supporting" | "win" | "no_action";

export interface RankedFinding {
  readonly finding: Finding;
  readonly role: FindingRole;
  /** Position in the single action order, 1-based. Null for wins and no-action findings. */
  readonly rank: number | null;
  readonly factors: RankFactors;
  /** Why it sits where it does, in measured terms. */
  readonly explanation: string;
  /** Which factor put it above the finding ranked immediately below, and how. */
  readonly comparedWithNext: string | null;
  /** The lead finding this one was collapsed into, when it was. */
  readonly supports: string | null;
  readonly collapseReason: string | null;
}

export interface PrioritizedFindings {
  readonly clinicId: string;
  readonly date: string;
  readonly generatedAt: string;
  /** The single most important finding, or null when nothing needs action. */
  readonly top: RankedFinding | null;
  /** The next few, in order. */
  readonly next: readonly RankedFinding[];
  /** Findings collapsed into a lead, and actionable findings ranked below the next few. */
  readonly supporting: readonly RankedFinding[];
  /** Positive findings. Never in `top` or `next`. */
  readonly wins: readonly RankedFinding[];
  /** Findings measured but not needing action, each saying why. */
  readonly noActionRequired: readonly RankedFinding[];
  /** Things that could not be measured this run — reported, never scored as zero. */
  readonly unmeasured: readonly { readonly source: string; readonly reason: string }[];
}
