/**
 * Literal ledgers for the Root-Cause Engine specs.
 *
 * Today is Monday 2026-09-14 in a UTC clinic, so every instant reads as written.
 * The trailing window is 2026-08-16 … 2026-09-14; the four full weeks before
 * today (17 Aug … 11 Sep) hold 20 weekdays, four of each.
 */

import { ConstraintCategory } from "../../../domain";
import { buildLedgerGraph } from "../../../ledger";
import type {
  AppointmentFact,
  CapacityDayFact,
  CapacityWindowFact,
  ClinicLedgerGraph,
  ClinicLedgerSlice,
  QueueVisitFact,
  TreatmentFact,
} from "../../../ledger";
import { addDays } from "../../../utils";
import { deriveRootCauses, type RootCauseInput, type RootCauseSubject } from "../root-cause-engine";

export const CLINIC = "clinic_a";
export const OTHER = "clinic_b";
export const DATE = "2026-09-14";
export const NOW = "2026-09-14T23:00:00.000Z";
export const FROM = addDays(DATE, -29);

const MINUTE = 60_000;

export function dayOfWeek(date: string): number {
  return new Date(`${date}T12:00:00.000Z`).getUTCDay();
}

/** Weekdays from 17 Aug to 11 Sep: 20 dates, four of each weekday. */
export function weekdays(from = "2026-08-17", to = "2026-09-11"): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const dow = dayOfWeek(d);
    if (dow >= 1 && dow <= 5) out.push(d);
  }
  return out;
}

export function at(date: string, time: string, offsetMinutes = 0): string {
  return new Date(Date.parse(`${date}T${time}:00.000Z`) + offsetMinutes * MINUTE).toISOString();
}

export function appt(
  id: string,
  date: string,
  time: string,
  status: AppointmentFact["status"] = "completed",
  over: Partial<AppointmentFact> = {},
): AppointmentFact {
  const scheduledAt = at(date, time);
  return {
    clinicId: CLINIC,
    id,
    patientId: `p_${id}`,
    dentistId: "d1",
    scheduledAt,
    // Three days ahead unless a spec says otherwise.
    bookedAt: new Date(Date.parse(scheduledAt) - 3 * 24 * 60 * MINUTE).toISOString(),
    durationMinutes: 30,
    status,
    source: "phone_call",
    originFollowUpId: null,
    ...over,
  };
}

export function visit(
  a: AppointmentFact,
  timing: { arriveOffset?: number; wait?: number; minutesInChair?: number | null; called?: boolean },
): QueueVisitFact {
  const checkedInAt = new Date(Date.parse(a.scheduledAt) + (timing.arriveOffset ?? 0) * MINUTE).toISOString();
  const calledAt = timing.called === false ? null : new Date(Date.parse(checkedInAt) + (timing.wait ?? 0) * MINUTE).toISOString();
  const completedAt =
    calledAt === null || timing.minutesInChair === null || timing.minutesInChair === undefined
      ? null
      : new Date(Date.parse(calledAt) + timing.minutesInChair * MINUTE).toISOString();
  return {
    clinicId: a.clinicId,
    id: `q_${a.id}`,
    appointmentId: a.id,
    patientId: a.patientId,
    queueDate: a.scheduledAt.slice(0, 10),
    status: completedAt === null ? "waiting" : "completed",
    checkedInAt,
    calledAt,
    completedAt,
  };
}

export function treatmentAt(a: AppointmentFact, treatmentType: string, n = 0): TreatmentFact {
  return {
    clinicId: a.clinicId,
    id: `t_${a.id}_${n}`,
    patientId: a.patientId,
    recordedAtAppointmentId: a.id,
    treatmentType,
    status: "completed",
    charge: { treatment: 1000, consultation: 0, radiograph: 0, total: 1000, quoted: 1000 },
    performedAt: a.scheduledAt,
    recordedAt: a.scheduledAt,
    consultantId: null,
  };
}

export function book(over: Partial<ClinicLedgerSlice> = {}): ClinicLedgerGraph {
  return buildLedgerGraph({
    clinicId: CLINIC,
    scope: { kind: "appointment_window", clinicId: CLINIC, from: FROM, to: DATE, asOf: NOW, limit: 5000 },
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
    ...over,
  });
}

/** Every date of the window, weekdays open 09:00–12:00 on one chair. */
export function capacityWindow(open: (date: string) => boolean = (d) => dayOfWeek(d) >= 1 && dayOfWeek(d) <= 5): CapacityWindowFact {
  const days: CapacityDayFact[] = [];
  for (let date = FROM; date <= DATE; date = addDays(date, 1)) {
    const isOpen = open(date);
    days.push({
      date,
      startsAt: `${date}T00:00:00.000Z`,
      endsAt: `${date}T23:59:59.999Z`,
      openSpans: isOpen ? [{ start: `${date}T09:00:00.000Z`, end: `${date}T12:00:00.000Z` }] : [],
      openMinutesPerChair: isOpen ? 180 : 0,
    });
  }
  return {
    clinicId: CLINIC,
    from: FROM,
    to: DATE,
    timezone: "UTC",
    chairCount: 1,
    typicalAppointmentMinutes: 30,
    availabilityConfigured: true,
    days,
  };
}

export const PARENT = {
  [ConstraintCategory.SCHEDULING]: `finding.problem:constraint.scheduling:${CLINIC}:${DATE}`,
  [ConstraintCategory.SCHEDULE_ACCURACY]: `finding.operational_risk:constraint.schedule_accuracy:${CLINIC}:${DATE}`,
  [ConstraintCategory.PATIENT_FLOW]: `finding.operational_risk:constraint.patient_flow:${CLINIC}:${DATE}`,
  [ConstraintCategory.CAPACITY]: `finding.problem:constraint.capacity:${CLINIC}:${DATE}`,
} as const;

export function subject(
  category: keyof typeof PARENT,
  focus: RootCauseSubject["focus"] = "lost",
): RootCauseSubject {
  return { parentFindingId: PARENT[category], category, focus };
}

export function explain(over: Partial<RootCauseInput> & { subjects: RootCauseSubject[] }) {
  return deriveRootCauses({
    clinicId: CLINIC,
    date: DATE,
    now: NOW,
    timezone: "UTC",
    schedule: book(),
    capacity: null,
    ...over,
  });
}

export function one(over: Partial<RootCauseInput> & { subjects: RootCauseSubject[] }) {
  const [analysis] = explain(over);
  return analysis;
}

/** Every sentence an analysis can show a reader. */
export function allText(analysis: ReturnType<typeof one>): string[] {
  return [
    analysis.statement,
    ...analysis.limitations,
    ...analysis.dimensions.map((d) => d.reason),
    ...analysis.associations.flatMap((a) => [a.statement, ...a.evidence]),
  ];
}
