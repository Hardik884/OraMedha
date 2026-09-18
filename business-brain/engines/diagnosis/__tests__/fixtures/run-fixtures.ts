/**
 * Diagnosis Engine test fixtures.
 *
 * Every scenario is built by running the REAL Signal Engine over a real metric
 * set, so the signals, their evidence, their confidences, and — critically — the
 * decision trace all match production exactly. Hand-written signal literals would
 * let a fixture drift from what the Signal Engine actually emits, and the whole
 * point of this engine is reasoning about that trace.
 */

import type { Metric } from "../../../../domain";
import { buildMetric, MetricKey } from "../../../metrics/metric-ids";
import { evaluateSignals } from "../../../signals/generate-signals";
import type { SignalRun } from "../../../diagnosis-engine";
import { addDays } from "../../support/dates";

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
  const timestamp = options?.timestamp ?? `${date}T18:30:00.000Z`;
  return (Object.keys(values) as MetricKey[]).map((key) =>
    buildMetric(key, values[key] as number, clinicId, date, timestamp),
  );
}

/** Run the real Signal Engine to produce a full SignalRun for a day. */
export function run(
  values: MetricValues | Metric[],
  options?: {
    date?: string;
    previous?: MetricValues | Metric[];
    clinicId?: string;
  },
): SignalRun {
  const date = options?.date ?? DATE;
  const clinicId = options?.clinicId ?? CLINIC_ID;
  const current = Array.isArray(values)
    ? values
    : metrics(values, { date, clinicId });
  const previous = options?.previous
    ? Array.isArray(options.previous)
      ? options.previous
      : metrics(options.previous, { date: shiftDate(date, -1), clinicId })
    : undefined;

  const result = evaluateSignals({
    metrics: current,
    previousMetrics: previous,
    clinicId,
    date,
    now: NOW,
  });
  return { date, signals: [...result.signals], metrics: current, trace: result.traces };
}

/** Day shift for fixture dates, using the engine's own pure calendar helper. */
export function shiftDate(date: string, days: number): string {
  return addDays(date, days);
}

/** A well-run day: no signals at all. */
export const HEALTHY: MetricValues = {
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
  // Comfortably above the 40% minimum, so the forward-schedule rule is DECIDABLE
  // in every scenario built on this baseline and measurably finds nothing.
  // Omitting it would make the rule skip everywhere, which the engine correctly
  // reports as lower decidability — a fixture gap reading as a weaker run.
  [MetricKey.CAPACITY_BOOKED_NEXT_7D]: 72,
  [MetricKey.SCHEDULING_REPEAT_NON_ATTENDERS_30D]: 0,
  // The window metrics, present for the same reason CAPACITY_BOOKED_NEXT_7D is:
  // every rule that can reach a verdict without a prior period must be able to on
  // this baseline, or its matcher reads as undecidable everywhere and a fixture
  // gap shows up as a weaker run. Each value sits comfortably inside its limit.
  [MetricKey.PATIENTS_REACTIVATION_CANDIDATES]: 8,
  [MetricKey.SCHEDULING_CANCELLATION_RATE_30D]: 4,
  [MetricKey.SCHEDULING_NO_SHOW_RATE_30D]: 3,
  [MetricKey.SCHEDULING_BOOKING_LEAD_TIME_DAYS]: 5,
  [MetricKey.SCHEDULING_APPOINTMENT_OVERRUN_30D]: 4,
  [MetricKey.SCHEDULING_MEASURED_VISITS_30D]: 64,
  // The denominator behind both attendance rates, above the 20 the
  // sustained-attrition rule needs before a share of the book is a rate.
  [MetricKey.SCHEDULING_APPOINTMENTS_30D]: 120,
  [MetricKey.CAPACITY_CHAIR_UTILIZATION_30D]: 71,
  [MetricKey.REVENUE_COLLECTION_RATE_30D]: 94,
  [MetricKey.REVENUE_PRODUCTION_30D]: 480_000,
  [MetricKey.REVENUE_COLLECTED_30D]: 451_000,
};

/** Idle chairs, thin book, and a large accepted-treatment backlog. */
export const DEMAND_SUPPLY_WITH_PENDING: MetricValues = {
  ...HEALTHY,
  [MetricKey.APPOINTMENTS_TOTAL_TODAY]: 3,
  [MetricKey.REVENUE_PENDING_TREATMENT_VALUE]: 180_000,
  [MetricKey.TREATMENT_ACCEPTED_PENDING_SCHEDULING]: 9,
  [MetricKey.CAPACITY_CHAIR_UTILIZATION]: 22,
  [MetricKey.CAPACITY_AVAILABLE_SLOTS_TODAY]: 11,
};

/** Idle chairs, thin book, empty treatment book, no new patients. */
export const DEMAND_SUPPLY_NO_PENDING: MetricValues = {
  ...HEALTHY,
  [MetricKey.APPOINTMENTS_TOTAL_TODAY]: 3,
  [MetricKey.PATIENTS_NEW_TODAY]: 0,
  [MetricKey.REVENUE_PENDING_TREATMENT_VALUE]: 0,
  [MetricKey.TREATMENT_ACCEPTED_PENDING_SCHEDULING]: 0,
  [MetricKey.CAPACITY_CHAIR_UTILIZATION]: 22,
  [MetricKey.CAPACITY_AVAILABLE_SLOTS_TODAY]: 11,
};

