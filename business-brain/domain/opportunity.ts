/**
 * Business Brain — Domain: Opportunity
 *
 * A measured SURPLUS paired with a measured DEMAND that the clinic can act on
 * before the window closes.
 *
 * A problem says something went wrong. An opportunity says two things the
 * clinic already has — time it has not sold, and patients who already need
 * work — fit together, and names both sides with numbers. That pairing is only
 * possible because OraMedha owns the appointment book, the treatment ledger, the
 * recall list and the payment ledger at once.
 *
 * ## What an opportunity may never be
 *
 * - **One-sided.** Idle chair time alone is a capacity finding, not an
 *   opportunity; a long recall list alone is a retention finding. Both sides
 *   must be measured from recorded rows, or nothing is emitted.
 * - **Invented demand.** Demand is a recorded fact on a patient's own ledger —
 *   planned work, an overdue follow-up, a balance. Never a propensity, a
 *   probability or a lookalike.
 * - **A ranking of patients.** Affected patients are listed with their facts and
 *   explicitly UNRANKED. Choosing who to call first is a clinical and human
 *   judgement the data cannot support.
 * - **A revenue forecast.** `impact` states a recorded amount (a charge, a
 *   quoted plan) or nothing. It never multiplies by a fill rate.
 *
 * ## Where it sits
 *
 * An opportunity is a sibling of Constraint, not a stage after Action. It
 * attaches to the constraint describing the same resource when one fired, and
 * it carries an ordinary `ActionPlan` built from the existing capability
 * catalog — so it is worked through the same prepared, never-performed actions
 * as every other finding.
 */

import type { Confidence, Evidence, Priority } from "../types";
import type { ActionPlan } from "./action";
import type { ConstraintCategory } from "./constraint";
import type { EntityType } from "./shared";

export const OpportunityType = {
  /** Unbooked chair time in the next 7 days × patients waiting for a booking. */
  FORWARD_CAPACITY_MATCH: "forward_capacity_match",
  /** A future appointment cancelled, its slot still open × patients who could take it. */
  FREED_SLOT_REFILL: "freed_slot_refill",
  /** Work already delivered and charged × the recorded balance still owed for it. */
  UNPAID_DELIVERED_WORK: "unpaid_delivered_work",
} as const;

export type OpportunityType = (typeof OpportunityType)[keyof typeof OpportunityType];

export type OpportunityUnit = "appointments" | "treatments" | "minutes" | "patients" | "currency";

/** A number with its unit and what it counts. */
export interface OpportunityQuantity {
  readonly value: number;
  readonly unit: OpportunityUnit;
  /** What was counted, in plain words: "patients with planned treatment and nothing booked". */
  readonly label: string;
}

/** One side of the pairing. */
export interface OpportunitySide {
  readonly description: string;
  /** Primary figure first. */
  readonly measured: readonly OpportunityQuantity[];
  /**
   * True when a bounded read cut the population, so each figure is "at least".
   * Surplus is never emitted as a lower bound — see the engine: overstating
   * capacity is the one error an opportunity must not make.
   */
  readonly lowerBound: boolean;
}

/** A record the opportunity concerns, with the facts that put it there. */
export interface OpportunityEntity {
  readonly type: EntityType;
  readonly id: string;
  /** Measured facts only: pools, ages, amounts. Never a score. */
  readonly facts: Readonly<Record<string, string | number | boolean | null>>;
}

/** When acting on it is possible. */
export interface OpportunityWindow {
  /** ISO-8601 moment the opportunity first becomes actionable. */
  readonly opensAt: string;
  /** ISO-8601 moment it can no longer be acted on, or null when it has no deadline. */
  readonly expiresAt: string | null;
  readonly basis: string;
}

/**
 * What is at stake, when that is a recorded amount.
 *
 * `recorded_value` is the only basis there is. An opportunity whose value would
 * need an estimate — what a refilled slot would earn — carries no impact rather
 * than a guessed one.
 */
export interface OpportunityImpact {
  readonly amount: OpportunityQuantity;
  readonly basis: "recorded_value";
  /** What the figure is, and what it is not. */
  readonly statement: string;
}

export interface Opportunity {
  /** `opportunity.<type>:<clinicId>:<date>[:<entityId>]` */
  readonly id: string;
  readonly type: OpportunityType;
  readonly clinicId: string;
  readonly date: string;
  readonly title: string;
  /** The actionable size: what can actually be done, never more than either side. */
  readonly measuredValue: OpportunityQuantity;
  readonly surplus: OpportunitySide;
  readonly demand: OpportunitySide;
  readonly entities: readonly OpportunityEntity[];
  /** Always "unranked". A literal, so a future ranking has to change the type. */
  readonly entityOrdering: "unranked";
  /** Data completeness, never likelihood of success. */
  readonly confidence: Confidence;
  readonly confidenceBasis: readonly string[];
  readonly evidence: readonly Evidence[];
  readonly window: OpportunityWindow;
  readonly impact: OpportunityImpact | null;
  readonly priority: Priority;
  readonly priorityReason: string;
  /** Constraint categories describing the same resource. */
  readonly relatedCategories: readonly ConstraintCategory[];
  /** The constraint this run raised about the same resource, when one fired. */
  readonly constraintId: string | null;
  /** Other opportunities drawing on the same surplus, so no total double-counts it. */
  readonly overlapsWith: readonly string[];
  /** Prepared work, from the existing capability catalog. Never performed. */
  readonly actionPlan: ActionPlan;
  readonly detectedAt: string;
}

/** Why each opportunity type was or was not emitted. `not_detected` ≠ `insufficient_data`. */
export interface OpportunityAssessment {
  readonly type: OpportunityType;
  readonly outcome: "detected" | "not_detected" | "insufficient_data";
  readonly reason: string;
  readonly detected: number;
}
