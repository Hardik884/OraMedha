/**
 * Literal ledger slices for the pure graph specs.
 *
 * One patient's complete chain, with every relationship the ledger exists to
 * connect:
 *
 *   patient P1
 *     └─ appointment A1 (completed) ── queue visit Q1
 *          ├─ treatment T1 (completed root canal) ── payment PAY1 (linked)
 *          │     └─ follow-up F1 ── appointment A2 (booked FROM F1)
 *          └─ treatment T2 (planned crown — recorded at A1, booked nowhere)
 *     └─ reminder R1, action completion AC1 targeting P1
 *
 *   patient P2
 *     └─ appointment A3 (no-show, never checked in), no payments at all
 */

import type { ClinicLedgerSlice, LedgerScope } from "../clinic-ledger-port";
import type {
  ActionCompletionFact,
  AppointmentEventFact,
  AppointmentFact,
  FollowUpFact,
  PatientFact,
  PaymentFact,
  QueueVisitFact,
  ReminderSendFact,
  TreatmentEventFact,
  TreatmentFact,
} from "../ledger-facts";

export const CLINIC = "clinic_a";
export const OTHER_CLINIC = "clinic_b";
export const AS_OF = "2026-05-12T18:00:00.000Z";

export const P1 = "p1";
export const P2 = "p2";

export const patients: PatientFact[] = [
  { clinicId: CLINIC, id: P1, registeredAt: "2026-01-01T00:00:00.000Z", paymentPlanUntil: null, reachableByPhone: true, communicationsWithdrawn: false },
  { clinicId: CLINIC, id: P2, registeredAt: "2026-02-01T00:00:00.000Z", paymentPlanUntil: "2026-12-31", reachableByPhone: true, communicationsWithdrawn: false },
];

const appointment = (over: Partial<AppointmentFact> & { id: string; patientId: string }): AppointmentFact => ({
  clinicId: CLINIC,
  dentistId: "d1",
  scheduledAt: "2026-05-12T04:00:00.000Z",
  bookedAt: "2026-05-01T04:00:00.000Z",
  durationMinutes: 30,
  status: "completed",
  source: "phone_call",
  originFollowUpId: null,
  ...over,
});

export const appointments: AppointmentFact[] = [
  appointment({ id: "A1", patientId: P1 }),
  appointment({
    id: "A2",
    patientId: P1,
    scheduledAt: "2026-05-26T05:00:00.000Z",
    bookedAt: "2026-05-12T05:00:00.000Z",
    status: "scheduled",
    source: "other",
    originFollowUpId: "F1",
  }),
  appointment({ id: "A3", patientId: P2, scheduledAt: "2026-05-12T06:00:00.000Z", status: "no_show" }),
];

export const appointmentEvents: AppointmentEventFact[] = [
  {
    clinicId: CLINIC,
    id: "E1",
    appointmentId: "A3",
    action: "status_changed",
    at: "2026-05-12T07:00:00.000Z",
    statusAfter: "no_show",
    previousScheduledAt: null,
  },
];

const charge = (quoted: number, billable: boolean) => ({
  treatment: billable ? quoted : 0,
  consultation: 0,
  radiograph: 0,
  total: billable ? quoted : 0,
  quoted,
});

export const treatments: TreatmentFact[] = [
  {
    clinicId: CLINIC,
    id: "T1",
    patientId: P1,
    recordedAtAppointmentId: "A1",
    treatmentType: "Root Canal",
    status: "completed",
    charge: charge(5000, true),
    performedAt: "2026-05-12T04:30:00.000Z",
    recordedAt: "2026-05-12T04:30:00.000Z",
    consultantId: null,
  },
  {
    clinicId: CLINIC,
    id: "T2",
    patientId: P1,
    recordedAtAppointmentId: "A1",
    treatmentType: "Crown",
    status: "planned",
    charge: charge(8000, false),
    performedAt: null,
    recordedAt: "2026-05-12T04:35:00.000Z",
    consultantId: null,
  },
];

export const treatmentEvents: TreatmentEventFact[] = [
  {
    clinicId: CLINIC,
    id: "TE1",
    treatmentId: "T2",
    patientId: P1,
    action: "created",
    at: "2026-05-12T04:35:00.000Z",
    statusAfter: "planned",
  },
];

export const queueVisits: QueueVisitFact[] = [
  {
    clinicId: CLINIC,
    id: "Q1",
    appointmentId: "A1",
    patientId: P1,
    queueDate: "2026-05-12",
    status: "completed",
    checkedInAt: "2026-05-12T03:55:00.000Z",
    calledAt: "2026-05-12T04:05:00.000Z",
    completedAt: "2026-05-12T04:50:00.000Z",
  },
];

export const followUps: FollowUpFact[] = [
  {
    clinicId: CLINIC,
    id: "F1",
    patientId: P1,
    originAppointmentId: "A1",
    treatmentId: "T1",
    dueDate: "2026-05-26",
    status: "pending",
    confirmation: "confirmed",
    followUpType: "review",
    recordedAt: "2026-05-12T05:00:00.000Z",
    lastChangedAt: "2026-05-12T05:00:00.000Z",
  },
];

export const payments: PaymentFact[] = [
  {
    clinicId: CLINIC,
    id: "PAY1",
    patientId: P1,
    appointmentId: "A1",
    treatmentId: "T1",
    amount: 3000,
    paymentDate: "2026-05-12",
    method: "upi",
  },
];

export const reminderSends: ReminderSendFact[] = [
  { clinicId: CLINIC, id: "R1", patientId: P1, kind: "recall_invitation", sentAt: "2026-05-10T05:00:00.000Z" },
];

export const actionCompletions: ActionCompletionFact[] = [
  {
    clinicId: CLINIC,
    id: "AC1",
    category: "retention",
    constraintId: `constraint.retention:${CLINIC}:2026-05-11`,
    completedAt: "2026-05-11T09:00:00.000Z",
    source: "declared",
    // Deliberately duplicated: a target listed twice is still one patient.
    targetPatientIds: [P1, P1],
  },
];

export function patientScope(over: Partial<LedgerScope> = {}): LedgerScope {
  return { kind: "patients", clinicId: CLINIC, patientIds: [P1, P2], asOf: AS_OF, limit: 100, ...over } as LedgerScope;
}

export function windowScope(): LedgerScope {
  return { kind: "appointment_window", clinicId: CLINIC, from: "2026-05-12", to: "2026-05-12", asOf: AS_OF, limit: 100 };
}

/** The complete two-patient slice, optionally with any part replaced. */
export function slice(over: Partial<ClinicLedgerSlice> = {}): ClinicLedgerSlice {
  return {
    clinicId: CLINIC,
    scope: patientScope(),
    patients,
    appointments,
    appointmentEvents,
    treatments,
    treatmentEvents,
    queueVisits,
    followUps,
    payments,
    reminderSends,
    actionCompletions,
    truncated: [],
    withheld: [],
    unresolvedPatientIds: [],
    ...over,
  };
}
