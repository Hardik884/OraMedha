/**
 * Business Brain — Trajectory Engine: which metrics can have a trajectory
 *
 * A metric qualifies only if a daily series of it is meaningful to compare week
 * with week. That rules out, deliberately:
 *
 *   - today-only counts (appointments today, collected today, new patients
 *     today): a Tuesday and a Saturday are different populations, not points on
 *     a line
 *   - point-in-time readings (patients waiting right now)
 *   - configuration-driven capacity (open minutes, slots): they move when a
 *     rule is edited, not when the clinic changes
 *   - small-sample guards (repeat non-attenders, measured visits): a change of
 *     one patient is a large percentage and means nothing
 *   - cumulative money levels (outstanding, pending treatment value): treatment
 *     status is not versioned, so a recomputed historical day can carry today's
 *     statuses, and a slope through that would be partly an artefact
 *   - volume totals (production, collected): they track how busy the month was;
 *     the collection RATE is the trajectory that means something
 *
 * `minimumStep` is the smallest week-over-week change, in the metric's own unit,
 * that counts as movement. Smaller changes are "flat" — a 30-day rate drifting
 * by a tenth of a point is noise, not a trend.
 */

import { ConstraintCategory } from "../../domain";
import { MetricKey } from "../metrics/metric-ids";

export interface TrajectorySpec {
  readonly metricKey: string;
  readonly label: string;
  readonly worseWhen: "higher" | "lower";
  readonly minimumStep: number;
  /** The constraint category describing the same underlying issue, when there is one. */
  readonly category: ConstraintCategory | null;
}

export const TRAJECTORY_CATALOG: readonly TrajectorySpec[] = [
  {
    metricKey: MetricKey.SCHEDULING_CANCELLATION_RATE_30D,
    label: "The 30-day cancellation rate",
    worseWhen: "higher",
    minimumStep: 1,
    category: ConstraintCategory.SCHEDULING,
  },
  {
    metricKey: MetricKey.SCHEDULING_NO_SHOW_RATE_30D,
    label: "The 30-day no-show rate",
    worseWhen: "higher",
    minimumStep: 1,
    category: ConstraintCategory.SCHEDULING,
  },
  {
    metricKey: MetricKey.SCHEDULING_BOOKING_LEAD_TIME_DAYS,
    label: "Booking lead time",
    worseWhen: "higher",
    minimumStep: 0.5,
    // Supporting-only in the Diagnosis Engine: no constraint ever represents it,
    // so a trajectory is the only place it can surface.
    category: null,
  },
  {
    metricKey: MetricKey.CAPACITY_CHAIR_UTILIZATION_30D,
    label: "30-day chair utilization",
    worseWhen: "lower",
    minimumStep: 2,
    category: ConstraintCategory.CAPACITY,
  },
  {
    metricKey: MetricKey.CAPACITY_BOOKED_NEXT_7D,
    label: "The share of next week's chair time booked",
    worseWhen: "lower",
    minimumStep: 3,
    category: ConstraintCategory.FORWARD_SCHEDULE,
  },
  {
    metricKey: MetricKey.FOLLOWUPS_OVERDUE,
    label: "The number of overdue follow-ups",
    worseWhen: "higher",
    minimumStep: 1,
    category: ConstraintCategory.RETENTION,
  },
  {
    metricKey: MetricKey.QUEUE_AVERAGE_WAITING_TIME,
    label: "Average waiting time",
    worseWhen: "higher",
    minimumStep: 3,
    category: ConstraintCategory.PATIENT_FLOW,
  },
  {
    metricKey: MetricKey.SCHEDULING_APPOINTMENT_OVERRUN_30D,
    label: "The 30-day appointment overrun",
    worseWhen: "higher",
    minimumStep: 3,
    category: ConstraintCategory.SCHEDULE_ACCURACY,
  },
  {
    metricKey: MetricKey.REVENUE_PRODUCTION_PAID_RATE_30D,
    label: "The share of delivered work that has been paid for",
    worseWhen: "lower",
    minimumStep: 2,
    category: ConstraintCategory.REVENUE_LEAKAGE,
  },
  {
    metricKey: MetricKey.PATIENTS_REACTIVATION_CANDIDATES,
    label: "The number of patients seen before, not back, with nothing booked",
    worseWhen: "higher",
    minimumStep: 1,
    category: ConstraintCategory.REACTIVATION,
  },
];

