/**
 * Literal ledgers for the Opportunity Engine specs.
 *
 * Monday 2026-09-14, in a UTC clinic so every instant reads as written. The clinic
 * opens 09:00–13:00 on weekdays with one chair and 30-minute typical appointments,
 * so an empty weekday holds exactly 8 appointment-length gaps and a Monday-to-
 * Monday window (tomorrow … +7) holds 5 weekdays = 40.
 */

import { buildLedgerGraph } from "../../../ledger";
import type {
  AppointmentFact,
  CapacityDayFact,
  CapacityWindowFact,
  ClinicLedgerGraph,
  ClinicLedgerSlice,
  FollowUpFact,
  PatientFact,
  PaymentFact,
  TreatmentFact,
} from "../../../ledger";
import { addDays } from "../../../utils";

export const CLINIC = "clinic_a";
export const DATE = "2026-09-14";
export const NOW = "2026-09-14T08:00:00.000Z";

export function capacity(over: Partial<CapacityWindowFact> = {}, open = (date: string) => isWeekday(date)): CapacityWindowFact {
  const days: CapacityDayFact[] = Array.from({ length: 8 }, (_, i) => {
    const date = addDays(DATE, i);
    return {
      date,
      startsAt: `${date}T00:00:00.000Z`,
      endsAt: `${date}T23:59:59.999Z`,
      openSpans: open(date) ? [{ start: `${date}T09:00:00.000Z`, end: `${date}T13:00:00.000Z` }] : [],
      openMinutesPerChair: open(date) ? 240 : 0,
    };
  });
  return {
    clinicId: CLINIC,
    from: DATE,
    to: addDays(DATE, 7),
    timezone: "UTC",
    chairCount: 1,
    typicalAppointmentMinutes: 30,
    availabilityConfigured: true,
    days,
    ...over,
  };
}

function isWeekday(date: string): boolean {
  const dow = new Date(`${date}T12:00:00.000Z`).getUTCDay();
  return dow >= 1 && dow <= 5;
}

export function appointment(over: Partial<AppointmentFact> & { id: string }): AppointmentFact {
  return {
    clinicId: CLINIC,
    patientId: "p_other",
    dentistId: "d1",
    scheduledAt: `${addDays(DATE, 1)}T09:00:00.000Z`,
    bookedAt: "2026-09-01T00:00:00.000Z",
    durationMinutes: 30,
    status: "scheduled",
    source: "phone_call",
    originFollowUpId: null,
    ...over,
  };
}

export function patient(id: string, over: Partial<PatientFact> = {}): PatientFact {
  return {
    clinicId: CLINIC,
    id,
    registeredAt: "2026-01-01T00:00:00.000Z",
    paymentPlanUntil: null,
    reachableByPhone: true,
    communicationsWithdrawn: false,
    ...over,
  };
}

export function treatment(over: Partial<TreatmentFact> & { id: string; patientId: string }): TreatmentFact {
  const status = over.status ?? "planned";
  const quoted = over.charge?.quoted ?? 10_000;
  const billable = status === "completed" || status === "in_progress";
  return {
    clinicId: CLINIC,
    recordedAtAppointmentId: "a_consult",
    treatmentType: "Crown",
    status,
    charge: { treatment: billable ? quoted : 0, consultation: 0, radiograph: 0, total: billable ? quoted : 0, quoted },
    performedAt: billable ? "2026-09-01T10:00:00.000Z" : null,
    recordedAt: "2026-09-01T10:00:00.000Z",
    consultantId: null,
    ...over,
  };
}

export function followUp(over: Partial<FollowUpFact> & { id: string; patientId: string }): FollowUpFact {
  return {
    clinicId: CLINIC,
    originAppointmentId: null,
    treatmentId: null,
    dueDate: "2026-09-01",
    status: "pending",
    confirmation: "tentative",
    followUpType: "recall",
    recordedAt: "2026-08-01T00:00:00.000Z",
    lastChangedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

export function payment(over: Partial<PaymentFact> & { id: string; patientId: string }): PaymentFact {
  return {
    clinicId: CLINIC,
    appointmentId: null,
    treatmentId: null,
    amount: 1000,
    paymentDate: "2026-09-02",
    method: "upi",
    ...over,
  };
}

function emptySlice(): Omit<ClinicLedgerSlice, "scope"> {
  return {
    clinicId: CLINIC,
    patients: [],
    appointments: [],
    appointmentEvents: [],
    treatments: [],
    treatmentEvents: [],
    queueVisits: [],
    followUps: [],
    payments: [],
    reminderSends: [],
    actionCompletions: [],
    truncated: [],
    withheld: [],
    unresolvedPatientIds: [],
  };
}

/** The forward appointment book, as the service reads it: today … +7. */
export function schedule(appointments: readonly AppointmentFact[], over: Partial<ClinicLedgerSlice> = {}): ClinicLedgerGraph {
  return buildLedgerGraph({
    ...emptySlice(),
    scope: { kind: "appointment_window", clinicId: CLINIC, from: DATE, to: addDays(DATE, 7), asOf: NOW, limit: 2000 },
    appointments,
    ...over,
  });
}

/** Patients with open work, loaded whole. */
export function openWork(over: Partial<ClinicLedgerSlice> = {}): ClinicLedgerGraph {
  const patients = over.patients ?? [];
  return buildLedgerGraph({
    ...emptySlice(),
    scope: { kind: "patients", clinicId: CLINIC, patientIds: patients.map((p) => p.id), asOf: NOW, limit: 5000 },
    ...over,
  });
}
