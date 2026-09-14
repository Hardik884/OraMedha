/**
 * Business Brain — Clinic Ledger: relational facts
 *
 * The Metrics Engine reasons over a `ClinicDataSnapshot`, which is deliberately
 * FLAT: a treatment there has no appointment and no type, a queue entry has no
 * patient, a follow-up is a due date and a status. That shape is right for
 * counting and wrong for connecting — no amount of flat rows can say whether the
 * follow-up raised after a root canal produced a visit, or which patient a queue
 * wait belonged to.
 *
 * These types are the other half: the same clinic ledgers with their foreign keys
 * intact, so an engine can walk patient → appointment → treatment → queue →
 * follow-up → payment → action completion without a new flattened metric for
 * every question.
 *
 * ## Rules every fact follows
 *
 * - **Identifiers, not identities.** No names, phone numbers, emails, dates of
 *   birth, clinical notes or free text. A fact carries what reasoning needs and
 *   nothing that identifies whose record it is.
 * - **Every fact carries its clinic.** Stamped by the adapter from a
 *   clinic-scoped query, and checked again by `buildLedgerGraph`, which refuses a
 *   slice that mixes tenants rather than quietly joining across them.
 * - **Nullable means "not recorded", never "zero" or "no".** `calledAt: null` is
 *   a visit whose call-in nobody recorded, not a visit with no wait.
 * - **Names say what the column MEANS, not what it is called.** The clearest
 *   case is `TreatmentFact.recordedAtAppointmentId`: `treatments.appointment_id`
 *   is the visit the treatment was RECORDED at. For planned work that is the
 *   consultation that planned it, not a booking for the visit that will deliver
 *   it — and naming it `appointmentId` is precisely how that gets misread.
 * - **Soft-deleted rows never appear.** A fact exists only while its row is live.
 *
 * Pure types. No database client, no clock, no I/O.
 */

/** DentGrow `appointment_status`. */
export type LedgerAppointmentStatus =
  | "scheduled"
  | "checked_in"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "no_show";

/** DentGrow `treatment_status`. */
export type LedgerTreatmentStatus = "planned" | "in_progress" | "completed" | "cancelled";

/** DentGrow `follow_up_status`. */
export type LedgerFollowUpStatus = "pending" | "completed" | "cancelled";

/** DentGrow `queue_status`. */
export type LedgerQueueStatus = "waiting" | "in_progress" | "completed";

/** Every kind of fact a ledger slice can carry. */
export const LedgerFactKind = {
  PATIENT: "patient",
  APPOINTMENT: "appointment",
  APPOINTMENT_EVENT: "appointment_event",
  TREATMENT: "treatment",
  TREATMENT_EVENT: "treatment_event",
  QUEUE_VISIT: "queue_visit",
  FOLLOW_UP: "follow_up",
  PAYMENT: "payment",
  REMINDER_SEND: "reminder_send",
  ACTION_COMPLETION: "action_completion",
} as const;

export type LedgerFactKind = (typeof LedgerFactKind)[keyof typeof LedgerFactKind];

/** A patient on the roster — the anchor every other fact hangs from. */
export interface PatientFact {
  readonly clinicId: string;
  readonly id: string;
  /** ISO-8601 moment the patient record was created. */
  readonly registeredAt: string;
  /**
   * "YYYY-MM-DD" an agreed payment plan runs until, or null when none is
   * recorded. The date only — never the terms.
   */
  readonly paymentPlanUntil: string | null;
  /**
   * Whether a usable phone number is on record, by the same rule the WhatsApp
   * send list uses (`isWhatsAppReachable`). The number itself never leaves the
   * adapter. True says a number exists, not that the patient will answer.
   */
  readonly reachableByPhone: boolean;
  /**
   * Whether the patient's latest communications-consent decision is
   * `withdrawn`. A patient who withdrew is removed from every outreach
   * population before anything is prepared for them — the same rule
   * `buildReachable` applies to reminders.
   */
  readonly communicationsWithdrawn: boolean;
}

