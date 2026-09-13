/**
 * Business Brain — Clinic Ledger graph
 *
 * A pure, indexed view over one `ClinicLedgerSlice` that answers relational
 * questions — "which appointments did this follow-up produce", "what did the
 * queue record for this visit" — with an explicit statement of whether the slice
 * CAN answer them.
 *
 * ## Why every traversal returns a `Traversal`, not a value
 *
 * A slice is bounded. A window read has a patient's appointments inside the
 * window and none outside it; a truncated read has some rows and not others; and
 * some relationships are not recorded anywhere at all. In each case the naive
 * lookup returns an empty array, and an empty array reads as "none" — the
 * patient never came back, the follow-up produced nothing, the treatment was
 * never paid. Every one of those is a claim about the clinic that the data does
 * not support.
 *
 * So the answer carries its epistemic status:
 *
 *   known          the slice was loaded to answer this, completely; `value` is
 *                  the answer, and an empty array really does mean none
 *   outside_slice  the answer may exist but this slice cannot see it — wrong
 *                  scope, truncated read, or a row that is not live
 *   not_recorded   OraMedha has nowhere to hold the answer; names the capability
 *
 * The same discipline the rest of the Business Brain applies to metrics
 * (withheld ≠ zero), signals (skipped ≠ no_signal) and hypotheses
 * (undetermined ≠ rejected), applied to relationships.
 *
 * ## Isolation and liveness are checked, not assumed
 *
 * `buildLedgerGraph` throws on a fact from another clinic, and — in a patient
 * scope — on a patient-bearing fact whose patient is not a live member of the
 * slice. The adapter is responsible for both; the graph refuses to reason over a
 * slice where it failed, because a join across tenants or onto a deleted patient
 * would be silently wrong rather than visibly broken.
 *
 * Pure: no clock, no I/O, no database client.
 */

import type { ClinicLedgerSlice } from "./clinic-ledger-port";
import { LEDGER_CAPABILITIES, type LedgerCapability } from "./ledger-capabilities";
import {
  LedgerFactKind,
  type ActionCompletionFact,
  type AppointmentEventFact,
  type AppointmentFact,
  type FollowUpFact,
  type PatientFact,
  type PaymentFact,
  type QueueVisitFact,
  type ReminderSendFact,
  type TreatmentEventFact,
  type TreatmentFact,
} from "./ledger-facts";

export type Traversal<T> =
  | { readonly status: "known"; readonly value: T }
  | { readonly status: "outside_slice"; readonly reason: string }
  | { readonly status: "not_recorded"; readonly capability: string; readonly reason: string };

/** A slice that violates tenant isolation or liveness. Never reasoned over. */
export class LedgerIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerIntegrityError";
  }
}

export interface ClinicLedgerGraph {
  readonly slice: ClinicLedgerSlice;

  patient(patientId: string): PatientFact | undefined;
  appointment(appointmentId: string): AppointmentFact | undefined;
  treatment(treatmentId: string): TreatmentFact | undefined;
  followUp(followUpId: string): FollowUpFact | undefined;

  // ── patient → everything ────────────────────────────────────────────────
  appointmentsOfPatient(patientId: string): Traversal<readonly AppointmentFact[]>;
  treatmentsOfPatient(patientId: string): Traversal<readonly TreatmentFact[]>;
  queueVisitsOfPatient(patientId: string): Traversal<readonly QueueVisitFact[]>;
  followUpsOfPatient(patientId: string): Traversal<readonly FollowUpFact[]>;
  paymentsOfPatient(patientId: string): Traversal<readonly PaymentFact[]>;
  reminderSendsToPatient(patientId: string): Traversal<readonly ReminderSendFact[]>;
  completionsTargetingPatient(patientId: string): Traversal<readonly ActionCompletionFact[]>;

