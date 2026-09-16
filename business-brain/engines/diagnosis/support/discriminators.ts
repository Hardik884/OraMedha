/**
 * Business Brain — Diagnosis Engine: discriminator catalogue
 *
 * Every measurement the engine can name as "this would separate those two
 * explanations", in one place.
 *
 * This file is a deliverable, not plumbing. The set of entries whose availability
 * is not `available` is precisely the list of data the next phases need: each
 * `requires_entity_data` entry justifies one method on the DiagnosisContextPort,
 * each `requires_new_metric` entry justifies one addition to the Metrics Engine,
 * and each `requires_longer_history` entry justifies a snapshot retention rule.
 *
 * Descriptions state what would be measured. They never state what anyone should
 * do about it.
 */

/** What it would take to obtain a discriminating measurement. */
export const Availability = {
  /** Computable from metrics the Metrics Engine already produces. */
  AVAILABLE: "available",
  /** Needs per-entity rows (which patients, which appointments, which invoices). */
  REQUIRES_ENTITY_DATA: "requires_entity_data",
  /**
   * Needs a measurement the Metrics Engine does not currently produce, FROM DATA
   * THE CLINIC ALREADY HOLDS. A development task and nothing more.
   */
  REQUIRES_NEW_METRIC: "requires_new_metric",
  /**
   * Needs the clinic to start RECORDING something it does not record at all.
   *
   * Deliberately separate from `requires_new_metric`, because the two are not
   * remotely the same size of job. A new metric is an afternoon's work over rows
   * that already exist. New data capture means a schema change, a change to what
   * staff are asked to do at the chair, and a wait until enough of it accumulates
   * to measure — a product decision, not an engineering one.
   *
   * Conflating them made this catalogue read as nine cheap tasks when eight of
   * them were not tasks for the Metrics Engine at all.
   */
  REQUIRES_DATA_CAPTURE: "requires_data_capture",
  /** Computable from existing metrics, but only over more days than were supplied. */
  REQUIRES_LONGER_HISTORY: "requires_longer_history",
} as const;

export type Availability = (typeof Availability)[keyof typeof Availability];

/** A catalogue entry: the measurement, and what it would take to get it. */
export interface DiscriminatorSpec {
  readonly slug: string;
  readonly description: string;
  readonly availability: Availability;
  /**
   * For entity-level entries, the DiagnosisContextPort method that would serve
   * it. Populated so the port can be justified by real need rather than
   * speculation. Null for every other availability.
   */
  readonly portMethod: string | null;
}

