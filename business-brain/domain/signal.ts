/**
 * Business Brain — Domain: Signal
 *
 * Something that requires attention (e.g. Payment overdue, Empty chair,
 * Treatment not started). A Signal is a noteworthy event surfaced from
 * metrics/data — it states WHAT is happening, not why.
 */

import type { Confidence, Evidence, Priority, Severity } from "../types";
import type { RelatedEntity } from "./shared";

/**
 * Broad grouping of signals for filtering and routing.
 */
export const SignalCategory = {
  FINANCIAL: "financial",
  SCHEDULING: "scheduling",
  CLINICAL: "clinical",
  RETENTION: "retention",
  OPERATIONAL: "operational",
} as const;

export type SignalCategory = (typeof SignalCategory)[keyof typeof SignalCategory];

/**
 * Stable, machine-readable identifier for every kind of signal the Business
 * Brain can raise. Mirrors the `MetricKey` pattern: the string value is part
 * of the signal's public id and must never be renamed casually.
 */
export const SignalType = {
  // Financial
  REVENUE_LOW_DAILY_REVENUE: "revenue.low_daily_revenue",
  REVENUE_HIGH_OUTSTANDING: "revenue.high_outstanding",
  REVENUE_OUTSTANDING_INCREASING: "revenue.outstanding_increasing",
  REVENUE_COLLECTION_LAGGING_COMPLETIONS: "revenue.collection_lagging_completions",
  /**
   * Money collected as a share of work produced, over the trailing window.
   *
   * The structural version of `collection_lagging_completions`, which can only
   * look at one day and therefore cannot tell a late afternoon from a standing
   * habit. Production against collection is the fundamental pair in practice
   * management and this is the only rule that reads it.
   */
  REVENUE_COLLECTION_RATE_LOW: "revenue.collection_rate_low",
  // Scheduling
  SCHEDULING_HIGH_CANCELLATION_RATE: "scheduling.high_cancellation_rate",
  SCHEDULING_HIGH_NO_SHOW_RATE: "scheduling.high_no_show_rate",
  SCHEDULING_LOW_APPOINTMENT_VOLUME: "scheduling.low_appointment_volume",
  /**
   * The only FORWARD-looking signal in the set. Every other rule reports a day
   * that is already over; this one reports a week that can still be filled.
   */
  SCHEDULING_THIN_WEEK_AHEAD: "scheduling.thin_week_ahead",
  /**
   * Attrition concentrated in a few patients rather than spread across the base.
   * Fires independently of the no-show RATE: a clinic can sit comfortably under
   * its rate threshold and still have three people missing repeatedly.
   */
  SCHEDULING_REPEAT_NON_ATTENDANCE: "scheduling.repeat_non_attendance",
  /**
   * Appointments taking materially longer than the time booked for them across
   * the trailing window. Measured from what the clinic already records — the
   * booked duration against the queue's called-to-completed interval — so it
   * needs nothing new from staff.
   */
  SCHEDULING_APPOINTMENTS_OVERRUNNING: "scheduling.appointments_overrunning",
  /**
   * Cancellations and no-shows as a share of the trailing window, rather than of
   * one day.
   *
   * The daily rules judge two cancellations out of four as a crisis, which at a
   * small clinic happens most weeks. This is the benchmarkable version — industry
   * no-show runs around 10% — and the only one a clinic can compare itself to.
   */
  SCHEDULING_SUSTAINED_ATTRITION: "scheduling.sustained_attrition",
  /**
   * Median days patients wait between booking and being seen.
   *
   * Reads as demand pressure, not as a service failure: a lengthening lead time
   * means people want appointments the clinic cannot offer soon. Deliberately NOT
   * a standalone finding — it strengthens the capacity-ceiling reading, because on
   * its own a long lead time is equally consistent with patients choosing a date
   * that suits them.
   */
  SCHEDULING_LONG_BOOKING_LEAD_TIME: "scheduling.long_booking_lead_time",
  // Retention / acquisition
  ACQUISITION_LOW_NEW_PATIENTS: "acquisition.low_new_patients",
  RETENTION_RETURNING_VOLUME_DROPPING: "retention.returning_volume_dropping",
  RETENTION_FOLLOWUP_BACKLOG: "retention.followup_backlog",
  /**
   * Patients seen at least once, not seen for a recall interval, with nothing
   * booked. A LEVEL rather than a rate, and it only ever grows until somebody
   * works it — which is why its severity is floored, the same way the follow-up
   * backlog's is.
   */
  RETENTION_LAPSED_PATIENT_BASE: "retention.lapsed_patient_base",
  // Operational
  OPERATIONAL_LONG_WAITING_TIME: "operational.long_waiting_time",
  OPERATIONAL_QUEUE_BACKLOG: "operational.queue_backlog",
  OPERATIONAL_QUEUE_BUILDING_UP: "operational.queue_building_up",
  OPERATIONAL_LOW_CHAIR_UTILIZATION: "operational.low_chair_utilization",
  /**
   * Chair utilization over the trailing window, rather than on one date.
   *
   * A quiet Tuesday is weather; a month at 34% is the business. The daily rule
   * fires on both and cannot distinguish them, which is precisely how a dashboard
   * teaches a dentist to stop reading it.
   */
  OPERATIONAL_SUSTAINED_LOW_UTILIZATION: "operational.sustained_low_utilization",
  OPERATIONAL_NEAR_FULL_CAPACITY: "operational.near_full_capacity",
  // Clinical
  CLINICAL_LARGE_PENDING_TREATMENT_VALUE: "clinical.large_pending_treatment_value",
  CLINICAL_ACCEPTED_TREATMENTS_UNSCHEDULED: "clinical.accepted_treatments_unscheduled",
  CLINICAL_PIPELINE_STALLED: "clinical.pipeline_stalled",
} as const;

export type SignalType = (typeof SignalType)[keyof typeof SignalType];

/**
 * A single attention-worthy event.
 */
export interface Signal {
  /** Stable identifier for this signal. */
  readonly id: string;
  /** Short headline (e.g. "Payment overdue"). */
  readonly title: string;
  /** Fuller explanation of what was detected. */
  readonly description: string;
  /** How serious the situation is. */
  readonly severity: Severity;
  /** How urgently it should be handled. */
  readonly priority: Priority;
  /** Optional grouping category. */
  readonly category?: SignalCategory;
  /** DentGrow entities this signal concerns. */
  readonly relatedEntities: readonly RelatedEntity[];
  /** Optional ids of the metrics this signal was derived from. */
  readonly metricIds?: readonly string[];
  /** ISO-8601 timestamp of when the signal was generated. */
  readonly generatedAt: string;
  /**
   * How complete and trustworthy the underlying data was, in [0, 1].
   * This is a data-completeness score, NOT an AI probability.
   */
  readonly confidence?: Confidence;
  /** Measurable justification for why this signal exists. */
  readonly evidence?: readonly Evidence[];
}