  // ── appointment → ───────────────────────────────────────────────────────
  patientOfAppointment(appointmentId: string): Traversal<PatientFact>;
  /** `null` inside `known` means the visit was never checked in. */
  queueVisitForAppointment(appointmentId: string): Traversal<QueueVisitFact | null>;
  eventsForAppointment(appointmentId: string): Traversal<readonly AppointmentEventFact[]>;
  treatmentsRecordedAtAppointment(appointmentId: string): Traversal<readonly TreatmentFact[]>;
  /** `null` inside `known` means the appointment was not booked from a follow-up. */
  originFollowUpOfAppointment(appointmentId: string): Traversal<FollowUpFact | null>;

  // ── treatment → ─────────────────────────────────────────────────────────
  recordingAppointmentOfTreatment(treatmentId: string): Traversal<AppointmentFact>;
  paymentsLinkedToTreatment(treatmentId: string): Traversal<readonly PaymentFact[]>;
  followUpsRaisedByTreatment(treatmentId: string): Traversal<readonly FollowUpFact[]>;
  eventsForTreatment(treatmentId: string): Traversal<readonly TreatmentEventFact[]>;
  /** Always `not_recorded`: nothing links planned work to its future visit. */
  bookingForPlannedTreatment(treatmentId: string): Traversal<AppointmentFact | null>;
  /** Always `not_recorded`: treatments are not grouped into plans. */
  planOfTreatment(treatmentId: string): Traversal<string | null>;

  // ── follow-up → ─────────────────────────────────────────────────────────
  appointmentsBookedFromFollowUp(followUpId: string): Traversal<readonly AppointmentFact[]>;
  /** Always `not_recorded`: follow-up status is not versioned. */
  followUpCompletedAt(followUpId: string): Traversal<string | null>;

  // ── reminder → ──────────────────────────────────────────────────────────
  /** Always `not_recorded`: reached / not reached is never captured. */
  contactOutcomeOfReminder(reminderId: string): Traversal<"reached" | "not_reached">;
}

function known<T>(value: T): Traversal<T> {
  return { status: "known", value };
}

function outside<T>(reason: string): Traversal<T> {
  return { status: "outside_slice", reason };
}

