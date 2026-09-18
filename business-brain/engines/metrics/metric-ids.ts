/**
 * Business Brain — Metrics Engine: Metric definitions
 *
 * Stable keys, display names, categories, and units for every metric the
 * engine produces. Centralising these keeps calculators tiny and makes adding
 * a new metric a one-line change here plus a calculator function.
 */

import { MetricCategory, MetricUnit } from "../../domain";
import type { Metric } from "../../domain";

/** Stable, machine-readable key for each metric. */
export const MetricKey = {
  // Appointments
  APPOINTMENTS_TOTAL_TODAY: "appointments.total_today",
  APPOINTMENTS_CANCELLED_TODAY: "appointments.cancelled_today",
  APPOINTMENTS_NO_SHOWS_TODAY: "appointments.no_shows_today",
  SCHEDULING_CANCELLATION_RATE_30D: "scheduling.cancellation_rate_30d",
  SCHEDULING_NO_SHOW_RATE_30D: "scheduling.no_show_rate_30d",
  /**
   * Distinct patients who missed 2+ appointments in the trailing window.
   *
   * A rate says how much attrition there is; this says whether it is
   * CONCENTRATED. The two need opposite responses — a broad reminder policy
   * versus a short list of people handled differently — and a rate alone cannot
   * tell them apart.
   */
  SCHEDULING_REPEAT_NON_ATTENDERS_30D: "scheduling.repeat_non_attenders_30d",
  SCHEDULING_BOOKING_LEAD_TIME_DAYS: "scheduling.booking_lead_time_days",
  /**
   * Appointments in the trailing window — the DENOMINATOR both attendance rates
   * are computed from.
   *
   * Its own metric for the same reason {@link SCHEDULING_MEASURED_VISITS_30D} is
   * one: a rate cannot be judged without knowing what it was divided by. A 33%
   * no-show rate over three appointments and over ninety are different claims,
   * and nothing downstream could tell them apart, because the rate arrives as a
   * single number with its denominator already divided away.
   *
   * This is the fact behind the test clinic's "normal no-show range is -0.1% to
   * 66.7%": five appointments a week, so one missed appointment moved the rate
   * twenty points, and the band widened until it described nothing.
   *
   * Counts every appointment in the window whatever its status, which is exactly
   * what `statusRate` divides by — the two must not be able to disagree.
   */
  SCHEDULING_APPOINTMENTS_30D: "scheduling.appointments_30d",
  /**
   * How far the time appointments TAKE diverges from the time they are BOOKED
   * for, across the trailing window (%). Positive means they overrun.
   *
   * Computed from the totals rather than as a mean of per-visit ratios: a
   * 10-minute check that runs 5 minutes long is +50% and barely matters, while an
   * hour-long case that runs 5 minutes long is +8% and matters just as little.
   * Averaging the ratios lets the shortest appointments dominate a figure that is
   * supposed to describe the day.
   */
  SCHEDULING_APPOINTMENT_OVERRUN_30D: "scheduling.appointment_overrun_30d",
  /**
   * Visits behind {@link SCHEDULING_APPOINTMENT_OVERRUN_30D} — those with BOTH a
   * called-in and a finished timestamp.
   *
   * Its own metric because the overrun rate alone cannot be judged: a +40%
   * reading over 4 visits and over 80 are different claims, and the evaluator has
   * no other way to tell them apart. Exactly the role
   * `appointments.total_today` plays as an activity guard for the daily rules.
   */
  SCHEDULING_MEASURED_VISITS_30D: "scheduling.measured_visits_30d",
  // Patients
  PATIENTS_NEW_TODAY: "patients.new_today",
  PATIENTS_RETURNING_TODAY: "patients.returning_today",
  PATIENTS_REACTIVATION_CANDIDATES: "patients.reactivation_candidates",
  // Revenue
  REVENUE_COLLECTED_TODAY: "revenue.collected_today",
  REVENUE_OUTSTANDING: "revenue.outstanding",
  /**
   * Portion of revenue.outstanding covered by an agreed payment plan.
   *
   * A patient paying ₹5,000/month against a ₹50,000 balance and one who
   * has stopped paying entirely both show the same total in revenue.outstanding
   * -- correctly, since both amounts are genuinely owed. This is the fact that
   * tells them apart: how much of the total is already being collected on
   * schedule versus unmanaged. Never subtracted from revenue.outstanding itself
   * -- the money is still owed either way -- only used to size what needs
   * chasing.
   */
  REVENUE_OUTSTANDING_ON_PAYMENT_PLAN: "revenue.outstanding_on_payment_plan",
  REVENUE_PENDING_TREATMENT_VALUE: "revenue.pending_treatment_value",
  REVENUE_PRODUCTION_30D: "revenue.production_30d",
  REVENUE_COLLECTION_RATE_30D: "revenue.collection_rate_30d",
  REVENUE_COLLECTED_30D: "revenue.collected_30d",
  /**
   * Value of the work DELIVERED in the trailing window that has not been paid
   * for.
   *
   * Follows the work rather than the cash, which is the difference between this
   * and {@link REVENUE_COLLECTION_RATE_30D}. Money arriving this month may be
   * settling a crown fitted in March; that is a real and good thing, and it says
   * nothing about whether this month's work is being collected.
   *
   * Attributed by the patient's own balance, capped at what they were charged in
   * the window: because payments settle the oldest charge first, a balance that
   * survives is the most recent work. No payment is allocated to an individual
   * treatment anywhere in OraMedha, and none is invented here.
   */
  REVENUE_PRODUCTION_UNPAID_30D: "revenue.production_unpaid_30d",
  /**
   * Share of the work delivered in the trailing window that has been paid for.
   *
   * The metric {@link REVENUE_COLLECTION_RATE_30D} was believed to be. That one
   * divides this window's CASH by this window's WORK — two different cohorts —
   * so a clinic clearing old debt reads above 100%, and one whose recent work is
   * going unpaid can read healthy while it does. The test clinic's normal
   * collection rate was a median of 115%.
   *
   * Bounded 0..100 by construction, because the unpaid portion is capped at what
   * was charged. Lags by design: work delivered yesterday and not yet paid counts
   * as uncollected, so a clinic that reliably collects at thirty days reads
   * steadily below 100 — and the band it is judged against is its own.
   */
  REVENUE_PRODUCTION_PAID_RATE_30D: "revenue.production_paid_rate_30d",
  // Queue
  QUEUE_PATIENTS_WAITING: "queue.patients_waiting",
  QUEUE_AVERAGE_WAITING_TIME: "queue.average_waiting_time",
  // Follow-ups
  FOLLOWUPS_DUE_TODAY: "followups.due_today",
  FOLLOWUPS_OVERDUE: "followups.overdue",
  // Treatment
  TREATMENT_ACCEPTED_PENDING_SCHEDULING: "treatment.accepted_pending_scheduling",
  TREATMENT_COMPLETED_TODAY: "treatment.completed_today",
  TREATMENT_AVERAGE_CASE_VALUE_30D: "treatment.average_case_value_30d",
  // Capacity
  CAPACITY_CHAIR_UTILIZATION: "capacity.chair_utilization",
  CAPACITY_AVAILABLE_SLOTS_TODAY: "capacity.available_slots_today",
  CAPACITY_CHAIR_UTILIZATION_30D: "capacity.chair_utilization_30d",
  CAPACITY_BOOKED_NEXT_7D: "capacity.booked_next_7d",
  CAPACITY_OPEN_MINUTES_TODAY: "capacity.open_minutes_today",
  CAPACITY_APPOINTMENT_CAPACITY_TODAY: "capacity.appointment_capacity_today",
} as const;

