/**
 * Metrics Engine — Patient calculators
 */

import type { Metric } from "../../../domain";
import type { ClinicDataSnapshot } from "../../../repositories";
import { addDays, localDatePart } from "../../../utils";
import { METRIC_WINDOWS } from "../config/metric-windows";
import { MetricKey, buildMetric } from "../metric-ids";

/** The clinic-local business date of an ISO timestamp in this snapshot. */
function toDatePart(iso: string, s: ClinicDataSnapshot): string {
  return localDatePart(iso, s.timezone);
}

/** New patients today — records created on the target date. */
export function newPatientsToday(s: ClinicDataSnapshot): Metric {
  return buildMetric(
    MetricKey.PATIENTS_NEW_TODAY,
    s.patientsRegisteredToday.length,
    s.clinicId,
    s.date,
    s.asOf,
  );
}

/**
 * Returning patients today — distinct patients seen today whose record was
 * created before today. Patients registered today are treated as new, not
 * returning.
 */
export function returningPatientsToday(s: ClinicDataSnapshot): Metric {
  const seen = new Set<string>();
  for (const p of s.patientsSeenToday) {
    if (toDatePart(p.createdAt, s) < s.date) {
      seen.add(p.id);
    }
  }
  return buildMetric(MetricKey.PATIENTS_RETURNING_TODAY, seen.size, s.clinicId, s.date, s.asOf);
}

/**
 * Patients due for reactivation — on the roster, last seen longer ago than the
 * recall interval, and with no upcoming appointment booked.
 *
 * This is the most directly actionable metric the engine produces: it is not a
 * number, it is a call list. Reactivation is the cheapest revenue in dentistry
 * because these patients already chose the clinic once. Most practices have
 * hundreds and have never counted them.
 *
 * A patient who has never attended (`lastVisit === null`) is deliberately
 * EXCLUDED. They are an acquisition problem, not a lapsed one, and mixing the
 * two would make the list unusable for its purpose.
 *
 * WITHHELD when the snapshot carries no roster: the repository could not supply
 * the data, which is different from a clinic having nobody to reactivate.
 *
 * The interval is PER CLINIC where the snapshot supplies one. Recall frequency
 * is a clinical judgement, not a property of the software: an orthodontic list
 * reviews every 6-8 weeks and an implant-led one runs far longer, and judging
 * both against a single six-month constant puts patients on the call list months
 * early or — silently, which is worse — leaves them off it long after they
 * lapsed. `METRIC_WINDOWS.REACTIVATION_DAYS` remains the fallback, so a clinic
 * that has never set one behaves exactly as before.
 */
export function reactivationCandidates(s: ClinicDataSnapshot): Metric | null {
  const roster = s.patientRoster;
  if (roster === undefined) {
    return null;
  }
  const cutoff = addDays(s.date, -(s.recallIntervalDays ?? METRIC_WINDOWS.REACTIVATION_DAYS));
  const value = roster.filter(
    (p) =>
      p.lastVisit !== null &&
      toDatePart(p.lastVisit, s) < cutoff &&
      !p.hasUpcomingAppointment,
  ).length;
  return buildMetric(
    MetricKey.PATIENTS_REACTIVATION_CANDIDATES,
    value,
    s.clinicId,
    s.date,
    s.asOf,
  );
}
