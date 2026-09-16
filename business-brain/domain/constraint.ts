/**
 * Business Brain — Domain: Constraint
 *
 * The primary bottleneck limiting the clinic (e.g. Low treatment acceptance,
 * Poor scheduling, Revenue leakage). A Constraint is the single most important
 * thing to solve, usually derived from diagnoses.
 */

import type { Severity } from "../types";

/**
 * The kind of bottleneck a constraint represents.
 */
export const ConstraintCategory = {
  TREATMENT_ACCEPTANCE: "treatment_acceptance",
  SCHEDULING: "scheduling",
  REVENUE_LEAKAGE: "revenue_leakage",
  CAPACITY: "capacity",
  RETENTION: "retention",
  ACQUISITION: "acquisition",
  /**
   * Chair time offered over the coming week and not yet sold.
   *
   * Deliberately NOT folded into CAPACITY, even though both describe the same
   * resource. CAPACITY is sized and worded entirely in terms of the day that has
   * just happened — the Value Engine measures it as today's open minutes that
   * went unbooked — so a finding about next Thursday landing in that bucket
   * would be handed today's idle-minutes figure as its value and today's
   * "your chair was empty" wording as its explanation. Both would be wrong, and
   * wrong in the confident voice the rest of the pipeline works to avoid.
   *
   * The distinction that matters to a clinic is not the resource, it is the
   * tense: capacity already lost cannot be recovered, capacity still ahead can
   * be filled. They warrant different words and different actions.
   */
  FORWARD_SCHEDULE: "forward_schedule",
  /**
   * Patients waiting, and the day running behind.
   *
   * Deliberately NOT folded into CAPACITY, for the mirror image of the reason
   * FORWARD_SCHEDULE is not. CAPACITY is sized and worded entirely as chair time
   * that went UNUSED — the Value Engine measures it as today's open minutes that
   * went unbooked, and the briefing titles it "your chair was empty today". A
   * queue is the opposite finding about the same resource: the chairs were busy
   * (or badly arranged) and people sat in the waiting room. Routed into CAPACITY
   * it was handed the empty-chair wording and the empty-minutes figure, so a
   * clinic whose patients waited fifty minutes read a card telling them their
   * chair was idle.
   *
   * Same resource, opposite direction. That warrants its own words, its own
   * figure and its own action, exactly as the tense difference does for
   * FORWARD_SCHEDULE.
   */
  PATIENT_FLOW: "patient_flow",
  /**
   * Patients seen once and gone quiet, with nothing booked and nothing on the
   * recall list.
   *
   * Separate from RETENTION because they are different populations needing
   * different work, and conflating them was already producing an incoherent
   * card. RETENTION is about patients the clinic DECIDED to bring back —
   * follow-ups it raised and returning volume it can compare against a prior
   * period. This is about patients nobody decided anything about: no follow-up
   * exists, so no backlog can ever grow, so the clinic's recall list looks clean
   * while the base quietly empties.
   *
   * The Value Engine used to size RETENTION with the reactivation count while
   * the card's own words counted overdue follow-ups. Splitting the categories is
   * what lets each be sized by the population it actually describes.
   */
  REACTIVATION: "reactivation",
  /**
   * The gap between the time appointments are booked for and the time they take.
   *
   * Its own bottleneck rather than CAPACITY or PATIENT_FLOW, because it is the
   * only one of the three that is a property of the BOOKING rather than of a
   * day. Capacity and flow describe what happened on a date; this describes a
   * template the clinic applies to every future date, which is both why it is
   * measured over a window and why acting on it changes days that have not
   * happened yet.
   */
  SCHEDULE_ACCURACY: "schedule_accuracy",
} as const;

export type ConstraintCategory =
  (typeof ConstraintCategory)[keyof typeof ConstraintCategory];

/**
 * A bottleneck affecting clinic performance.
 */
export interface Constraint {
  /** Stable identifier for this constraint. */
  readonly id: string;
  /** Short name (e.g. "Low treatment acceptance"). */
  readonly name: string;
  /** Fuller description of the bottleneck and its impact. */
  readonly description: string;
  /** The kind of bottleneck. */
  readonly category: ConstraintCategory;
  /** How severely it limits the clinic. */
  readonly severity: Severity;
  /** Ids of the diagnoses that point to this constraint. */
  readonly relatedDiagnosisIds?: readonly string[];
  /** ISO-8601 timestamp of when the constraint was identified. */
  readonly identifiedAt: string;
}
