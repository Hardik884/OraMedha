/**
 * Business Brain — Achievement Engine: the declared catalogue
 *
 * Which metrics can produce a positive finding, and the four numbers each one
 * needs before a movement counts as an improvement rather than as noise.
 *
 * ## Why a small declared list rather than every metric
 *
 * Most of the 32 metrics have no meaningful "good" direction. `appointments
 * .total_today` going up is not an achievement — it is a Tuesday. Deriving
 * direction automatically would produce exactly the meaningless praise this layer
 * is supposed to avoid, so every entry here is a deliberate judgement that the
 * metric has a direction a clinic would recognise as better.
 *
 * ## The four numbers, and what each one prevents
 *
 * `direction` — which way is better. Without it a falling collection rate and a
 * falling no-show rate look identical.
 *
 * `minimumDelta` — the absolute floor, in the metric's own unit. A ₹400 drop in
 * outstanding balance clears any statistical band on a quiet clinic and is not
 * worth a line on the page.
 *
 * `alreadyGoodAt` — the level at which further improvement stops being news. A
 * clinic whose BASELINE is already past this was already good at the thing, and
 * saying so implies it changed. This is the gate that keeps a strong clinic's
 * page from filling with congratulation.
 *
 * `dimension` — which of the six score dimensions the win belongs to, so a win
 * and the score movement it caused can be reconciled rather than read as two
 * unrelated numbers.
 */

import { ClinicDimension } from "../../domain";
import { BaselineDirection } from "../baseline";
import { MetricKey } from "../metrics/metric-ids";

export interface AchievementSpec {
  readonly metricKey: string;
  readonly dimension: ClinicDimension;
  readonly direction: BaselineDirection;
  /**
   * Smallest movement worth reporting, in the metric's own unit — percentage
   * points, minutes, patients, or rupees.
   */
  readonly minimumDelta: number;
  /**
   * The value at which this metric is already good enough that improving it is
   * not a finding. Compared against the BASELINE, not against today: the
   * question is whether the clinic was already good at this, not whether it is
   * good now.
   */
  readonly alreadyGoodAt: number;
}

/**
 * Every metric that can produce an achievement.
 *
 * Seven entries covering all six dimensions. Each was chosen because a clinic
 * would recognise the direction without being told, and because the metric is a
 * WINDOW rather than a single day — a one-day figure moving is weather, and a
 * positive finding built on it would be retracted by Thursday.
 */
export const ACHIEVEMENT_SPECS: readonly AchievementSpec[] = [
  {
    metricKey: MetricKey.SCHEDULING_NO_SHOW_RATE_30D,
    dimension: ClinicDimension.ATTENDANCE,
    direction: BaselineDirection.LOWER_IS_BETTER,
    // Two percentage points. Below that, one appointment in a small book moves it.
    minimumDelta: 2,
    // At or below 4% a clinic has essentially solved no-shows.
    alreadyGoodAt: 4,
  },
  {
    metricKey: MetricKey.SCHEDULING_CANCELLATION_RATE_30D,
    dimension: ClinicDimension.ATTENDANCE,
    direction: BaselineDirection.LOWER_IS_BETTER,
    minimumDelta: 2,
    alreadyGoodAt: 5,
  },
  {
    metricKey: MetricKey.CAPACITY_CHAIR_UTILIZATION_30D,
    dimension: ClinicDimension.SCHEDULE_HEALTH,
    direction: BaselineDirection.HIGHER_IS_BETTER,
    minimumDelta: 5,
    // Above 85% over a month the constraint is capacity, not utilization, and
    // pushing further is a different conversation.
    alreadyGoodAt: 85,
  },
  {
    metricKey: MetricKey.REVENUE_COLLECTION_RATE_30D,
    dimension: ClinicDimension.FINANCIAL_HEALTH,
    direction: BaselineDirection.HIGHER_IS_BETTER,
    minimumDelta: 4,
    alreadyGoodAt: 95,
  },
  {
    metricKey: MetricKey.FOLLOWUPS_OVERDUE,
    dimension: ClinicDimension.RETENTION_RECALL,
    direction: BaselineDirection.LOWER_IS_BETTER,
    // Three patients. One or two is the ordinary churn of a recall list.
    minimumDelta: 3,
    alreadyGoodAt: 2,
  },
  {
    metricKey: MetricKey.QUEUE_AVERAGE_WAITING_TIME,
    dimension: ClinicDimension.PATIENT_FLOW,
    direction: BaselineDirection.LOWER_IS_BETTER,
    minimumDelta: 5,
    // Ten minutes in a waiting room is not a problem anybody needs told about.
    alreadyGoodAt: 10,
  },
  {
    metricKey: MetricKey.TREATMENT_ACCEPTED_PENDING_SCHEDULING,
    dimension: ClinicDimension.TREATMENT_PIPELINE,
    direction: BaselineDirection.LOWER_IS_BETTER,
    minimumDelta: 3,
    alreadyGoodAt: 2,
  },
];

/** Lookup by metric key. */
export const ACHIEVEMENT_SPEC_BY_KEY: ReadonlyMap<string, AchievementSpec> = new Map(
  ACHIEVEMENT_SPECS.map((spec) => [spec.metricKey, spec]),
);
