/**
 * Business Brain — Metric observation provenance.
 *
 * Every stored reading answers six questions (see migration 20260917100100):
 *
 *   1. when was it produced                 producedAt
 *   2. which clinic-local day it describes  the metric's date, in the clinic's timezone
 *   3. measured then, or worked out later   provenance
 *   4. what information it could use        knowledgeAsOf, and the snapshot's mode
 *   5. whether that information was whole   the snapshot's history coverage
 *   6. what it rests on that nothing        unversionedInputs
 *      versions
 *
 * ## The four provenances
 *
 *   observed_at_time              produced within {@link OBSERVATION_GRACE_HOURS}
 *                                 hours after the day ended, from state as known
 *                                 at the end of that day
 *   point_in_time_reconstruction  produced later, from state as known at the end
 *                                 of that day, and from NO unversioned input —
 *                                 so nothing learned since can have reached it
 *   recomputed_later              anything else produced later: current state, or
 *                                 an unversioned input read today
 *   unknown                       written before provenance was recorded
 *
 * An observed_at_time reading may still rest on an unversioned input (a chair
 * count, a schedule rule) read at production time; the bound on that is the grace
 * window, and the input is named on the reading.
 *
 * ## Assumed, not versioned
 *
 * The clinic's timezone defines the business day itself and is taken as fixed.
 * A clinic that changes timezone changes what every one of its dates means; no
 * reading can be point-in-time across that change, and none claims to be.
 *
 * Pure.
 */

import { MetricKey } from "../engines/metrics/metric-ids";
import { endOfLocalDay } from "../utils/dates";

export const MetricProvenance = {
  OBSERVED_AT_TIME: "observed_at_time",
  POINT_IN_TIME_RECONSTRUCTION: "point_in_time_reconstruction",
  RECOMPUTED_LATER: "recomputed_later",
  UNKNOWN: "unknown",
} as const;
export type MetricProvenance = (typeof MetricProvenance)[keyof typeof MetricProvenance];

/** Inputs no history table versions. Reading one later reads today's value. */
export const UnversionedInput = {
  /** Availability rules, consultation blocks, chair count and typical appointment length. */
  SCHEDULE_CONFIGURATION: "schedule_configuration",
  /** Clinic settings other than the timezone: the recall interval. */
  CLINIC_SETTINGS: "clinic_settings",
  /** Queue entries: timestamped, but mutable and purged on a retention schedule. */
  QUEUE_ENTRIES: "queue_entries",
} as const;
export type UnversionedInput = (typeof UnversionedInput)[keyof typeof UnversionedInput];

/**
 * The unversioned inputs each metric reads. Every key is listed, so a metric
 * added without a decision here fails `metric-provenance.spec.ts`, which also
 * checks this against what each calculator actually reads.
 */
export const UNVERSIONED_INPUTS_BY_METRIC: Readonly<Record<MetricKey, readonly UnversionedInput[]>> = {
  [MetricKey.APPOINTMENTS_TOTAL_TODAY]: [],
  [MetricKey.APPOINTMENTS_CANCELLED_TODAY]: [],
  [MetricKey.APPOINTMENTS_NO_SHOWS_TODAY]: [],
  [MetricKey.SCHEDULING_CANCELLATION_RATE_30D]: [],
  [MetricKey.SCHEDULING_NO_SHOW_RATE_30D]: [],
  [MetricKey.SCHEDULING_REPEAT_NON_ATTENDERS_30D]: [],
  [MetricKey.SCHEDULING_BOOKING_LEAD_TIME_DAYS]: [],
  [MetricKey.SCHEDULING_APPOINTMENT_OVERRUN_30D]: [UnversionedInput.QUEUE_ENTRIES],
  [MetricKey.SCHEDULING_MEASURED_VISITS_30D]: [UnversionedInput.QUEUE_ENTRIES],
  [MetricKey.PATIENTS_NEW_TODAY]: [],
  [MetricKey.PATIENTS_RETURNING_TODAY]: [],
  [MetricKey.PATIENTS_REACTIVATION_CANDIDATES]: [UnversionedInput.CLINIC_SETTINGS],
  [MetricKey.REVENUE_COLLECTED_TODAY]: [],
  [MetricKey.REVENUE_OUTSTANDING]: [],
  [MetricKey.REVENUE_OUTSTANDING_ON_PAYMENT_PLAN]: [],
  [MetricKey.REVENUE_PENDING_TREATMENT_VALUE]: [],
  [MetricKey.REVENUE_PRODUCTION_30D]: [],
  [MetricKey.REVENUE_COLLECTION_RATE_30D]: [],
  [MetricKey.REVENUE_COLLECTED_30D]: [],
  [MetricKey.QUEUE_PATIENTS_WAITING]: [UnversionedInput.QUEUE_ENTRIES],
  [MetricKey.QUEUE_AVERAGE_WAITING_TIME]: [UnversionedInput.QUEUE_ENTRIES],
  [MetricKey.FOLLOWUPS_DUE_TODAY]: [],
  [MetricKey.FOLLOWUPS_OVERDUE]: [],
  [MetricKey.TREATMENT_ACCEPTED_PENDING_SCHEDULING]: [],
  [MetricKey.TREATMENT_COMPLETED_TODAY]: [],
  [MetricKey.TREATMENT_AVERAGE_CASE_VALUE_30D]: [],
  [MetricKey.CAPACITY_CHAIR_UTILIZATION]: [UnversionedInput.SCHEDULE_CONFIGURATION],
  [MetricKey.CAPACITY_AVAILABLE_SLOTS_TODAY]: [UnversionedInput.SCHEDULE_CONFIGURATION],
  [MetricKey.CAPACITY_CHAIR_UTILIZATION_30D]: [UnversionedInput.SCHEDULE_CONFIGURATION],
  [MetricKey.CAPACITY_BOOKED_NEXT_7D]: [UnversionedInput.SCHEDULE_CONFIGURATION],
  [MetricKey.CAPACITY_OPEN_MINUTES_TODAY]: [UnversionedInput.SCHEDULE_CONFIGURATION],
  [MetricKey.CAPACITY_APPOINTMENT_CAPACITY_TODAY]: [UnversionedInput.SCHEDULE_CONFIGURATION],
};