export type MetricKey = (typeof MetricKey)[keyof typeof MetricKey];

/** Static descriptor for a metric: how it is named, categorised, and measured. */
export interface MetricDescriptor {
  readonly key: MetricKey;
  readonly name: string;
  readonly category: MetricCategory;
  readonly unit: MetricUnit;
}

/** Descriptor table for every metric the engine can produce. */
export const METRIC_DESCRIPTORS: Readonly<Record<MetricKey, MetricDescriptor>> = {
  [MetricKey.APPOINTMENTS_TOTAL_TODAY]: {
    key: MetricKey.APPOINTMENTS_TOTAL_TODAY,
    name: "Total Appointments Today",
    category: MetricCategory.SCHEDULING,
    unit: MetricUnit.COUNT,
  },
  [MetricKey.APPOINTMENTS_CANCELLED_TODAY]: {
    key: MetricKey.APPOINTMENTS_CANCELLED_TODAY,
    name: "Cancelled Appointments Today",
    category: MetricCategory.SCHEDULING,
    unit: MetricUnit.COUNT,
  },
  [MetricKey.APPOINTMENTS_NO_SHOWS_TODAY]: {
    key: MetricKey.APPOINTMENTS_NO_SHOWS_TODAY,
    name: "No-Shows Today",
    category: MetricCategory.SCHEDULING,
    unit: MetricUnit.COUNT,
  },
  [MetricKey.SCHEDULING_CANCELLATION_RATE_30D]: {
    key: MetricKey.SCHEDULING_CANCELLATION_RATE_30D,
    name: "Cancellation Rate (30 days)",
    category: MetricCategory.SCHEDULING,
    unit: MetricUnit.PERCENTAGE,
  },
  [MetricKey.SCHEDULING_NO_SHOW_RATE_30D]: {
    key: MetricKey.SCHEDULING_NO_SHOW_RATE_30D,
    name: "No-Show Rate (30 days)",
    category: MetricCategory.SCHEDULING,
    unit: MetricUnit.PERCENTAGE,
  },
  [MetricKey.SCHEDULING_REPEAT_NON_ATTENDERS_30D]: {
    key: MetricKey.SCHEDULING_REPEAT_NON_ATTENDERS_30D,
    name: "Patients Who Missed More Than Once (30 days)",
    category: MetricCategory.SCHEDULING,
    unit: MetricUnit.COUNT,
  },
  [MetricKey.SCHEDULING_BOOKING_LEAD_TIME_DAYS]: {
    key: MetricKey.SCHEDULING_BOOKING_LEAD_TIME_DAYS,
    name: "Median Booking Lead Time",
    category: MetricCategory.SCHEDULING,
    unit: MetricUnit.DAYS,
  },
  [MetricKey.SCHEDULING_APPOINTMENT_OVERRUN_30D]: {
    key: MetricKey.SCHEDULING_APPOINTMENT_OVERRUN_30D,
    name: "Appointments Running Over Their Booked Time (30 days)",
    category: MetricCategory.SCHEDULING,
    unit: MetricUnit.PERCENTAGE,
  },
  [MetricKey.SCHEDULING_APPOINTMENTS_30D]: {
    key: MetricKey.SCHEDULING_APPOINTMENTS_30D,
    name: "Appointments Booked (30 days)",
    category: MetricCategory.SCHEDULING,
    unit: MetricUnit.COUNT,
  },
  [MetricKey.SCHEDULING_MEASURED_VISITS_30D]: {
    key: MetricKey.SCHEDULING_MEASURED_VISITS_30D,
    name: "Visits With a Measured Length (30 days)",
    category: MetricCategory.SCHEDULING,
    unit: MetricUnit.COUNT,
  },
  [MetricKey.CAPACITY_CHAIR_UTILIZATION_30D]: {
    key: MetricKey.CAPACITY_CHAIR_UTILIZATION_30D,
    name: "Chair Utilization (30 days)",
    category: MetricCategory.UTILIZATION,
    unit: MetricUnit.PERCENTAGE,
  },
  [MetricKey.CAPACITY_BOOKED_NEXT_7D]: {
    key: MetricKey.CAPACITY_BOOKED_NEXT_7D,
    name: "Schedule Filled (next 7 days)",
    category: MetricCategory.UTILIZATION,
    unit: MetricUnit.PERCENTAGE,
  },
  [MetricKey.PATIENTS_NEW_TODAY]: {
    key: MetricKey.PATIENTS_NEW_TODAY,
    name: "New Patients Today",
    category: MetricCategory.ACQUISITION,
    unit: MetricUnit.COUNT,
  },
  [MetricKey.PATIENTS_RETURNING_TODAY]: {
    key: MetricKey.PATIENTS_RETURNING_TODAY,
    name: "Returning Patients Today",
    category: MetricCategory.RETENTION,
    unit: MetricUnit.COUNT,
  },
  [MetricKey.REVENUE_COLLECTED_TODAY]: {
    key: MetricKey.REVENUE_COLLECTED_TODAY,
    name: "Revenue Collected Today",
    category: MetricCategory.REVENUE,
    unit: MetricUnit.CURRENCY,
  },
  [MetricKey.REVENUE_OUTSTANDING]: {
    key: MetricKey.REVENUE_OUTSTANDING,
    name: "Outstanding Payments",
    category: MetricCategory.REVENUE,
    unit: MetricUnit.CURRENCY,
  },
  [MetricKey.REVENUE_OUTSTANDING_ON_PAYMENT_PLAN]: {
    key: MetricKey.REVENUE_OUTSTANDING_ON_PAYMENT_PLAN,
    name: "Outstanding Covered by a Payment Plan",
    category: MetricCategory.REVENUE,
    unit: MetricUnit.CURRENCY,
  },
  [MetricKey.REVENUE_PENDING_TREATMENT_VALUE]: {
    key: MetricKey.REVENUE_PENDING_TREATMENT_VALUE,
    name: "Pending Treatment Value",
    category: MetricCategory.REVENUE,
    unit: MetricUnit.CURRENCY,
  },
  [MetricKey.REVENUE_PRODUCTION_30D]: {
    key: MetricKey.REVENUE_PRODUCTION_30D,
    name: "Production (30 days)",
    category: MetricCategory.REVENUE,
    unit: MetricUnit.CURRENCY,
  },
  [MetricKey.REVENUE_PRODUCTION_UNPAID_30D]: {
    key: MetricKey.REVENUE_PRODUCTION_UNPAID_30D,
    name: "Delivered Work Not Yet Paid For (30 days)",
    category: MetricCategory.REVENUE,
    unit: MetricUnit.CURRENCY,
  },
  [MetricKey.REVENUE_PRODUCTION_PAID_RATE_30D]: {
    key: MetricKey.REVENUE_PRODUCTION_PAID_RATE_30D,
    name: "Delivered Work Paid For (30 days)",
    category: MetricCategory.REVENUE,
    unit: MetricUnit.PERCENTAGE,
  },
  [MetricKey.REVENUE_COLLECTION_RATE_30D]: {
    key: MetricKey.REVENUE_COLLECTION_RATE_30D,
    // Renamed to what it measures. "Collection rate" reads as "how much of our
    // work gets paid for", and it is not that: it is cash in against work out
    // over the same window, which exceeds 100% whenever old balances are paid.
    name: "Cash In Against Work Delivered (30 days)",
    category: MetricCategory.REVENUE,
    unit: MetricUnit.PERCENTAGE,
  },
  [MetricKey.PATIENTS_REACTIVATION_CANDIDATES]: {
    key: MetricKey.PATIENTS_REACTIVATION_CANDIDATES,
    name: "Patients Due for Reactivation",
    category: MetricCategory.RETENTION,
    unit: MetricUnit.COUNT,
  },
  [MetricKey.TREATMENT_AVERAGE_CASE_VALUE_30D]: {
    key: MetricKey.TREATMENT_AVERAGE_CASE_VALUE_30D,
    name: "Average Case Value (30 days)",
    category: MetricCategory.CLINICAL,
    unit: MetricUnit.CURRENCY,
  },
  [MetricKey.REVENUE_COLLECTED_30D]: {
    key: MetricKey.REVENUE_COLLECTED_30D,
    name: "Revenue Collected (30 days)",
    category: MetricCategory.REVENUE,
    unit: MetricUnit.CURRENCY,
  },
  [MetricKey.CAPACITY_OPEN_MINUTES_TODAY]: {
    key: MetricKey.CAPACITY_OPEN_MINUTES_TODAY,
    name: "Chair Time Open Today",
    category: MetricCategory.UTILIZATION,
    unit: MetricUnit.MINUTES,
  },
  [MetricKey.CAPACITY_APPOINTMENT_CAPACITY_TODAY]: {
    key: MetricKey.CAPACITY_APPOINTMENT_CAPACITY_TODAY,
    name: "Appointments That Fit Today",
    category: MetricCategory.UTILIZATION,
    unit: MetricUnit.COUNT,
  },
  [MetricKey.QUEUE_PATIENTS_WAITING]: {
    key: MetricKey.QUEUE_PATIENTS_WAITING,
    name: "Patients Waiting",
    category: MetricCategory.OPERATIONAL,
    unit: MetricUnit.COUNT,
  },
  [MetricKey.QUEUE_AVERAGE_WAITING_TIME]: {
    key: MetricKey.QUEUE_AVERAGE_WAITING_TIME,
    name: "Average Waiting Time",
    category: MetricCategory.OPERATIONAL,
    unit: MetricUnit.MINUTES,
  },
  [MetricKey.FOLLOWUPS_DUE_TODAY]: {
    key: MetricKey.FOLLOWUPS_DUE_TODAY,
    name: "Follow-ups Due Today",
    category: MetricCategory.RETENTION,
    unit: MetricUnit.COUNT,
  },
  [MetricKey.FOLLOWUPS_OVERDUE]: {
    key: MetricKey.FOLLOWUPS_OVERDUE,
    name: "Overdue Follow-ups",
    category: MetricCategory.RETENTION,
    unit: MetricUnit.COUNT,
  },
  [MetricKey.TREATMENT_ACCEPTED_PENDING_SCHEDULING]: {
    key: MetricKey.TREATMENT_ACCEPTED_PENDING_SCHEDULING,
    // Named for what it reads, not for what the key says. The key is persisted
    // in `metric_history` so it cannot change; the display name can, and must,
    // because `planned` is not a record of patient consent and the booking check
    // is per patient rather than per treatment.
    name: "Planned Treatments With No Next Visit Booked",
    category: MetricCategory.CLINICAL,
    unit: MetricUnit.COUNT,
  },
  [MetricKey.TREATMENT_COMPLETED_TODAY]: {
    key: MetricKey.TREATMENT_COMPLETED_TODAY,
    name: "Treatments Completed Today",
    category: MetricCategory.CLINICAL,
    unit: MetricUnit.COUNT,
  },
  [MetricKey.CAPACITY_CHAIR_UTILIZATION]: {
    key: MetricKey.CAPACITY_CHAIR_UTILIZATION,
    name: "Chair Utilization",
    category: MetricCategory.UTILIZATION,
    unit: MetricUnit.PERCENTAGE,
  },
  [MetricKey.CAPACITY_AVAILABLE_SLOTS_TODAY]: {
    key: MetricKey.CAPACITY_AVAILABLE_SLOTS_TODAY,
    name: "Room For More Appointments Today",
    category: MetricCategory.UTILIZATION,
    unit: MetricUnit.COUNT,
  },
};

/**
 * Build a {@link Metric} domain object from a metric key and a computed value.
 * Pure construction only — no calculation happens here.
 *
 * The id is deterministic (`key:clinicId:date`) so the same measurement always
 * carries the same id.
 */
export function buildMetric(
  key: MetricKey,
  value: number,
  clinicId: string,
  date: string,
  timestamp: string,
): Metric {
  const descriptor = METRIC_DESCRIPTORS[key];
  return {
    id: `${key}:${clinicId}:${date}`,
    name: descriptor.name,
    value,
    unit: descriptor.unit,
    category: descriptor.category,
    timestamp,
  };
}
