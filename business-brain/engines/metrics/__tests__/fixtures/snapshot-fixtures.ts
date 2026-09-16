/**
 * Metrics Engine test fixtures.
 *
 * Builders for ClinicDataSnapshot and its parts. Every builder takes partial
 * overrides so a test states only the field it is about, which keeps the
 * assertions readable and stops unrelated fields from silently mattering.
 *
 * All times are explicit. The engine must never read the clock, so `asOf` is
 * always supplied by the fixture and never defaulted to "now".
 */

import type {
  AppointmentSnapshot,
  PatientRosterEntry,
  ScheduleWindow,
  ClinicDataSnapshot,
  FollowUpSnapshot,
  PatientSnapshot,
  PaymentSnapshot,
  QueueEntrySnapshot,
  TreatmentSnapshot,
  VisitDurationSnapshot,
} from "../../../../repositories";

export const CLINIC = "clinic_test";
export const DATE = "2026-07-28";
/** Midday on DATE — a fixed capture moment for time-based calculations. */
export const AS_OF = "2026-07-28T12:00:00.000Z";

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq}`;
}

export function appointment(over: Partial<AppointmentSnapshot> = {}): AppointmentSnapshot {
  return {
    id: nextId("appt"),
    patientId: nextId("pat"),
    status: "scheduled",
    scheduledAt: `${DATE}T10:00:00.000Z`,
    // Booked the day before by default — a plausible, non-zero lead time.
    createdAt: `2026-07-27T10:00:00.000Z`,
    durationMinutes: 30,
    source: "walk_in",
    ...over,
  };
}

export function patient(over: Partial<PatientSnapshot> = {}): PatientSnapshot {
  return {
    id: nextId("pat"),
    createdAt: `${DATE}T09:00:00.000Z`,
    ...over,
  };
}

export function payment(over: Partial<PaymentSnapshot> = {}): PaymentSnapshot {
  return {
    id: nextId("pay"),
    amount: 1000,
    paymentDate: DATE,
    ...over,
  };
}

export function treatment(over: Partial<TreatmentSnapshot> = {}): TreatmentSnapshot {
  const cost = over.cost ?? 1000;
  return {
    id: nextId("tx"),
    cost,
    status: "completed",
    performedAt: `${DATE}T10:30:00.000Z`,
    isScheduled: false,
    ...over,
  };
}

export function queueEntry(over: Partial<QueueEntrySnapshot> = {}): QueueEntrySnapshot {
  return {
    id: nextId("q"),
    status: "waiting",
    checkedInAt: `${DATE}T11:30:00.000Z`,
    startedAt: null,
    ...over,
  };
}

export function followUp(over: Partial<FollowUpSnapshot> = {}): FollowUpSnapshot {
  return {
    id: nextId("fu"),
    dueDate: DATE,
    status: "pending",
    ...over,
  };
}

export function rosterEntry(over: Partial<PatientRosterEntry> = {}): PatientRosterEntry {
  return {
    id: nextId("pat"),
    createdAt: "2025-01-01T09:00:00.000Z",
    lastVisit: `${DATE}T09:00:00.000Z`,
    hasUpcomingAppointment: false,
    ...over,
  };
}

/**
 * One attended visit with its booked and delivered lengths.
 *
 * Defaults to a visit that ran exactly to time, so a test that cares about
 * overrun states only the overrun and a test that does not is unaffected by it.
 */
export function visitDuration(
  over: Partial<VisitDurationSnapshot> = {},
): VisitDurationSnapshot {
  return {
    appointmentId: nextId("appt"),
    scheduledMinutes: 30,
    actualMinutes: 30,
    ...over,
  };
}

export function scheduleWindow(over: Partial<ScheduleWindow> = {}): ScheduleWindow {
  return {
    from: "2026-06-29",
    to: DATE,
    appointments: [],
    openChairMinutes: 0,
    ...over,
  };
}

/**
 * A snapshot on which EVERY metric is measurable.
 *
 * An empty clinic day is not: a collection rate against zero production and a
 * mean of zero cases are both undefined, and the roster is absent. Used where a
 * test needs all calculators to produce a value.
 */
export function measurableSnapshot(): ClinicDataSnapshot {
  return snapshot({
    // An OPEN day, so chair utilization is a real measurement (0% here) rather
    // than withheld the way a closed day now is.
    capacity: { openMinutesToday: 480, chairCount: 1, typicalAppointmentMinutes: 30 },
    treatments: [treatment({ cost: 1000, status: "completed" })],
    payments: [payment({ amount: 500 })],
    patientRoster: [rosterEntry()],
    trailingWindow: scheduleWindow({ appointments: [appointment()], openChairMinutes: 300 }),
    forwardWindow: scheduleWindow({
      from: "2026-07-29",
      to: "2026-08-04",
      appointments: [appointment({ scheduledAt: "2026-07-30T10:00:00.000Z" })],
      openChairMinutes: 300,
    }),
    // Present (empty) rather than absent, so revenue.outstanding_on_payment_plan
    // is measured — 0, legitimately — instead of withheld on the one snapshot
    // this suite asserts produces every declared key.
    patientsOnPaymentPlan: new Set(),
    // Present, and with a measurable length, so both overrun metrics produce a
    // value on the one snapshot this suite asserts yields every declared key. A
    // punctual visit gives 0% overrun — a real measurement, not a withheld one.
    trailingVisitDurations: [visitDuration()],
    // A called-in patient, so the average wait is a measurement rather than
    // withheld.
    queueToday: [queueEntry({ checkedInAt: `${DATE}T10:00:00.000Z`, startedAt: `${DATE}T10:15:00.000Z` })],
  });
}

/** An empty clinic day — every collection present but empty. */
export function snapshot(over: Partial<ClinicDataSnapshot> = {}): ClinicDataSnapshot {
  return {
    clinicId: CLINIC,
    date: DATE,
    asOf: AS_OF,
    appointmentsToday: [],
    patientsRegisteredToday: [],
    patientsSeenToday: [],
    treatments: [],
    payments: [],
    queueToday: [],
    followUps: [],
    capacity: { openMinutesToday: 0, chairCount: 1, typicalAppointmentMinutes: 30 },
    ...over,
  };
}

/**
 * Run a calculator and return its numeric value.
 *
 * Throws if the calculator withheld the metric (returned null) — a value
 * assertion that silently received `undefined` would pass for the wrong reason.
 * Use {@link isWithheld} to assert withholding explicitly.
 */
export function valueOf(
  calc: (s: ClinicDataSnapshot) => { value: number } | null,
  s: ClinicDataSnapshot,
): number {
  const metric = calc(s);
  if (metric === null) {
    throw new Error("calculator withheld the metric; expected a value");
  }
  return metric.value;
}

/** True when the calculator declined to measure from this snapshot. */
export function isWithheld(
  calc: (s: ClinicDataSnapshot) => unknown | null,
  s: ClinicDataSnapshot,
): boolean {
  return calc(s) === null;
}
