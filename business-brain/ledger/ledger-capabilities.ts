/**
 * Business Brain — Clinic Ledger: what this deployment records
 *
 * The relational facts say what IS in a slice. This catalogue says what COULD
 * be — per relationship an engine might want to walk — and, for everything that
 * cannot be walked, why not.
 *
 * It exists so that an absence has exactly one reading. Without it, an engine
 * that finds no booking for a planned crown cannot tell "the patient has not
 * booked" from "OraMedha has nowhere to write that down", and those lead to
 * opposite conclusions about the clinic. With it, the graph answers the second
 * case as `not_recorded`, by name, before any data is consulted.
 *
 * Three levels, and the middle one is the one that matters most:
 *
 *   recorded            the schema holds it and the app writes it
 *   partially_recorded  the schema holds SOME of it, and the limitation says
 *                       exactly which part is missing and which way that biases
 *                       any reading
 *   not_recorded        nothing holds it; no adapter can supply it, and no
 *                       engine may infer it
 *
 * This is a statement about the schema and the application's write paths, read
 * from source — not about any particular clinic's data quality. A clinic that
 * never uses the queue still has a `recorded` queue capability; its facts will
 * simply carry nulls, which the fact types already say mean "not recorded".
 */

import { LedgerFactKind } from "./ledger-facts";

export const LedgerRecording = {
  RECORDED: "recorded",
  PARTIALLY_RECORDED: "partially_recorded",
  NOT_RECORDED: "not_recorded",
} as const;

export type LedgerRecording = (typeof LedgerRecording)[keyof typeof LedgerRecording];

/** Where a recorded capability surfaces: a fact kind in a slice, or the capacity window. */
export type LedgerExposure = LedgerFactKind | "capacity_window";

export interface LedgerCapability {
  readonly key: string;
  readonly recording: LedgerRecording;
  /** What the relationship is, in plain words. */
  readonly description: string;
  /**
   * For recorded/partial capabilities: the fact kind that carries it. Null for
   * `not_recorded` — a test asserts the pairing both ways.
   */
  readonly exposedAs: LedgerExposure | null;
  /**
   * What is missing and which way it biases a reading. Required for anything
   * less than fully recorded; may still note a caveat for `recorded`.
   */
  readonly limitation: string | null;
}