/** One appointment, with the provenance links the flat snapshot drops. */
export interface AppointmentFact {
  readonly clinicId: string;
  readonly id: string;
  readonly patientId: string;
  readonly dentistId: string;
  /** ISO-8601 scheduled start. */
  readonly scheduledAt: string;
  /** ISO-8601 moment the appointment was booked (`created_at`). */
  readonly bookedAt: string;
  readonly durationMinutes: number;
  readonly status: LedgerAppointmentStatus;
  /**
   * DentGrow `appointment_source`. Not a pure acquisition channel: a visit the
   * system creates from a follow-up is recorded as `other`.
   */
  readonly source: string;
  /**
   * The follow-up this appointment was booked FROM (`appointments.follow_up_id`),
   * or null. Null means "not booked through a follow-up", which is not the same
   * as "not a recall": a recall booked by hand carries no link.
   */
  readonly originFollowUpId: string | null;
}

/**
 * One entry from `appointment_history`.
 *
 * Only the fields reasoning needs are extracted, and they are extracted in the
 * query: the audit row's jsonb is never loaded whole.
 */
export interface AppointmentEventFact {
  /**
   * `appointment_history` has no `clinic_id` column. The adapter reads events
   * only for appointments it has already loaded under a clinic predicate and
   * stamps the clinic from those, so this is inherited rather than trusted.
   */
  readonly clinicId: string;
  readonly id: string;
  readonly appointmentId: string;
  readonly action: "created" | "rescheduled" | "cancelled" | "status_changed";
  /** ISO-8601 moment of the change. */
  readonly at: string;
  /** Status after the change, when the change recorded one. */
  readonly statusAfter: string | null;
  /**
   * Who made the change: a person, or the system with no actor (the nightly
   * no-show job — an inference, not an observation). Absent when not read.
   */
  readonly recordedBy?: "person" | "system";
  /** The actor's role when the change was recorded; null when not recorded. Absent when not read. */
  readonly actorRole?: string | null;
  /** Previous scheduled start, when the change moved the appointment. */
  readonly previousScheduledAt: string | null;
}

/** The parts of a treatment's charge, as the billing module defines them. */
export interface TreatmentCharge {
  /** Treatment cost counted towards the balance — zero until the work is billable. */
  readonly treatment: number;
  /** Consultation (OPD) charge, owed whenever it was charged. */
  readonly consultation: number;
  /** Radiograph charge, owed whenever one was taken. */
  readonly radiograph: number;
  /** `treatmentTotalCharge` — the one figure every balance in the app agrees on. */
  readonly total: number;
  /**
   * Treatment cost as recorded, regardless of status. For planned work this is
   * the value at stake; it is not owed.
   */
  readonly quoted: number;
}

/** One treatment row. */
export interface TreatmentFact {
  readonly clinicId: string;
  readonly id: string;
  readonly patientId: string;
  /**
   * The visit this treatment was RECORDED at (`treatments.appointment_id`).
   *
   * NOT a booking. For planned work this is the visit where the plan was written
   * down, which is always in the past. OraMedha records no link from a planned
   * treatment to the future appointment that will deliver it — see the
   * `planned_treatment_booking` capability.
   */
  readonly recordedAtAppointmentId: string;
  readonly treatmentType: string;
  readonly status: LedgerTreatmentStatus;
  readonly charge: TreatmentCharge;
  /** ISO-8601 moment the work was performed, or null when not recorded. */
  readonly performedAt: string | null;
  /** ISO-8601 moment the row was created. */
  readonly recordedAt: string;
  /** External consultant who performed it, when one did. */
  readonly consultantId: string | null;
}

/**
 * One entry from `treatment_history`.
 *
 * The trail began with migration 20260903000300; a treatment last touched before
 * then has no events at all, which is "not recorded", not "never changed".
 */
export interface TreatmentEventFact {
  readonly clinicId: string;
  readonly id: string;
  readonly treatmentId: string;
  readonly patientId: string;
  readonly action: "created" | "updated" | "status_changed" | "deleted" | "restored";
  readonly at: string;
  /** Status after the change, when the change touched status. */
  readonly statusAfter: string | null;
}