/** Hours after a clinic-local day ends within which a reading still counts as measured at the time. */
export const OBSERVATION_GRACE_HOURS = 3;

/** How a snapshot's record state was read. Carried by the snapshot, set by the adapter. */
export interface SnapshotKnowledge {
  /**
   * point_in_time  every record's state was read from history as known at `knownAt`
   * current_state  records were read as they stand now — history did not cover
   *                `knownAt`, or the snapshot describes the present
   */
  readonly mode: "point_in_time" | "current_state";
  /** The latest moment whose record changes the snapshot could reflect. */
  readonly knownAt: string;
  /** For current_state: why history was not used. */
  readonly reason?: "describes_present" | "before_history_capture";
}

export interface MetricReadingProvenance {
  readonly provenance: MetricProvenance;
  readonly producedAt: string;
  readonly knowledgeAsOf: string;
  readonly unversionedInputs: readonly UnversionedInput[];
}

export class ProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvenanceError";
  }
}

/**
 * Classify one reading of a COMPLETED day. Refuses a day that has not ended when
 * the reading was produced: a figure taken mid-day is not the day's result.
 */
export function classifyMetricReading(input: {
  readonly metricKey: string;
  readonly date: string;
  readonly timezone: string;
  readonly producedAt: string;
  readonly knowledge: SnapshotKnowledge | undefined;
}): MetricReadingProvenance {
  const dayEnd = Date.parse(endOfLocalDay(input.date, input.timezone));
  const produced = Date.parse(input.producedAt);
  if (Number.isNaN(produced)) throw new ProvenanceError(`Invalid producedAt: ${input.producedAt}.`);
  if (produced < dayEnd) throw new ProvenanceError(`${input.date} had not ended when this reading was produced.`);

  const unversionedInputs = UNVERSIONED_INPUTS_BY_METRIC[input.metricKey as MetricKey];
  if (unversionedInputs === undefined) throw new ProvenanceError(`No provenance decision for metric ${input.metricKey}.`);

  const knowledge = input.knowledge;
  const pointInTime = knowledge?.mode === "point_in_time" && Date.parse(knowledge.knownAt) <= dayEnd;
  const contemporaneous = produced <= dayEnd + OBSERVATION_GRACE_HOURS * 3_600_000;

  if (pointInTime) {
    const knowledgeAsOf = new Date(Math.min(Date.parse(knowledge.knownAt), produced)).toISOString();
    if (contemporaneous) return { provenance: MetricProvenance.OBSERVED_AT_TIME, producedAt: input.producedAt, knowledgeAsOf, unversionedInputs };
    if (unversionedInputs.length === 0) {
      return { provenance: MetricProvenance.POINT_IN_TIME_RECONSTRUCTION, producedAt: input.producedAt, knowledgeAsOf, unversionedInputs };
    }
  }
  // Current state, or an unversioned input read long after the day: it knows
  // whatever was true when it ran.
  return { provenance: MetricProvenance.RECOMPUTED_LATER, producedAt: input.producedAt, knowledgeAsOf: input.producedAt, unversionedInputs };
}

/**
 * Whether a reading can stand for its day with nothing learned afterwards: the
 * only readings evidence about the past may rest on.
 */
export function isPointInTimeSafe(provenance: string | undefined): boolean {
  return provenance === MetricProvenance.OBSERVED_AT_TIME || provenance === MetricProvenance.POINT_IN_TIME_RECONSTRUCTION;
}
