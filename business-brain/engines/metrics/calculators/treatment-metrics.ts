/**
 * Metrics Engine — Treatment calculators
 */

import type { Metric } from "../../../domain";
import type { ClinicDataSnapshot } from "../../../repositories";
import { METRIC_WINDOWS } from "../config/metric-windows";
import { localDatePart } from "../../../utils";
import { completedInWindow } from "../support/windows";
import { MetricKey, buildMetric } from "../metric-ids";

/** The clinic-local business date of an ISO timestamp in this snapshot. */
function toDatePart(iso: string, s: ClinicDataSnapshot): string {
  return localDatePart(iso, s.timezone);
}

/**
 * Planned treatments whose patient has no next visit booked.
 *
 * Two things this does NOT measure, despite the metric key saying "accepted":
 *
 *   - Consent. `planned` is a plan the clinic recorded. The schema has no
 *     `presented` or `declined` state, so a plan the patient refused is
 *     indistinguishable from one they agreed to.
 *   - A treatment-to-appointment link. `isScheduled` is resolved at the PATIENT
 *     level — does this patient have any upcoming visit — so a patient booked for
 *     a cleaning reads as booked for their crown too.
 *
 * The key stays as it is because it is persisted in `metric_history`. Every
 * user-facing label for it is worded to the two facts above and must not be
 * re-phrased into the language of acceptance or of a scheduled treatment.
 *
 * Returns `null` — the metric is withheld — when any planned treatment's
 * booking state is unknown (`isScheduled === null`). Counting an unknown as
 * "no next visit" would report work as unbooked on no evidence, and
 * `clinical.accepted_treatments_unscheduled` would fire on it. Withholding the
 * metric instead makes the downstream evaluator skip and record that it could
 * not measure, which is the honest outcome.
 *
 * With no planned treatments at all the answer is 0 regardless of what is
 * knowable, so the metric is still produced.
 */
export function acceptedTreatmentsPendingScheduling(s: ClinicDataSnapshot): Metric | null {
  const planned = s.treatments.filter((t) => t.status === "planned");
  if (planned.some((t) => t.isScheduled === null)) {
    return null;
  }
  const value = planned.filter((t) => t.isScheduled === false).length;
  return buildMetric(
    MetricKey.TREATMENT_ACCEPTED_PENDING_SCHEDULING,
    value,
    s.clinicId,
    s.date,
    s.asOf,
  );
}

/** Treatments completed today — `completed` treatments performed on the target date. */
export function treatmentsCompletedToday(s: ClinicDataSnapshot): Metric {
  const value = s.treatments.filter(
    (t) => t.status === "completed" && t.performedAt !== null && toDatePart(t.performedAt, s) === s.date,
  ).length;
  return buildMetric(MetricKey.TREATMENT_COMPLETED_TODAY, value, s.clinicId, s.date, s.asOf);
}

/**
 * Average value of a case completed in the trailing window.
 *
 * Separates a volume problem from a value problem. Revenue can fall with patient
 * numbers flat because the case mix shifted towards cleanings — a completely
 * different response from "we need more patients". This is the metric the
 * `revenue_shortfall` diagnosis needs to settle its `case_mix` hypothesis, which
 * is otherwise always undetermined.
 *
 * Gross cost, matching {@link production30d}, so the two divide cleanly into a
 * case count.
 *
 * WITHHELD when nothing completed in the window: a mean of no cases is
 * undefined, and reporting 0 would read as "our cases are worthless".
 */
export function averageCaseValue30d(s: ClinicDataSnapshot): Metric | null {
  const completed = completedInWindow(s, METRIC_WINDOWS.TRAILING_DAYS);
  if (completed.length === 0) {
    return null;
  }
  const total = completed.reduce((sum, t) => sum + t.cost, 0);
  const value = Math.round((total / completed.length) * 100) / 100;
  return buildMetric(
    MetricKey.TREATMENT_AVERAGE_CASE_VALUE_30D,
    value,
    s.clinicId,
    s.date,
    s.asOf,
  );
}

