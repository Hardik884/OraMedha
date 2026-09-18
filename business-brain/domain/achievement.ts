/**
 * Business Brain — Domain: Achievement
 *
 * A measured improvement against this clinic's own recorded normal.
 *
 * ## Why this is a sibling of Constraint, not a stage after it
 *
 * A Constraint is a bottleneck: something limiting the clinic, derived from
 * diagnoses. An Achievement is the opposite reading of the same kind of evidence
 * — a metric that has moved outside this clinic's usual range in the direction
 * that helps — and it is derived from baselines rather than from diagnoses.
 * Neither depends on the other, and neither is downstream of the other.
 *
 * ## What an Achievement is NOT
 *
 * It is not praise, and it carries no advice. It states what moved, what it moved
 * against, by how much, and for how long. It never says the clinic did something
 * well, because nothing here can know who or what caused the movement — the
 * attribution machinery that could say so does not exist, and inventing it here
 * would be the same fabrication the rest of this module refuses.
 *
 * It is also never emitted for a metric the clinic was already comfortably good
 * at. Improvement from excellent to slightly-more-excellent is arithmetic, not
 * news, and a strip full of those is the positive-intelligence version of alert
 * fatigue.
 */

import type { Confidence } from "../types";

/**
 * The clinic dimension an achievement speaks about.
 *
 * Deliberately the SAME six dimensions the Clinic Score is grouped by, so a win
 * and the score movement it belongs to can be reconciled on screen. Acquisition
 * is absent on purpose: one noisy daily count is not a dimension, and it is not
 * one here either.
 */
export const ClinicDimension = {
  SCHEDULE_HEALTH: "schedule_health",
  ATTENDANCE: "attendance",
  PATIENT_FLOW: "patient_flow",
  FINANCIAL_HEALTH: "financial_health",
  TREATMENT_PIPELINE: "treatment_pipeline",
  RETENTION_RECALL: "retention_recall",
} as const;

export type ClinicDimension = (typeof ClinicDimension)[keyof typeof ClinicDimension];

/**
 * One measured improvement.
 *
 * Carries facts and figures only. The plain-language sentences a dentist reads
 * are written in the view layer (`lib/business-brain/wins-view.ts`), the same
 * split the problem cards already use — the engines state measurements, the
 * projection writes English.
 */
export interface Achievement {
  /** Stable id, `achievement.<metricKey>:<clinicId>:<date>`. */
  readonly id: string;
  /** The metric that moved, e.g. "scheduling.no_show_rate_30d". */
  readonly metricKey: string;
  readonly dimension: ClinicDimension;
  /** Today's measured value. */
  readonly current: number;
  /** This clinic's median for the metric, over the observed history. */
  readonly baseline: number;
  /** `current - baseline`. Signed: its direction is the metric's, not a verdict. */
  readonly delta: number;
  /** The edge of the normal band the value cleared. */
  readonly bandEdge: number;
  /** How many days of history the baseline rests on. */
  readonly observations: number;
  /**
   * Which days the baseline was built from: every recorded day, or only those
   * comparable to this one — the same weekday, the same time of year.
   *
   * Carried because it changes what the figures MEAN. "Nine days of your own
   * records" and "your last nine Tuesdays" are different claims, and
   * {@link consecutiveDays} counts the days of whichever series this is. Optional
   * so a caller constructing an Achievement by hand need not restate it; absent
   * reads as every recorded day.
   */
  readonly basis?: "all_days" | "same_weekday" | "same_time_of_year" | "same_weekday_in_season";
  /** The weekday the baseline is specific to, 0 = Sunday, when it is. */
  readonly weekday?: number | null;
  /**
   * Consecutive most-recent days (today included) on the improving side of the
   * band. Always at least 1 — an achievement requires today to be outside it.
   *
   * On a weekday-specific baseline these are consecutive SAME WEEKDAYS: three
   * means three Tuesdays, which is three weeks. {@link basis} is what lets a
   * reader say so instead of "three days running".
   */
  readonly consecutiveDays: number;
  /**
   * Whether the improvement has held long enough to be more than one good day.
   *
   * False is a legitimate, reportable state — but it must be LABELLED as a
   * single day rather than presented as a trend, which is why it travels on the
   * object instead of being filtered out silently.
   */
  readonly sustained: boolean;
  /** Data completeness behind the baseline. Never a probability. */
  readonly confidence: Confidence;
  /** ISO-8601, injected. The engine never reads the clock. */
  readonly measuredAt: string;
}