function notRecorded<T>(capability: LedgerCapability): Traversal<T> {
  return {
    status: "not_recorded",
    capability: capability.key,
    reason: capability.limitation ?? capability.description,
  };
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    if (k === null) continue;
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

function byId<T extends { readonly id: string }>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

/** Every fact in the slice with a clinic, for the isolation check. */
function everyFact(slice: ClinicLedgerSlice): readonly { clinicId: string; id: string }[] {
  return [
    ...slice.patients,
    ...slice.appointments,
    ...slice.appointmentEvents,
    ...slice.treatments,
    ...slice.treatmentEvents,
    ...slice.queueVisits,
    ...slice.followUps,
    ...slice.payments,
    ...slice.reminderSends,
    ...slice.actionCompletions,
  ];
}

function assertIntegrity(slice: ClinicLedgerSlice): void {
  if (slice.clinicId !== slice.scope.clinicId) {
    throw new LedgerIntegrityError(
      `Slice clinic ${slice.clinicId} does not match its scope clinic ${slice.scope.clinicId}.`,
    );
  }
  for (const fact of everyFact(slice)) {
    if (fact.clinicId !== slice.clinicId) {
      throw new LedgerIntegrityError(
        `Fact ${fact.id} belongs to clinic ${fact.clinicId}, not ${slice.clinicId}. A ledger slice may never span tenants.`,
      );
    }
  }

  const rowsByKind: Record<LedgerFactKind, readonly unknown[]> = {
    patient: slice.patients,
    appointment: slice.appointments,
    appointment_event: slice.appointmentEvents,
    treatment: slice.treatments,
    treatment_event: slice.treatmentEvents,
    queue_visit: slice.queueVisits,
    follow_up: slice.followUps,
    payment: slice.payments,
    reminder_send: slice.reminderSends,
    action_completion: slice.actionCompletions,
  };
  for (const kind of slice.withheld) {
    if (rowsByKind[kind].length > 0) {
      throw new LedgerIntegrityError(`Kind ${kind} is marked withheld but carries rows.`);
    }
  }

  const appointmentIds = new Set(slice.appointments.map((a) => a.id));
  for (const event of slice.appointmentEvents) {
    // appointment_history has no clinic_id of its own; its tenancy is only as
    // good as the appointment it hangs from.
    if (!appointmentIds.has(event.appointmentId)) {
      throw new LedgerIntegrityError(
        `Appointment event ${event.id} references appointment ${event.appointmentId}, which is not in the slice.`,
      );
    }
  }

  if (slice.scope.kind !== "patients") return;
  const live = new Set(slice.patients.map((p) => p.id));
  const bearers: readonly { id: string; patientId: string }[] = [
    ...slice.appointments,
    ...slice.treatments,
    ...slice.treatmentEvents,
    ...slice.queueVisits,
    ...slice.followUps,
    ...slice.payments,
    ...slice.reminderSends,
  ];
  for (const fact of bearers) {
    if (!live.has(fact.patientId)) {
      throw new LedgerIntegrityError(
        `Fact ${fact.id} belongs to patient ${fact.patientId}, who is not a live patient in this slice.`,
      );
    }
  }
}

/**
 * Index a slice for traversal.
 *
 * @throws LedgerIntegrityError when the slice mixes clinics or, in a patient
 *   scope, carries facts for a patient who is not live.
 */
export function buildLedgerGraph(slice: ClinicLedgerSlice): ClinicLedgerGraph {
  assertIntegrity(slice);

  // A withheld kind is at least as unknown as a truncated one: nothing of it was
  // read. Folding both into one set keeps every traversal's check identical.
  const truncated = new Set([...slice.truncated, ...slice.withheld]);
  const withheld = new Set(slice.withheld);
  const cut = (kind: LedgerFactKind, what: string) =>
    withheld.has(kind)
      ? `The ${kind} facts were not read by this session, so ${what} is unknown.`
      : `The ${kind} read hit its row limit, so ${what} may be incomplete.`;
  const patientScope = slice.scope.kind === "patients";

  const patients = byId(slice.patients);
  const appointments = byId(slice.appointments);
  const treatments = byId(slice.treatments);
  const followUps = byId(slice.followUps);
  const reminders = byId(slice.reminderSends);

  const appointmentsByPatient = groupBy(slice.appointments, (a) => a.patientId);
  const treatmentsByPatient = groupBy(slice.treatments, (t) => t.patientId);
  const queueByPatient = groupBy(slice.queueVisits, (q) => q.patientId);
  const followUpsByPatient = groupBy(slice.followUps, (f) => f.patientId);
  const paymentsByPatient = groupBy(slice.payments, (p) => p.patientId);
  const remindersByPatient = groupBy(slice.reminderSends, (r) => r.patientId);

  const completionsByPatient = new Map<string, ActionCompletionFact[]>();
  for (const completion of slice.actionCompletions) {
    for (const patientId of new Set(completion.targetPatientIds)) {
      const list = completionsByPatient.get(patientId);
      if (list) list.push(completion);
      else completionsByPatient.set(patientId, [completion]);
    }
  }

  const queueByAppointment = groupBy(slice.queueVisits, (q) => q.appointmentId);
  const eventsByAppointment = groupBy(slice.appointmentEvents, (e) => e.appointmentId);
  const treatmentsByAppointment = groupBy(slice.treatments, (t) => t.recordedAtAppointmentId);
  const appointmentsByFollowUp = groupBy(slice.appointments, (a) => a.originFollowUpId);

  const paymentsByTreatment = groupBy(slice.payments, (p) => p.treatmentId);
  const followUpsByTreatment = groupBy(slice.followUps, (f) => f.treatmentId);
  const eventsByTreatment = groupBy(slice.treatmentEvents, (e) => e.treatmentId);

  const ordered = <T>(rows: T[] | undefined, key: (row: T) => string): readonly T[] =>
    [...(rows ?? [])].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

  /**
   * Everything hanging from a patient is answerable only from a patient scope —
   * a window holds some of a patient's rows, never all — and only when the kind
   * was read in full.
   */
  const patientChildren = <T>(
    patientId: string,
    kind: LedgerFactKind,
    rows: Map<string, T[]>,
    key: (row: T) => string,
  ): Traversal<readonly T[]> => {
    if (!patientScope) {
      return outside("An appointment-window slice holds only part of a patient's history.");
    }
    if (!patients.has(patientId)) {
      return outside(`Patient ${patientId} is not a live patient in this slice.`);
    }
    if (truncated.has(kind)) {
      return outside(cut(kind, "this patient's list"));
    }
    return known(ordered(rows.get(patientId), key));
  };

  /**
   * Rows hanging from an appointment or treatment the slice holds. Both scopes
   * load these for every parent they contain, so the only reasons to decline are
   * a parent outside the slice and a truncated read.
   */
  const parentChildren = <T>(
    parentPresent: boolean,
    parentLabel: string,
    kind: LedgerFactKind,
    rows: T[] | undefined,
    key: (row: T) => string,
  ): Traversal<readonly T[]> => {
    if (!parentPresent) return outside(`${parentLabel} is not in this slice.`);
    if (truncated.has(kind)) {
      return outside(cut(kind, "this list"));
    }
    return known(ordered(rows, key));
  };

  const lookup = <T>(map: Map<string, T>, id: string, label: string, kind: LedgerFactKind): Traversal<T> => {
    const row = map.get(id);
    if (row !== undefined) return known(row);
    return outside(
      truncated.has(kind)
        ? `${label} ${id} may have been cut by the ${kind} row limit.`
        : `${label} ${id} is not in this slice — outside its scope, or no longer live.`,
    );
  };

  return {
    slice,

    patient: (id) => patients.get(id),
    appointment: (id) => appointments.get(id),
    treatment: (id) => treatments.get(id),
    followUp: (id) => followUps.get(id),

    appointmentsOfPatient: (id) =>
      patientChildren(id, LedgerFactKind.APPOINTMENT, appointmentsByPatient, (a) => a.scheduledAt),
    treatmentsOfPatient: (id) =>
      patientChildren(id, LedgerFactKind.TREATMENT, treatmentsByPatient, (t) => t.recordedAt),
    queueVisitsOfPatient: (id) =>
      patientChildren(id, LedgerFactKind.QUEUE_VISIT, queueByPatient, (q) => q.checkedInAt),
    followUpsOfPatient: (id) =>
      patientChildren(id, LedgerFactKind.FOLLOW_UP, followUpsByPatient, (f) => f.dueDate),
    paymentsOfPatient: (id) =>
      patientChildren(id, LedgerFactKind.PAYMENT, paymentsByPatient, (p) => p.paymentDate),
    reminderSendsToPatient: (id) =>
      patientChildren(id, LedgerFactKind.REMINDER_SEND, remindersByPatient, (r) => r.sentAt),
    completionsTargetingPatient: (id) =>
      patientChildren(id, LedgerFactKind.ACTION_COMPLETION, completionsByPatient, (c) => c.completedAt),

    patientOfAppointment: (appointmentId) => {
      const appointment = appointments.get(appointmentId);
      if (appointment === undefined) return outside(`Appointment ${appointmentId} is not in this slice.`);
      return lookup(patients, appointment.patientId, "Patient", LedgerFactKind.PATIENT);
    },

    queueVisitForAppointment: (appointmentId) => {
      const list = parentChildren(
        appointments.has(appointmentId),
        `Appointment ${appointmentId}`,
        LedgerFactKind.QUEUE_VISIT,
        queueByAppointment.get(appointmentId),
        (q) => q.checkedInAt,
      );
      // First entry wins, matching joinVisitDurations: a patient re-queued on
      // the same appointment is a rare correction, and the choice must be
      // deterministic.
      return list.status === "known" ? known(list.value[0] ?? null) : list;
    },

    eventsForAppointment: (appointmentId) =>
      parentChildren(
        appointments.has(appointmentId),
        `Appointment ${appointmentId}`,
        LedgerFactKind.APPOINTMENT_EVENT,
        eventsByAppointment.get(appointmentId),
        (e) => e.at,
      ),

    treatmentsRecordedAtAppointment: (appointmentId) =>
      parentChildren(
        appointments.has(appointmentId),
        `Appointment ${appointmentId}`,
        LedgerFactKind.TREATMENT,
        treatmentsByAppointment.get(appointmentId),
        (t) => t.recordedAt,
      ),

    originFollowUpOfAppointment: (appointmentId) => {
      const appointment = appointments.get(appointmentId);
      if (appointment === undefined) return outside(`Appointment ${appointmentId} is not in this slice.`);
      if (appointment.originFollowUpId === null) return known(null);
      return lookup(followUps, appointment.originFollowUpId, "Follow-up", LedgerFactKind.FOLLOW_UP);
    },

    recordingAppointmentOfTreatment: (treatmentId) => {
      const treatment = treatments.get(treatmentId);
      if (treatment === undefined) return outside(`Treatment ${treatmentId} is not in this slice.`);
      return lookup(appointments, treatment.recordedAtAppointmentId, "Appointment", LedgerFactKind.APPOINTMENT);
    },

    paymentsLinkedToTreatment: (treatmentId) =>
      parentChildren(
        treatments.has(treatmentId),
        `Treatment ${treatmentId}`,
        LedgerFactKind.PAYMENT,
        paymentsByTreatment.get(treatmentId),
        (p) => p.paymentDate,
      ),

    followUpsRaisedByTreatment: (treatmentId) =>
      parentChildren(
        treatments.has(treatmentId),
        `Treatment ${treatmentId}`,
        LedgerFactKind.FOLLOW_UP,
        followUpsByTreatment.get(treatmentId),
        (f) => f.dueDate,
      ),

    eventsForTreatment: (treatmentId) =>
      parentChildren(
        treatments.has(treatmentId),
        `Treatment ${treatmentId}`,
        LedgerFactKind.TREATMENT_EVENT,
        eventsByTreatment.get(treatmentId),
        (e) => e.at,
      ),

    bookingForPlannedTreatment: () => notRecorded(LEDGER_CAPABILITIES.PLANNED_TREATMENT_BOOKING),
    planOfTreatment: () => notRecorded(LEDGER_CAPABILITIES.TREATMENT_PLAN),

    appointmentsBookedFromFollowUp: (followUpId) => {
      const followUp = followUps.get(followUpId);
      if (followUp === undefined) return outside(`Follow-up ${followUpId} is not in this slice.`);
      // The booked visit can be any date, so only a slice holding the patient's
      // whole appointment history can say it does not exist.
      if (!patientScope) {
        return outside("An appointment-window slice cannot see visits booked outside its window.");
      }
      if (truncated.has(LedgerFactKind.APPOINTMENT)) {
        return outside(cut(LedgerFactKind.APPOINTMENT, "a booked visit"));
      }
      return known(ordered(appointmentsByFollowUp.get(followUpId), (a) => a.scheduledAt));
    },

    followUpCompletedAt: () => notRecorded(LEDGER_CAPABILITIES.FOLLOW_UP_COMPLETION_TIME),

    contactOutcomeOfReminder: (reminderId) =>
      reminders.has(reminderId)
        ? notRecorded(LEDGER_CAPABILITIES.CONTACT_OUTCOME)
        : outside(`Reminder ${reminderId} is not in this slice.`),
  };
}
