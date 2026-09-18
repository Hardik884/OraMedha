/**
 * Signal Engine test fixtures.
 *
 * Every scenario is a full metric set for one clinic-day, built through the real
 * `buildMetric` helper so ids and units match production exactly.
 */

import { buildMetric, MetricKey } from "../../../metrics/metric-ids";
import type { Metric } from "../../../../domain";

export const CLINIC_ID = "clinic_123";
export const DATE = "2026-07-26";
export const NOW = "2026-07-26T18:30:00.000Z";

/** Partial metric map: key -> value. */
export type MetricValues = Partial<Record<MetricKey, number>>;

/** Build metrics for a clinic-day from a key/value map. */
export function metrics(
  values: MetricValues,
  options?: { clinicId?: string; date?: string; timestamp?: string },
): Metric[] {
  const clinicId = options?.clinicId ?? CLINIC_ID;
  const date = options?.date ?? DATE;
  const timestamp = options?.timestamp ?? NOW;
  return (Object.keys(values) as MetricKey[]).map((key) =>
    buildMetric(key, values[key] as number, clinicId, date, timestamp),
  );
}

/** Every metric key present, values describing a well-run day. */
export const HEALTHY_CLINIC: MetricValues = {
  [MetricKey.APPOINTMENTS_TOTAL_TODAY]: 14,
  [MetricKey.APPOINTMENTS_CANCELLED_TODAY]: 1,
  [MetricKey.APPOINTMENTS_NO_SHOWS_TODAY]: 0,
  [MetricKey.PATIENTS_NEW_TODAY]: 3,
  [MetricKey.PATIENTS_RETURNING_TODAY]: 9,
  [MetricKey.REVENUE_COLLECTED_TODAY]: 24_000,
  [MetricKey.REVENUE_OUTSTANDING]: 8_000,
  [MetricKey.REVENUE_PENDING_TREATMENT_VALUE]: 18_000,
  [MetricKey.QUEUE_PATIENTS_WAITING]: 2,
  [MetricKey.QUEUE_AVERAGE_WAITING_TIME]: 11,
  [MetricKey.FOLLOWUPS_DUE_TODAY]: 4,
  [MetricKey.FOLLOWUPS_OVERDUE]: 2,
  [MetricKey.TREATMENT_ACCEPTED_PENDING_SCHEDULING]: 2,
  [MetricKey.TREATMENT_COMPLETED_TODAY]: 7,
  [MetricKey.CAPACITY_CHAIR_UTILIZATION]: 78,
  [MetricKey.CAPACITY_AVAILABLE_SLOTS_TODAY]: 4,
  // Comfortably above the 40% minimum. Present so this fixture stays what the
  // suite calls it — a COMPLETE same-day metric set — now that a rule reads the
  // week ahead. Without it the forward rule would skip and a healthy clinic
  // would read as partially unmeasured.
  [MetricKey.CAPACITY_BOOKED_NEXT_7D]: 72,
  [MetricKey.SCHEDULING_REPEAT_NON_ATTENDERS_30D]: 0,
  // The window metrics. Present for the same reason CAPACITY_BOOKED_NEXT_7D is:
  // this fixture is what the suite calls a COMPLETE metric set, so every rule
  // that can reach a verdict without a prior period must be able to. Each value
  // is comfortably inside its threshold, so a healthy clinic stays healthy.
  // Comfortably below `lapsedPatientLimit` (25). A clinic with a handful of
  // lapsed patients is every clinic; the rule is about a base that has emptied.
  [MetricKey.PATIENTS_REACTIVATION_CANDIDATES]: 8,
  [MetricKey.SCHEDULING_CANCELLATION_RATE_30D]: 4,
  [MetricKey.SCHEDULING_NO_SHOW_RATE_30D]: 3,
  [MetricKey.SCHEDULING_BOOKING_LEAD_TIME_DAYS]: 5,
  [MetricKey.SCHEDULING_APPOINTMENT_OVERRUN_30D]: 4,
  // Above `minimumMeasuredVisits` (10), so the overrun rule judges the rate
  // rather than standing down on sample size.
  [MetricKey.SCHEDULING_MEASURED_VISITS_30D]: 64,
  // The denominator both attendance rates were divided by. Above
  // `minimumWindowAppointments` (20), so the sustained-attrition rule judges the
  // rates rather than standing down on sample size — the same role
  // SCHEDULING_MEASURED_VISITS_30D plays for the overrun rule.
  [MetricKey.SCHEDULING_APPOINTMENTS_30D]: 120,
  [MetricKey.CAPACITY_CHAIR_UTILIZATION_30D]: 71,
  [MetricKey.REVENUE_COLLECTION_RATE_30D]: 94,
  // Comfortably above `minimumCollectionRate` (85). The rule reads this rather
  // than the cash-flow ratio above: that one compares this window's cash against
  // this window's work, so a month clearing old balances hid exactly the
  // situation the rule exists to catch.
  [MetricKey.REVENUE_PRODUCTION_PAID_RATE_30D]: 92,
  [MetricKey.REVENUE_PRODUCTION_UNPAID_30D]: 38_400,
  // Above `minimumProductionForRateCheck` (125,000), so the collection-rate rule
  // judges the rate rather than standing down on a thin denominator.
  [MetricKey.REVENUE_PRODUCTION_30D]: 480_000,
  [MetricKey.REVENUE_COLLECTED_30D]: 451_000,
};