export const LEDGER_CAPABILITIES = {
  PATIENT_ROSTER: {
    key: "patient_roster",
    recording: LedgerRecording.RECORDED,
    description: "Live patients, when each was registered, and whether an agreed payment plan is running.",
    exposedAs: LedgerFactKind.PATIENT,
    limitation: "Identifiers only: the ledger never carries a name, contact detail or date of birth.",
  },
  PATIENT_APPOINTMENTS: {
    key: "patient_appointments",
    recording: LedgerRecording.RECORDED,
    description: "Every appointment a patient has had or has booked, with status, length and when it was booked.",
    exposedAs: LedgerFactKind.APPOINTMENT,
    limitation: null,
  },
  APPOINTMENT_STATUS_HISTORY: {
    key: "appointment_status_history",
    recording: LedgerRecording.PARTIALLY_RECORDED,
    description: "When an appointment was cancelled, rescheduled or changed status, from appointment_history.",
    exposedAs: LedgerFactKind.APPOINTMENT_EVENT,
    limitation:
      "Written by the appointment server actions only. A change made any other way leaves no event, so a missing event is not evidence the change did not happen — cancellation notice for such a row is unknown, never zero.",
  },
  TREATMENT_RECORDING_VISIT: {
    key: "treatment_recording_visit",
    recording: LedgerRecording.RECORDED,
    description: "The visit each treatment was recorded at (treatments.appointment_id, NOT NULL).",
    exposedAs: LedgerFactKind.TREATMENT,
    limitation:
      "This is where the treatment was written down, not where it will be delivered. For planned work it is the past consultation that planned it.",
  },
  PLANNED_TREATMENT_BOOKING: {
    key: "planned_treatment_booking",
    recording: LedgerRecording.NOT_RECORDED,
    description: "Which future appointment will deliver a specific planned treatment.",
    exposedAs: null,
    limitation:
      "No column links planned work to the visit booked for it. Only the patient-level question — does this patient have ANY upcoming visit — is answerable, and it under-reports unbooked work.",
  },
  TREATMENT_PLAN: {
    key: "treatment_plan",
    recording: LedgerRecording.NOT_RECORDED,
    description: "A treatment plan as a unit grouping several treatments, with its own acceptance and completion.",
    exposedAs: null,
    limitation:
      "Treatments are individual rows with no plan id. Plan-level acceptance, sequencing and completion cannot be measured; only individual planned rows can.",
  },
  TREATMENT_DECISION: {
    key: "treatment_decision",
    recording: LedgerRecording.NOT_RECORDED,
    description: "Whether proposed treatment was presented to the patient and accepted or declined.",
    exposedAs: null,
    limitation:
      "`planned` records that work was written down, not that the patient agreed to it. Case acceptance is not measurable.",
  },
  TREATMENT_STATUS_HISTORY: {
    key: "treatment_status_history",
    recording: LedgerRecording.PARTIALLY_RECORDED,
    description: "When a treatment changed status, from treatment_history.",
    exposedAs: LedgerFactKind.TREATMENT_EVENT,
    limitation:
      "The trail began with migration 20260903000300. Earlier transitions were never recorded, so a treatment with no event is not a treatment that never changed.",
  },
  VISIT_QUEUE_TIMING: {
    key: "visit_queue_timing",
    recording: LedgerRecording.RECORDED,
    description: "Arrival, call-in and finish for the appointment a queue entry served (queue_entries.appointment_id, NOT NULL).",
    exposedAs: LedgerFactKind.QUEUE_VISIT,
    limitation:
      "Only when the front desk uses the queue. An attended visit with no entry has an unmeasured duration and arrival, not a zero one.",
  },
  FOLLOW_UP_ORIGIN: {
    key: "follow_up_origin",
    recording: LedgerRecording.PARTIALLY_RECORDED,
    description: "The visit and treatment that raised a follow-up.",
    exposedAs: LedgerFactKind.FOLLOW_UP,
    limitation: "Both links are optional; a follow-up raised from the patient profile carries neither.",
  },
  FOLLOW_UP_BOOKING: {
    key: "follow_up_booking",
    recording: LedgerRecording.PARTIALLY_RECORDED,
    description: "The appointment booked from a follow-up (appointments.follow_up_id).",
    exposedAs: LedgerFactKind.APPOINTMENT,
    limitation:
      "Set when the follow-up flow creates the visit. A recall booked by hand from the appointment book carries no link, so recall conversion read from this link UNDER-reports.",
  },
  FOLLOW_UP_COMPLETION_TIME: {
    key: "follow_up_completion_time",
    recording: LedgerRecording.NOT_RECORDED,
    description: "The moment a follow-up was marked completed.",
    exposedAs: null,
    limitation: "Follow-up status is not versioned. updated_at is the last change to any field.",
  },
  PAYMENT_ALLOCATION: {
    key: "payment_allocation",
    recording: LedgerRecording.PARTIALLY_RECORDED,
    description: "Which treatment a payment paid for.",
    exposedAs: LedgerFactKind.PAYMENT,
    limitation:
      "payments.treatment_id is optional and the app allocates money oldest-first across a patient's whole ledger. An unlinked payment is not an unpaid treatment; per-treatment collection must use that allocation, not the link.",
  },
  REMINDER_SENDS: {
    key: "reminder_sends",
    recording: LedgerRecording.PARTIALLY_RECORDED,
    description: "A staff member confirmed sending a patient a message of a given kind (reminder_logs).",
    exposedAs: LedgerFactKind.REMINDER_SEND,
    limitation:
      "Keyed to patient and kind, not to an appointment or follow-up; no delivery, read or reply is recorded; a phone call made outside the send list leaves nothing. Absence is not evidence no contact was attempted.",
  },
  CONTACT_OUTCOME: {
    key: "contact_outcome",
    recording: LedgerRecording.NOT_RECORDED,
    description: "Whether an attempt to contact a patient reached them.",
    exposedAs: null,
    limitation: "Nothing records reached / not reached. Never-reached and reached-and-declined are indistinguishable.",
  },
  DISCOUNTS_AND_WRITE_OFFS: {
    key: "discounts_and_write_offs",
    recording: LedgerRecording.NOT_RECORDED,
    description: "A reduced bill, a discount or a written-off balance.",
    exposedAs: null,
    limitation: "A reduced charge and an unpaid charge are indistinguishable.",
  },
  ACTION_COMPLETIONS: {
    key: "action_completions",
    recording: LedgerRecording.RECORDED,
    description: "Business Brain actions declared done, with the patients each targeted.",
    exposedAs: LedgerFactKind.ACTION_COMPLETION,
    limitation: "Visible to dentists only (RLS). A declaration that work was done, not proof it was.",
  },
  PATIENT_CONTACTABILITY: {
    key: "patient_contactability",
    recording: LedgerRecording.PARTIALLY_RECORDED,
    description: "Whether a patient has a usable phone number on record and has not withdrawn communications consent.",
    exposedAs: LedgerFactKind.PATIENT,
    limitation:
      "A number on record is not a patient who answers, and consent governs messages rather than every call. Contactable demand is therefore an upper bound on who can actually be reached.",
  },
  CLINIC_CAPACITY: {
    key: "clinic_capacity",
    recording: LedgerRecording.RECORDED,
    description: "When the clinic is open, per date and chair: availability rules less closed dates and consultancy blocks.",
    exposedAs: "capacity_window",
    limitation:
      "Rules are clinic-wide, not per dentist or per chair, so published time assumes every chair is staffed whenever the clinic is open.",
  },
  STAFF_CAPACITY: {
    key: "staff_capacity",
    recording: LedgerRecording.NOT_RECORDED,
    description: "Which staff are on shift, and how much of their time is free for calls and admin.",
    exposedAs: null,
    limitation: "No roster, shift or task-time record exists. A backlog cannot be matched against the people available to work it.",
  },
  PATIENT_AVAILABILITY: {
    key: "patient_availability",
    recording: LedgerRecording.NOT_RECORDED,
    description: "When a patient is able or prefers to attend.",
    exposedAs: null,
    limitation: "Nothing records preferred days or times, so no patient can be claimed to fit a particular slot.",
  },
  STANDBY_LIST: {
    key: "standby_list",
    recording: LedgerRecording.NOT_RECORDED,
    description: "Patients who asked to be offered an earlier appointment if one frees up.",
    exposedAs: null,
    limitation: "There is no waiting or standby list. Candidates for a freed slot are inferred from open work, not from anyone who asked.",
  },
  PLANNED_TREATMENT_DURATION: {
    key: "planned_treatment_duration",
    recording: LedgerRecording.NOT_RECORDED,
    description: "How long the visit for a specific planned treatment is expected to take.",
    exposedAs: null,
    limitation: "Planned treatments carry no expected duration, so a gap can be sized in typical appointments but not matched to a specific procedure.",
  },
  ENQUIRY_DEMAND: {
    key: "enquiry_demand",
    recording: LedgerRecording.NOT_RECORDED,
    description: "Enquiries and booking requests that did not become appointments.",
    exposedAs: null,
    limitation: "Only bookings that were made are recorded, so new-patient demand cannot be matched against open capacity.",
  },
  PROVIDER_ATTRIBUTION: {
    key: "provider_attribution",
    recording: LedgerRecording.RECORDED,
    description: "The dentist each appointment was booked with (appointments.dentist_id).",
    exposedAs: LedgerFactKind.APPOINTMENT,
    limitation: "Recorded, but the product currently assumes one dentist per clinic; availability rules are clinic-wide, not per provider.",
  },
} as const satisfies Record<string, LedgerCapability>;

export type LedgerCapabilityKey = keyof typeof LEDGER_CAPABILITIES;

export const ALL_LEDGER_CAPABILITIES: readonly LedgerCapability[] = Object.values(LEDGER_CAPABILITIES);
