/**
 * Business Brain — Diagnosis Engine: entity-context port
 *
 * Implemented by `lib/business-brain/diagnosis-context.ts` and, as a superset, by
 * the clinic ledger adapter (`lib/business-brain/clinic-ledger.ts`, see
 * `business-brain/ledger/clinic-ledger-port.ts`). The service calls the methods
 * the run's discriminators ask for.
 *
 * Every method below is derived from a `requires_entity_data` discriminator that
 * the shipped matchers actually produce — see `support/discriminators.ts`, whose
 * `portMethod` field names the method each entry would be served by, and
 * `requiredPortMethods()`, which returns exactly this method list. A test asserts
 * the two stay in step, so a method cannot be added here without a discriminator
 * to justify it, and a discriminator cannot name a method that does not exist.
 *
 * Design rules, deliberately restrictive:
 *
 * - READ-ONLY. No method creates, updates, or deletes anything.
 * - EXPLICITLY ENUMERATED. There is no `query()`, no `findWhere()`, no predicate
 *   or SQL fragment parameter. A generic escape hatch would let the reasoning
 *   engine express arbitrary data access, which is the coupling this port exists
 *   to prevent.
 * - CLINIC-SCOPED AND DATE-SCOPED. Every method takes the tenant and the window
 *   explicitly; nothing is implicit or ambient.
 * - AGGREGATE-FREE. The port returns rows. It never returns metrics, signals, or
 *   diagnoses, and it never applies a threshold — interpretation stays in the
 *   engine.
 * - BOUNDED. Every method takes a `limit`, because a diagnosis needs a
 *   representative sample to discriminate, not an unbounded export.
 *
 * The implementation lives outside `engines/diagnosis/**`, because the lint
 * boundary in `eslint.config.mjs` forbids this directory from importing a
 * repository or a database client.
 *
 * `listRecallContactAttempts` was removed in the ledger tranche. It could only
 * ever return null — OraMedha records no per-follow-up contact attempt or outcome
 * — so it justified nothing, and its discriminator is now catalogued honestly as
 * `requires_data_capture`.
 */

import type { MetricUnit } from "../../../domain";

/** Inclusive date window, "YYYY-MM-DD" bounds. */
export interface EntityWindow {
  readonly clinicId: string;
  readonly from: string;
  readonly to: string;
  /** Maximum rows to return. Callers page rather than exporting wholesale. */
  readonly limit: number;
}

/** A money or count value with its unit, so the engine never guesses. */
export interface MeasuredAmount {
  readonly value: number;
  readonly unit: MetricUnit;
}

/**
 * One appointment that was booked and then lost.
 * Serves: cancellation_timing, cancellation_slot_clustering, slot_refill_outcome.
 */
export interface CancellationEvent {
  readonly appointmentId: string;
  /** "YYYY-MM-DD" of the appointment. */
  readonly date: string;
  /** ISO-8601 scheduled start of the appointment. */
  readonly scheduledStart: string;
  /** ISO-8601 moment the cancellation was recorded; null for a no-show. */
  readonly cancelledAt: string | null;
  /** Hours between the cancellation and the scheduled start; null for a no-show. */
  readonly noticeHours: number | null;
  readonly outcome: "cancelled" | "no_show";
  /**
   * Type of a treatment recorded AGAINST the lost appointment itself, or null.
   *
   * Not "the treatment booked into the slot": appointments record no booked
   * treatment type, and planned work is recorded against the visit that planned
   * it, not the one booked to deliver it. For a cancelled or missed appointment
   * this is therefore usually null, and a resolver must not call a type
   * concentration from the few rows that carry one.
   */
  readonly treatmentType: string | null;
  /** Whether another appointment subsequently occupied the slot. */
  readonly slotRefilled: boolean;
}

/**
 * Attendance history for a patient who did not attend.
 * Serves: no_show_patient_history.
 */
export interface NoShowHistoryRow {
  readonly patientId: string;
  readonly appointmentId: string;
  readonly date: string;
  /** Prior appointments this patient attended. */
  readonly priorAttended: number;
  /** Prior appointments this patient did not attend. */
  readonly priorMissed: number;
  /** "YYYY-MM-DD" of the patient's most recent attended appointment, if any. */
  readonly lastAttendedDate: string | null;
}

/**
 * One planned treatment whose patient has no next visit booked.
 * Serves: pending_treatment_age, pending_treatment_composition.
 */
export interface PendingTreatmentRow {
  readonly treatmentId: string;
  readonly patientId: string;
  /**
   * "YYYY-MM-DD" the plan was recorded. Named `acceptedOn` for continuity;
   * `planned` is not a record of consent, so this is not an acceptance date.
   */
  readonly acceptedOn: string;
  /** Whole days from when the plan was recorded to the end of the requested window. */
  readonly ageDays: number;
  readonly treatmentType: string;
  readonly quotedValue: MeasuredAmount;
}

/**
 * One unpaid balance.
 * Serves: outstanding_invoice_ageing.
 */