/** Full chair, almost nothing left to book. */
export const BUSY_CLINIC: MetricValues = {
  ...HEALTHY_CLINIC,
  [MetricKey.APPOINTMENTS_TOTAL_TODAY]: 20,
  [MetricKey.CAPACITY_CHAIR_UTILIZATION]: 96,
  [MetricKey.CAPACITY_AVAILABLE_SLOTS_TODAY]: 0,
};

/** Busy day, money not collected, receivables above the ceiling. */
export const LOW_REVENUE_CLINIC: MetricValues = {
  ...HEALTHY_CLINIC,
  [MetricKey.REVENUE_COLLECTED_TODAY]: 1_200,
  [MetricKey.REVENUE_OUTSTANDING]: 62_000,
  [MetricKey.TREATMENT_COMPLETED_TODAY]: 6,
};

/** 8 of 31 appointments cancelled, 4 no-shows. */
export const HIGH_CANCELLATION_CLINIC: MetricValues = {
  ...HEALTHY_CLINIC,
  [MetricKey.APPOINTMENTS_TOTAL_TODAY]: 31,
  [MetricKey.APPOINTMENTS_CANCELLED_TODAY]: 8,
  [MetricKey.APPOINTMENTS_NO_SHOWS_TODAY]: 4,
};

/** Large accepted-treatment book, quiet schedule, open chairs. */
export const LARGE_PIPELINE_CLINIC: MetricValues = {
  ...HEALTHY_CLINIC,
  [MetricKey.APPOINTMENTS_TOTAL_TODAY]: 3,
  [MetricKey.APPOINTMENTS_CANCELLED_TODAY]: 0,
  [MetricKey.REVENUE_PENDING_TREATMENT_VALUE]: 180_000,
  [MetricKey.TREATMENT_ACCEPTED_PENDING_SCHEDULING]: 9,
  [MetricKey.CAPACITY_CHAIR_UTILIZATION]: 22,
  [MetricKey.CAPACITY_AVAILABLE_SLOTS_TODAY]: 11,
};

/** Same large pipeline, but the schedule is full — nothing is stalled. */
export const LARGE_PIPELINE_BUSY_CLINIC: MetricValues = {
  ...LARGE_PIPELINE_CLINIC,
  [MetricKey.APPOINTMENTS_TOTAL_TODAY]: 16,
  [MetricKey.CAPACITY_CHAIR_UTILIZATION]: 80,
  [MetricKey.CAPACITY_AVAILABLE_SLOTS_TODAY]: 3,
};

/** Recall list has been ignored. */
export const OVERDUE_FOLLOWUPS_CLINIC: MetricValues = {
  ...HEALTHY_CLINIC,
  [MetricKey.FOLLOWUPS_DUE_TODAY]: 6,
  [MetricKey.FOLLOWUPS_OVERDUE]: 27,
};

/** Every metric present and zero: a closed or completely idle day. */
export const EMPTY_CLINIC: MetricValues = {
  [MetricKey.APPOINTMENTS_TOTAL_TODAY]: 0,
  [MetricKey.APPOINTMENTS_CANCELLED_TODAY]: 0,
  [MetricKey.APPOINTMENTS_NO_SHOWS_TODAY]: 0,
  [MetricKey.PATIENTS_NEW_TODAY]: 0,
  [MetricKey.PATIENTS_RETURNING_TODAY]: 0,
  [MetricKey.REVENUE_COLLECTED_TODAY]: 0,
  [MetricKey.REVENUE_OUTSTANDING]: 0,
  [MetricKey.REVENUE_PENDING_TREATMENT_VALUE]: 0,
  [MetricKey.QUEUE_PATIENTS_WAITING]: 0,
  [MetricKey.QUEUE_AVERAGE_WAITING_TIME]: 0,
  [MetricKey.FOLLOWUPS_DUE_TODAY]: 0,
  [MetricKey.FOLLOWUPS_OVERDUE]: 0,
  [MetricKey.TREATMENT_ACCEPTED_PENDING_SCHEDULING]: 0,
  [MetricKey.TREATMENT_COMPLETED_TODAY]: 0,
  [MetricKey.CAPACITY_CHAIR_UTILIZATION]: 0,
  [MetricKey.CAPACITY_AVAILABLE_SLOTS_TODAY]: 0,
};

/** Queue and waiting time only: every other evaluator must skip. */
export const PARTIAL_METRICS_CLINIC: MetricValues = {
  [MetricKey.QUEUE_PATIENTS_WAITING]: 9,
  [MetricKey.QUEUE_AVERAGE_WAITING_TIME]: 55,
};

/** Prior period for the trend evaluators: yesterday, calmer. */
export const PREVIOUS_PERIOD: MetricValues = {
  [MetricKey.REVENUE_OUTSTANDING]: 4_000,
  [MetricKey.PATIENTS_RETURNING_TODAY]: 10,
  [MetricKey.QUEUE_PATIENTS_WAITING]: 2,
};

/** Current period shaped so all three prior-period evaluators trigger. */
export const TREND_CURRENT: MetricValues = {
  ...HEALTHY_CLINIC,
  [MetricKey.REVENUE_OUTSTANDING]: 12_000,
  [MetricKey.PATIENTS_RETURNING_TODAY]: 4,
  [MetricKey.QUEUE_PATIENTS_WAITING]: 6,
};

export const PREVIOUS_DATE = "2026-07-25";
export const PREVIOUS_TIMESTAMP = "2026-07-25T18:30:00.000Z";

/** Metrics for the prior period, dated and timestamped one day earlier. */
export function previousMetrics(values: MetricValues = PREVIOUS_PERIOD): Metric[] {
  return metrics(values, { date: PREVIOUS_DATE, timestamp: PREVIOUS_TIMESTAMP });
}
