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
 * Only the first two rungs exist. The ladder is deliberately designed with room
 * above them — `likely_contributed` needs a baseline's normal-variation test and
 * entity concentration, `strong_evidence` needs repetition across periods — but
 * neither is implemented, and an Outcome may not report them.
 *
 * The ladder only ever climbs. A worsening is NEVER attributed to an action:
 * the data cannot support the claim in either direction, and the harm of telling
 * a clinic their work made things worse far exceeds the benefit of occasionally
 * being right.
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
  /** Of the resolvable targets, how many show the intended result. */
  readonly confirmed: number;
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
  /** Optional realised value. Never produced in this tranche. */
  readonly value?: Value;
  /** ISO-8601 timestamp of when the outcome was assessed. Injected. */
  readonly recordedAt: string;
}