/** Metrics deliberately given no trajectory, with the reason. */
export const NO_TRAJECTORY: Readonly<Record<string, string>> = {
  [MetricKey.APPOINTMENTS_TOTAL_TODAY]: "a single day's count; weekdays are not comparable points",
  [MetricKey.APPOINTMENTS_CANCELLED_TODAY]: "a single day's count; the 30-day rate carries the trajectory",
  [MetricKey.APPOINTMENTS_NO_SHOWS_TODAY]: "a single day's count; the 30-day rate carries the trajectory",
  [MetricKey.SCHEDULING_REPEAT_NON_ATTENDERS_30D]: "a small-sample count where one patient is a large swing",
  [MetricKey.SCHEDULING_MEASURED_VISITS_30D]: "a sample-size guard, not an outcome",
  [MetricKey.SCHEDULING_APPOINTMENTS_30D]: "a sample-size guard, not an outcome; its own movement is booking volume, which the forward window carries",
  [MetricKey.PATIENTS_NEW_TODAY]: "a single day's count",
  [MetricKey.PATIENTS_RETURNING_TODAY]: "a single day's count; reactivation candidates carry the retention trajectory",
  [MetricKey.REVENUE_COLLECTED_TODAY]: "a single day's total",
  [MetricKey.REVENUE_OUTSTANDING]: "a cumulative level whose recomputed history carries today's unversioned treatment statuses",
  [MetricKey.REVENUE_OUTSTANDING_ON_PAYMENT_PLAN]: "a cumulative level; same versioning residual as outstanding",
  [MetricKey.REVENUE_PENDING_TREATMENT_VALUE]: "a cumulative level; same versioning residual",
  [MetricKey.REVENUE_PRODUCTION_30D]: "a volume total that tracks how busy the month was; the collection rate carries the trajectory",
  [MetricKey.REVENUE_COLLECTED_30D]: "a volume total; the paid-for rate carries the trajectory",
  [MetricKey.REVENUE_COLLECTION_RATE_30D]: "cash in against work out over the same window — two different cohorts of work, so its movement mixes old debt being cleared with this month's collections; revenue.production_paid_rate_30d carries the trajectory",
  [MetricKey.REVENUE_PRODUCTION_UNPAID_30D]: "a level in money that tracks how busy the month was; the rate over it carries the trajectory",
  [MetricKey.QUEUE_PATIENTS_WAITING]: "a point-in-time reading",
  [MetricKey.FOLLOWUPS_DUE_TODAY]: "a single day's count",
  [MetricKey.TREATMENT_ACCEPTED_PENDING_SCHEDULING]: "a patient-level approximation that under-reports; its movement cannot be separated from the approximation",
  [MetricKey.TREATMENT_COMPLETED_TODAY]: "a single day's count",
  [MetricKey.TREATMENT_AVERAGE_CASE_VALUE_30D]: "moves with case mix, which is not a deterioration",
  [MetricKey.CAPACITY_CHAIR_UTILIZATION]: "a single day's utilization, shaped by the weekday; the 30-day figure carries the trajectory",
  [MetricKey.CAPACITY_AVAILABLE_SLOTS_TODAY]: "moves when availability rules are edited",
  [MetricKey.CAPACITY_OPEN_MINUTES_TODAY]: "moves when availability rules are edited",
  [MetricKey.CAPACITY_APPOINTMENT_CAPACITY_TODAY]: "moves when availability rules are edited",
};