/** One pass through the waiting room, tied to the appointment it served. */
export interface QueueVisitFact {
  readonly clinicId: string;
  readonly id: string;
  readonly appointmentId: string;
  readonly patientId: string;
  /** Clinic-local business date, "YYYY-MM-DD". */
  readonly queueDate: string;
  readonly status: LedgerQueueStatus;
  readonly checkedInAt: string;
  /** Called into the chair; null when not recorded. */
  readonly calledAt: string | null;
  /**
   * Whether `checkedInAt` is evidence of a real arrival. False for a visit
   * clicked through — completed within a minute of check-in, never called in —
   * whose check-in is a button press (`record-evidence.ts`). Absent when not read.
   */
  readonly arrivalRecorded?: boolean;
  /** Finished with; null when not recorded. */
  readonly completedAt: string | null;
}

/** One follow-up / recall. */
export interface FollowUpFact {
  readonly clinicId: string;
  readonly id: string;
  readonly patientId: string;
  /** Visit that raised it, when recorded. */
  readonly originAppointmentId: string | null;
  /** Treatment that raised it, when recorded. */
  readonly treatmentId: string | null;
  /** "YYYY-MM-DD". */
  readonly dueDate: string;
  readonly status: LedgerFollowUpStatus;
  readonly confirmation: "tentative" | "confirmed";
  readonly followUpType: string;
  readonly recordedAt: string;
  /**
   * Last change to ANY field. Not a completion time — OraMedha does not version
   * follow-up status, so "when was this completed" is not recorded.
   */
  readonly lastChangedAt: string;
}

/** One payment received. */
export interface PaymentFact {
  readonly clinicId: string;
  readonly id: string;
  readonly patientId: string;
  /** Visit the payment was taken against, when recorded. */
  readonly appointmentId: string | null;
  /**
   * Treatment the payment was linked to, when recorded. OPTIONAL in the app, and
   * money is allocated oldest-first across a patient's ledger regardless — so an
   * unlinked payment is not an unpaid treatment.
   */
  readonly treatmentId: string | null;
  readonly amount: number;
  /** "YYYY-MM-DD" the money arrived. */
  readonly paymentDate: string;
  readonly method: string;
}

/**
 * A staff member confirmed they sent a patient a message of this kind.
 *
 * Keyed to the patient and the kind only — not to an appointment or follow-up —
 * and recording neither delivery nor reply.
 */
export interface ReminderSendFact {
  readonly clinicId: string;
  readonly id: string;
  readonly patientId: string;
  readonly kind: string;
  readonly sentAt: string;
}

/** A Business Brain action someone declared done, and who it targeted. */
export interface ActionCompletionFact {
  readonly clinicId: string;
  readonly id: string;
  readonly category: string;
  readonly constraintId: string;
  readonly completedAt: string;
  readonly source: "declared" | "inferred";
  readonly targetPatientIds: readonly string[];
}

/** One open period of one chair, as UTC instants. */
export interface OpenSpanFact {
  readonly start: string;
  readonly end: string;
}

/** The clinic's published open time on one clinic-local business date. */
export interface CapacityDayFact {
  readonly date: string;
  /** UTC instant of the clinic-local start of the date. */
  readonly startsAt: string;
  /** UTC instant of the clinic-local end of the date. */
  readonly endsAt: string;
  /** Open periods per chair, sorted, non-overlapping. Empty when closed. */
  readonly openSpans: readonly OpenSpanFact[];
  /** Sum of the spans in minutes — equal by construction to the metrics' open minutes. */
  readonly openMinutesPerChair: number;
}

/**
 * Published capacity for a date range: WHEN the clinic is open, not only how
 * long. Derived from availability rules, closed dates and consultancy blocks by
 * the same helper the utilization metrics use.
 */
export interface CapacityWindowFact {
  readonly clinicId: string;
  readonly from: string;
  readonly to: string;
  readonly timezone: string;
  readonly chairCount: number;
  /**
   * The clinic's configured typical appointment length, or null when the clinic
   * has not set one. Never defaulted here: a consumer that sizes gaps with an
   * assumed length has to say so.
   */
  readonly typicalAppointmentMinutes: number | null;
  /** False when the clinic has no active availability rule at all. */
  readonly availabilityConfigured: boolean;
  readonly days: readonly CapacityDayFact[];
}