/** Revenue low, but the work was demonstrably delivered. */
export const REVENUE_YIELD_DRIVEN: MetricValues = {
  ...HEALTHY,
  [MetricKey.REVENUE_COLLECTED_TODAY]: 1_200,
  [MetricKey.TREATMENT_COMPLETED_TODAY]: 6,
};

/** Revenue low because very little work was delivered. */
export const REVENUE_VOLUME_DRIVEN: MetricValues = {
  ...HEALTHY,
  [MetricKey.APPOINTMENTS_TOTAL_TODAY]: 3,
  [MetricKey.REVENUE_COLLECTED_TODAY]: 1_200,
  [MetricKey.TREATMENT_COMPLETED_TODAY]: 1,
  [MetricKey.CAPACITY_CHAIR_UTILIZATION]: 60,
};

/** Revenue low with the two work measurements pointing opposite ways. */
export const REVENUE_AMBIGUOUS: MetricValues = {
  ...HEALTHY,
  [MetricKey.APPOINTMENTS_TOTAL_TODAY]: 3,
  [MetricKey.REVENUE_COLLECTED_TODAY]: 1_200,
  [MetricKey.TREATMENT_COMPLETED_TODAY]: 6,
  [MetricKey.CAPACITY_CHAIR_UTILIZATION]: 60,
};

/** Queue and waits breached while the chair is full: capacity-bound. */
export const CONGESTION_CAPACITY_BOUND: MetricValues = {
  ...HEALTHY,
  [MetricKey.APPOINTMENTS_TOTAL_TODAY]: 20,
  [MetricKey.QUEUE_PATIENTS_WAITING]: 9,
  [MetricKey.QUEUE_AVERAGE_WAITING_TIME]: 55,
  [MetricKey.CAPACITY_CHAIR_UTILIZATION]: 96,
  [MetricKey.CAPACITY_AVAILABLE_SLOTS_TODAY]: 0,
};

/** Queue and waits breached while chairs sit idle: flow-bound. */
export const CONGESTION_FLOW_BOUND: MetricValues = {
  ...HEALTHY,
  [MetricKey.QUEUE_PATIENTS_WAITING]: 9,
  [MetricKey.QUEUE_AVERAGE_WAITING_TIME]: 55,
  [MetricKey.CAPACITY_CHAIR_UTILIZATION]: 62,
  [MetricKey.CAPACITY_AVAILABLE_SLOTS_TODAY]: 6,
};

/** Attrition dominated by advance cancellations. */
export const ATTRITION_CANCELLATION_DOMINANT: MetricValues = {
  ...HEALTHY,
  [MetricKey.APPOINTMENTS_TOTAL_TODAY]: 31,
  [MetricKey.APPOINTMENTS_CANCELLED_TODAY]: 8,
  [MetricKey.APPOINTMENTS_NO_SHOWS_TODAY]: 1,
};

/** Attrition dominated by no-shows. */
export const ATTRITION_NO_SHOW_DOMINANT: MetricValues = {
  ...HEALTHY,
  [MetricKey.APPOINTMENTS_TOTAL_TODAY]: 31,
  [MetricKey.APPOINTMENTS_CANCELLED_TODAY]: 1,
  [MetricKey.APPOINTMENTS_NO_SHOWS_TODAY]: 8,
};

/** Attrition with the two counts too close to separate. */
export const ATTRITION_BALANCED: MetricValues = {
  ...HEALTHY,
  [MetricKey.APPOINTMENTS_TOTAL_TODAY]: 31,
  [MetricKey.APPOINTMENTS_CANCELLED_TODAY]: 6,
  [MetricKey.APPOINTMENTS_NO_SHOWS_TODAY]: 5,
};

/** Collection lagging the day's completed treatments. */
export const COLLECTION_GAP: MetricValues = {
  ...HEALTHY,
  [MetricKey.REVENUE_COLLECTED_TODAY]: 3_200,
  [MetricKey.TREATMENT_COMPLETED_TODAY]: 6,
};

/** Both ends of the patient base contracting. */
export const BASE_EROSION: MetricValues = {
  ...HEALTHY,
  [MetricKey.PATIENTS_NEW_TODAY]: 0,
  [MetricKey.PATIENTS_RETURNING_TODAY]: 3,
  [MetricKey.FOLLOWUPS_OVERDUE]: 22,
};

/** Returning volume falling with acquisition measurably unaffected. */
export const RECALL_FAILURE: MetricValues = {
  ...HEALTHY,
  [MetricKey.PATIENTS_NEW_TODAY]: 3,
  [MetricKey.PATIENTS_RETURNING_TODAY]: 3,
  [MetricKey.FOLLOWUPS_OVERDUE]: 22,
};

/** Prior period for the trend evaluators. */
export const PRIOR: MetricValues = {
  [MetricKey.PATIENTS_RETURNING_TODAY]: 10,
  [MetricKey.REVENUE_OUTSTANDING]: 8_000,
  [MetricKey.QUEUE_PATIENTS_WAITING]: 2,
};