/** Every discriminator the matchers can attach. */
export const DISCRIMINATORS = {
  // ---- available from existing metrics -------------------------------------
  CHAIR_UTILIZATION_LEVEL: {
    slug: "chair_utilization_level",
    description:
      "Chair utilization for the day, compared against the configured near-capacity mark: it separates a clinic whose capacity was consumed from one that had idle capacity while patients waited.",
    availability: Availability.AVAILABLE,
    portMethod: null,
  },
  DELIVERED_WORK_VOLUME: {
    slug: "delivered_work_volume",
    description:
      "Total appointments and completed treatments for the day, compared against their configured thresholds: it separates a shortfall in work delivered from a shortfall in money collected for work that was delivered.",
    availability: Availability.AVAILABLE,
    portMethod: null,
  },
  ACCEPTED_DEMAND_LEVEL: {
    slug: "accepted_demand_level",
    description:
      "The count of planned treatments whose patient has no next visit booked and the pending treatment value, compared against their configured limits: it separates absent demand from demand that exists and was not converted into bookings.",
    availability: Availability.AVAILABLE,
    portMethod: null,
  },
  ATTRITION_MIX: {
    slug: "attrition_mix",
    description:
      "The ratio of cancelled appointments to no-shows for the day: it separates patients who cancelled in advance, leaving a recoverable slot, from patients who did not communicate at all.",
    availability: Availability.AVAILABLE,
    portMethod: null,
  },
  ACQUISITION_VS_RETENTION_SPLIT: {
    slug: "acquisition_vs_retention_split",
    description:
      "New patients today against the configured minimum, alongside the returning-patient change versus the prior period: it separates a fall in first-time patients from a fall in patients coming back.",
    availability: Availability.AVAILABLE,
    portMethod: null,
  },

  // ---- requires a longer history window -----------------------------------
  LONGER_HISTORY_WINDOW: {
    slug: "longer_history_window",
    description:
      "The same signals evaluated over a longer run of consecutive days: it separates a single day's variation from a standing condition.",
    availability: Availability.REQUIRES_LONGER_HISTORY,
    portMethod: null,
  },
  ATTRITION_MIX_OVER_TIME: {
    slug: "attrition_mix_over_time",
    description:
      "The cancellation-to-no-show ratio across several days: on a single day with a small sample the two counts are too close to separate.",
    availability: Availability.REQUIRES_LONGER_HISTORY,
    portMethod: null,
  },
  COLLECTION_LAG_OVER_TIME: {
    slug: "collection_lag_over_time",
    description:
      "Whether collection trailed completed treatment on the following days as well: it separates same-day billing lag, where the money arrives later, from a standing collection process gap.",
    availability: Availability.REQUIRES_LONGER_HISTORY,
    portMethod: null,
  },

  // ---- requires entity-level data (served by the ledger / context port) ----
  CANCELLATION_TIMING: {
    slug: "cancellation_timing",
    description:
      "Per-appointment cancellation timestamps against the appointment's scheduled start: it separates cancellations made with enough notice to refill the slot from cancellations made too late to refill.",
    availability: Availability.REQUIRES_ENTITY_DATA,
    portMethod: "listCancellationEvents",
  },
  CANCELLATION_SLOT_CLUSTERING: {
    slug: "cancellation_slot_clustering",
    description:
      "The distribution of cancelled and missed appointments across time-of-day slots: it separates attrition concentrated in a subset of slots from attrition spread evenly. Treatment type is only a secondary lens and usually absent: an appointment records no booked treatment type, so a type is known only where a treatment was recorded against the lost appointment itself, and type concentration is not called unless enough lost appointments carry one.",
    availability: Availability.REQUIRES_ENTITY_DATA,
    portMethod: "listCancellationEvents",
  },
  SLOT_REFILL_OUTCOME: {
    slug: "slot_refill_outcome",
    description:
      "Whether each cancelled slot is now occupied by another live appointment at the same start time with the same dentist: it separates lost capacity from recovered capacity. A slot refilled at a shifted time is not matched, so this UNDER-reports recovery.",
    availability: Availability.REQUIRES_ENTITY_DATA,
    portMethod: "listCancellationEvents",
  },
  NO_SHOW_PATIENT_HISTORY: {
    slug: "no_show_patient_history",
    description:
      "Prior attendance history of the patients who did not attend: it separates repeat non-attenders from first-time non-attenders.",
    availability: Availability.REQUIRES_ENTITY_DATA,
    portMethod: "listNoShowHistory",
  },
  PENDING_TREATMENT_AGE: {
    slug: "pending_treatment_age",
    description:
      "Days elapsed since each unbooked plan was recorded: it separates a plan recorded today with no next visit yet from a plan recorded weeks ago and still with no next visit booked.",
    availability: Availability.REQUIRES_ENTITY_DATA,
    portMethod: "listPendingTreatments",
  },
  PENDING_TREATMENT_COMPOSITION: {
    slug: "pending_treatment_composition",
    description:
      "Treatment type and value of each planned treatment whose patient has no next visit booked: it separates a backlog concentrated in long or high-value procedures from one spread across routine work.",
    availability: Availability.REQUIRES_ENTITY_DATA,
    portMethod: "listPendingTreatments",
  },
  OUTSTANDING_INVOICE_AGEING: {
    slug: "outstanding_invoice_ageing",
    description:
      "Age and size of each unpaid balance: it separates a receivable book made of today's uncollected work from one made of long-unpaid balances.",
    availability: Availability.REQUIRES_ENTITY_DATA,
    portMethod: "listOutstandingBalances",
  },
  APPOINTMENT_ARRIVAL_TIMES: {
    slug: "appointment_arrival_times",
    description:
      "Actual arrival time against scheduled time for each appointment, and the resulting concurrency through the day: it separates queueing caused by patients arriving together from queueing caused by exhausted capacity.",
    availability: Availability.REQUIRES_ENTITY_DATA,
    portMethod: "listAppointmentArrivals",
  },
  COMPLETED_TREATMENT_MIX: {
    slug: "completed_treatment_mix",
    description:
      "Treatment type and billed value of each treatment completed today: it separates low revenue caused by a lower-value case mix from low revenue caused by uncollected billing.",
    availability: Availability.REQUIRES_ENTITY_DATA,
    portMethod: "listCompletedTreatments",
  },

  // ---- requires data capture ----------------------------------------------
  //
  // Audited against the schema in the ledger tranche. Each description says
  // exactly what IS recorded and what is not, because "not recorded" and
  // "partially recorded" bias a reading in different directions.
  REMINDER_DELIVERY_LOG: {
    slug: "reminder_delivery_log",
    description:
      "Whether an appointment reminder was dispatched and delivered for each affected appointment. PARTIALLY RECORDED: `reminder_logs` records that a staff member confirmed sending a patient a message of a given kind, but it is keyed to the patient rather than the appointment, and records no delivery, read or reply — so a reminder that was sent and ignored and one that never arrived are indistinguishable, and a call made outside the send list leaves no row. Needs a communications record keyed to the appointment, with delivery status.",
    availability: Availability.REQUIRES_DATA_CAPTURE,
    portMethod: null,
  },
  RECALL_CONTACT_ATTEMPTS: {
    slug: "recall_contact_attempts",
    description:
      "Contact attempts recorded against each overdue follow-up, with outcome: it separates recalls never attempted from recalls attempted and not reaching the patient. PARTIALLY RECORDED: `reminder_logs` holds a staff-confirmed send per patient and message kind, but not per follow-up, and nothing records whether the patient was reached. Absence of a send is not evidence no attempt was made (a phone call leaves no row), and a send cannot say whether it reached anyone — so neither hypothesis can be settled. Previously catalogued as entity data served by a port method that could only ever return null.",
    availability: Availability.REQUIRES_DATA_CAPTURE,
    portMethod: null,
  },
  CHARGE_RECONCILIATION: {
    slug: "charge_reconciliation",
    description:
      "Work delivered matched against what was charged for it. NOT RECORDED AS SUCH: in OraMedha the treatment row IS the charge, so work that was done and never written up leaves no row at all and is invisible to `outstanding_invoice_ageing` however that ageing reads. The ledger can see two narrower proxies — an attended appointment with no treatment recorded against it, and a completed treatment with a zero total charge — but neither proves unbilled work: a review visit legitimately records nothing. Needs a record of work performed that is independent of the charge.",
    availability: Availability.REQUIRES_DATA_CAPTURE,
    portMethod: null,
  },
  BOOKING_CHANNEL_ACTIVITY: {
    slug: "booking_channel_activity",
    description:
      "Booking requests received and declined per channel, including calls not converted to appointments. PARTIALLY RECORDED: `appointments.source` gives the channel for bookings that were made (a visit the system creates from a follow-up is recorded as `other`), but an enquiry that never became an appointment leaves no row at all — and the unconverted side is the half that separates open slots nobody asked for from open slots never offered.",
    availability: Availability.REQUIRES_DATA_CAPTURE,
    portMethod: null,
  },
  PROVIDER_AVAILABILITY_ROSTER: {
    slug: "provider_availability_roster",
    description:
      "Chair-hours actually opened for booking on the day, from the clinic's own availability rules and chair count: it separates idle chairs with nothing rostered from idle chairs that were bookable and went unbooked.",
    availability: Availability.AVAILABLE,
    portMethod: null,
  },
  SERVICE_TIME_DISTRIBUTION: {
    slug: "service_time_distribution",
    description:
      "Actual versus scheduled duration per appointment, from when the patient was called in to when they were finished with: it separates queueing caused by appointments overrunning their booked length from queueing caused by patients arriving together.",
    availability: Availability.REQUIRES_ENTITY_DATA,
    portMethod: "listAppointmentArrivals",
  },
  DISCOUNT_AND_WRITEOFF_LOG: {
    slug: "discount_and_writeoff_log",
    description:
      "Discounts, write-offs, and payment-plan uptake applied to today's billing. NOT RECORDED: treatments carry a cost and payments carry an amount, with nothing between them for a discount or a write-off, so a reduced bill and an unpaid bill are indistinguishable.",
    availability: Availability.REQUIRES_DATA_CAPTURE,
    portMethod: null,
  },
  PATIENT_ACQUISITION_SOURCE: {
    slug: "patient_acquisition_source",
    description:
      "Referral source and enquiry volume per channel for new patients. PARTIALLY RECORDED: `appointments.source` gives the channel each new patient's appointment was booked through (not a referral source), but enquiries that never became appointments are not recorded — and without them, fewer enquiries reaching the clinic cannot be separated from enquiries arriving and not converting.",
    availability: Availability.REQUIRES_DATA_CAPTURE,
    portMethod: null,
  },
  POST_VISIT_FEEDBACK: {
    slug: "post_visit_feedback",
    description:
      "Recorded patient feedback or satisfaction following the last completed visit. NOT RECORDED: OraMedha captures no feedback of any kind, so patients who chose not to return and patients who were never contacted are indistinguishable.",
    availability: Availability.REQUIRES_DATA_CAPTURE,
    portMethod: null,
  },
  TREATMENT_COST_BARRIER: {
    slug: "treatment_cost_barrier",
    description:
      "Quoted value per unbooked plan alongside payment-plan availability and uptake. PARTIALLY RECORDED: quoted values are available from `listPendingTreatments`, and `patients.payment_plan_until` records that a patient has an agreed payment plan — but not what it covers, and nothing records WHY planned work was deferred, so a plan deferred over cost cannot be separated from one deferred for another reason.",
    availability: Availability.REQUIRES_DATA_CAPTURE,
    portMethod: null,
  },
  CATCHMENT_DEMAND_BASELINE: {
    slug: "catchment_demand_baseline",
    description:
      "A demand baseline outside the clinic's own records, such as seasonality or local enquiry volume. NOT HELD: by definition this is not in the clinic's data at all, and no amount of internal measurement substitutes for it.",
    availability: Availability.REQUIRES_DATA_CAPTURE,
    portMethod: null,
  },
} as const satisfies Record<string, DiscriminatorSpec>;

export type DiscriminatorKey = keyof typeof DISCRIMINATORS;

/** Every catalogue entry, in declaration order. */
export const ALL_DISCRIMINATORS: readonly DiscriminatorSpec[] =
  Object.values(DISCRIMINATORS);

/** Catalogue entries the next phases must supply, grouped by availability. */
export function outstandingDiscriminators(
  availability: Availability,
): readonly DiscriminatorSpec[] {
  return ALL_DISCRIMINATORS.filter((spec) => spec.availability === availability);
}

/** Distinct port methods justified by `requires_entity_data` entries. */
export function requiredPortMethods(): readonly string[] {
  const methods = new Set<string>();
  for (const spec of ALL_DISCRIMINATORS) {
    if (spec.portMethod) methods.add(spec.portMethod);
  }
  return [...methods].sort();
}