export interface OutstandingBalanceRow {
  readonly invoiceId: string;
  readonly patientId: string;
  /** "YYYY-MM-DD" the balance was raised. */
  readonly raisedOn: string;
  readonly ageDays: number;
  readonly amountOutstanding: MeasuredAmount;
  readonly amountPaid: MeasuredAmount;
}

/**
 * Scheduled versus actual, for one appointment: when the patient arrived, and
 * how long the appointment really took.
 * Serves: appointment_arrival_times, service_time_distribution.
 */
export interface AppointmentArrivalRow {
  readonly appointmentId: string;
  readonly date: string;
  readonly scheduledStart: string;
  /** ISO-8601 arrival, or null when no arrival was recorded. */
  readonly arrivedAt: string | null;
  /** Minutes early (negative) or late (positive); null without an arrival. */
  readonly arrivalDeltaMinutes: number | null;
  /** ISO-8601 moment the patient was seen, when recorded. */
  readonly seenAt: string | null;
  /** ISO-8601 moment the patient was finished with, when recorded. */
  readonly finishedAt: string | null;
  /**
   * Minutes the appointment was PLANNED to take, as booked.
   *
   * A plan, not an observation — which is exactly why it needs comparing
   * against the actual.
   */
  readonly scheduledMinutes: number;
  /**
   * Minutes the appointment ACTUALLY took, seen to finished.
   *
   * `null` when either end was not recorded. Never inferred from anything else:
   * a guessed duration would fabricate the quantity this exists to measure.
   */
  readonly actualMinutes: number | null;
}

/**
 * One treatment completed in the window, with what it billed.
 * Serves: completed_treatment_mix.
 */
export interface CompletedTreatmentRow {
  readonly treatmentId: string;
  readonly patientId: string;
  readonly date: string;
  readonly treatmentType: string;
  readonly billedValue: MeasuredAmount;
  readonly collectedValue: MeasuredAmount;
}

/**
 * Read-only, entity-level context for discriminating between hypotheses that
 * daily aggregate metrics cannot separate.
 *
 * ## `null` means "cannot answer", `[]` means "asked, found nothing"
 *
 * Every method may return `null`, and the distinction is the whole point. A
 * deployment whose schema cannot record something must be able to SAY so: an
 * empty array claims the clinic had no cancellations, no overdue recalls, no
 * unpaid balances — a much stronger statement, and a false one.
 *
 * This is the same discipline the rest of the module already applies. A metric
 * that cannot be measured is withheld rather than reported as zero; an evaluator
 * that could not run is `skipped` rather than `no_signal`; a hypothesis with no
 * evidence is `undetermined` rather than rejected. A discriminator reading `[]`
 * as "none" where the truth is "unrecorded" would resolve a hypothesis it has no
 * business resolving.
 *
 * An implementation returns `null` for anything its schema genuinely cannot
 * answer, permanently and by construction — not for a transient failure, which
 * should throw and be handled as a failure.
 */
export interface DiagnosisContextPort {
  /**
   * Appointments booked and then lost in the window, with cancellation notice
   * and whether the slot was refilled.
   *
   * Discriminates advance cancellations from no-shows at the slot level, whether
   * losses cluster in particular times or treatment types, and whether lost
   * capacity was recovered.
   */
  listCancellationEvents(window: EntityWindow): Promise<readonly CancellationEvent[] | null>;

  /**
   * Prior attendance history for the patients who did not attend in the window.
   *
   * Discriminates repeat non-attenders from first-time non-attenders.
   */
  listNoShowHistory(window: EntityWindow): Promise<readonly NoShowHistoryRow[] | null>;

  /**
   * Planned treatments whose patient has no next visit booked at the end of the
   * window, with age, type, and quoted value.
   *
   * Discriminates a plan recorded today with no next visit yet from a plan that
   * has been sitting long ago, and a backlog concentrated in long or high-value
   * work from one spread across routine work.
   */
  listPendingTreatments(window: EntityWindow): Promise<readonly PendingTreatmentRow[] | null>;

  /**
   * Unpaid balances outstanding at the end of the window, with age and amount.
   *
   * Discriminates a receivable book made of today's uncollected work from one
   * made of long-unpaid balances.
   */
  listOutstandingBalances(
    window: EntityWindow,
  ): Promise<readonly OutstandingBalanceRow[] | null>;

  /**
   * Scheduled versus actual arrival for the window's appointments.
   *
   * Discriminates queueing caused by patients arriving together from queueing
   * caused by exhausted capacity.
   */
  listAppointmentArrivals(
    window: EntityWindow,
  ): Promise<readonly AppointmentArrivalRow[] | null>;

  /**
   * Treatments completed in the window with billed and collected value.
   *
   * Discriminates low revenue caused by a lower-value case mix from low revenue
   * caused by uncollected billing.
   */
  listCompletedTreatments(
    window: EntityWindow,
  ): Promise<readonly CompletedTreatmentRow[] | null>;
}