/**
 * A single isolated signal: a large pending-treatment book and nothing else.
 *
 * `large_pending_treatment_value` fires alone (pending above its limit) without
 * the accepted-unscheduled partner or the thin-book condition that would cluster
 * it into pipeline_conversion_failure, so it is carried forward as one
 * unclustered diagnosis. (It used to be an overdue recall list, but that signal
 * now has its own standalone `recall_backlog` matcher, so it is no longer orphan.)
 */
export const ISOLATED_SIGNAL: MetricValues = {
  ...HEALTHY,
  [MetricKey.REVENUE_PENDING_TREATMENT_VALUE]: 60_000,
};

/** A standalone overdue-recall backlog, with returning volume steady. */
export const RECALL_BACKLOG: MetricValues = {
  ...HEALTHY,
  [MetricKey.FOLLOWUPS_OVERDUE]: 27,
};

/** A standalone outstanding-balance book above the clinic's limit. */
export const HIGH_OUTSTANDING: MetricValues = {
  ...HEALTHY,
  [MetricKey.REVENUE_OUTSTANDING]: 40_000,
};

/**
 * A thin week ahead, with today itself perfectly healthy.
 *
 * Built on HEALTHY on purpose: it is the case that proves the forward finding
 * stands on its own. Nothing about today is wrong, so no today-pattern fires,
 * and the only thing the engine has to report is a week that can still be
 * filled — which is exactly the situation every other rule in the catalogue is
 * blind to.
 */
export const FORWARD_SCHEDULE_GAP: MetricValues = {
  ...HEALTHY,
  [MetricKey.CAPACITY_BOOKED_NEXT_7D]: 18,
};

/**
 * Three patients each missing more than once, on a day whose headline attrition
 * numbers are entirely normal.
 *
 * Built on HEALTHY deliberately: today shows one cancellation and no no-shows,
 * so `high_no_show_rate` cannot fire and `schedule_attrition` never runs. This is
 * the clinic that used to see nothing at all despite having a three-name list
 * worth working — the exact blind spot the pattern closes.
 */
export const REPEAT_NON_ATTENDANCE: MetricValues = {
  ...HEALTHY,
  [MetricKey.SCHEDULING_REPEAT_NON_ATTENDERS_30D]: 3,
};

/**
 * A patient base that has quietly emptied, with a clean recall list.
 *
 * The whole point of the scenario is what is NOT here: follow-ups stay within
 * their limit and returning volume holds, so neither retention signal fires and
 * dormant_patient_base is the only pattern that can see these patients at all.
 */
export const DORMANT_PATIENT_BASE: MetricValues = {
  ...HEALTHY,
  [MetricKey.PATIENTS_REACTIVATION_CANDIDATES]: 140,
};

/**
 * Appointments running well over their booked lengths, on a calm day.
 *
 * The queue metrics stay healthy deliberately: with a queue today the finding
 * belongs to throughput_congestion as its service-time cause, and the matcher
 * stands down. This is the absorbed case — the clinic runs late and nobody waits
 * in a measurable way.
 */
export const CHRONIC_OVERRUN: MetricValues = {
  ...HEALTHY,
  [MetricKey.SCHEDULING_APPOINTMENT_OVERRUN_30D]: 38,
  [MetricKey.SCHEDULING_MEASURED_VISITS_30D]: 71,
};

/**
 * A month collecting well under what was produced, with every day looking fine.
 *
 * Today's collection stays healthy on purpose: the daily collection-lagging rule
 * must NOT fire, or collection_gap claims the story and this matcher stands down.
 * That is exactly the case the pattern exists for — a shortfall spread so evenly
 * that no single day shows it.
 */
export const PRODUCTION_COLLECTION_GAP: MetricValues = {
  ...HEALTHY,
  [MetricKey.REVENUE_COLLECTION_RATE_30D]: 61,
  [MetricKey.REVENUE_PRODUCTION_30D]: 520_000,
  [MetricKey.REVENUE_COLLECTED_30D]: 317_000,
};

/**
 * Chair time going unused across the window while today looks ordinary.
 *
 * Today's utilization stays healthy so the daily rule does not fire: the point is
 * that the month is the only timescale on which this clinic's problem is visible.
 */
export const SUSTAINED_IDLE_CAPACITY: MetricValues = {
  ...HEALTHY,
  [MetricKey.CAPACITY_CHAIR_UTILIZATION_30D]: 28,
};

/**
 * Near-full capacity and low utilization on the same day.
 *
 * Physically contradictory over a whole day, which is the point: the two metrics
 * describe different parts of it. Utilization is well below the minimum while only
 * one bookable slot remains, so both evaluators fire.
 */
export const CONTRADICTORY: MetricValues = {
  ...HEALTHY,
  [MetricKey.APPOINTMENTS_TOTAL_TODAY]: 4,
  [MetricKey.CAPACITY_CHAIR_UTILIZATION]: 30,
  [MetricKey.CAPACITY_AVAILABLE_SLOTS_TODAY]: 1,
};
