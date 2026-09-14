/**
 * Metrics Engine — Queue calculators
 */

import type { Metric } from "../../../domain";
import type { ClinicDataSnapshot, QueueEntrySnapshot } from "../../../repositories";
import { MetricKey, buildMetric } from "../metric-ids";

/** Appointment statuses under which a queue entry can no longer be a patient waiting. */
const APPOINTMENT_MOVED_ON = new Set(["in_progress", "completed", "cancelled", "no_show"]);

/**
 * Whether an entry is a patient actually waiting: checked in, not called in, and
 * their appointment not already started or closed.
 */
function isWaiting(entry: QueueEntrySnapshot): boolean {
  return (
    entry.status === "waiting" &&
    entry.startedAt === null &&
    (entry.appointmentStatus === undefined || !APPOINTMENT_MOVED_ON.has(entry.appointmentStatus))
  );
}

/** Whether the snapshot describes the present, so a still-open wait can be measured up to `asOf`. */
function describesPresent(s: ClinicDataSnapshot): boolean {
  return s.knowledge === undefined || s.knowledge.reason === "describes_present";
}

/** Patients currently waiting: checked in, not called in, appointment not moved on. */
export function patientsWaiting(s: ClinicDataSnapshot): Metric {
  const value = s.queueToday.filter(isWaiting).length;
  return buildMetric(MetricKey.QUEUE_PATIENTS_WAITING, value, s.clinicId, s.date, s.asOf);
}

/**
 * Minutes one patient waited, or null when the wait was not measured.
 *
 *   called in                     check-in → call-in
 *   still waiting, right now      check-in → `asOf`
 *   anything else                 unmeasured: a visit completed or closed with no
 *                                 call-in recorded, or a wait still open on a day
 *                                 that has ended. Treating those as waiting until
 *                                 `asOf` reported a patient seen at 10:00 as having
 *                                 waited all day.
 */
function waitMinutes(entry: QueueEntrySnapshot, s: ClinicDataSnapshot): number | null {
  const start = Date.parse(entry.checkedInAt);
  let endIso: string;
  if (entry.startedAt !== null) {
    endIso = entry.startedAt;
  } else if (isWaiting(entry) && describesPresent(s)) {
    endIso = s.asOf;
  } else {
    return null;
  }
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return null;
  }
  return (end - start) / 60_000;
}

/**
 * Average waiting time (minutes) across today's measured waits. Withheld — never
 * zero — when no wait could be measured: an empty or unmeasurable queue says
 * nothing about how long patients wait.
 */
export function averageWaitingTime(s: ClinicDataSnapshot): Metric | null {
  const waits: number[] = [];
  for (const entry of s.queueToday) {
    const minutes = waitMinutes(entry, s);
    if (minutes !== null) {
      waits.push(minutes);
    }
  }
  if (waits.length === 0) return null;
  const average = waits.reduce((sum, m) => sum + m, 0) / waits.length;
  // Round to one decimal place for a clean, stable figure.
  const value = Math.round(average * 10) / 10;
  return buildMetric(MetricKey.QUEUE_AVERAGE_WAITING_TIME, value, s.clinicId, s.date, s.asOf);
}
