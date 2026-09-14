/**
 * Metrics Engine — Revenue calculators
 *
 * Factual money figures only. No leakage detection, no recommendations.
 */

import type { Metric } from "../../../domain";
import type { ClinicDataSnapshot } from "../../../repositories";
import { METRIC_WINDOWS } from "../config/metric-windows";
import { completedInWindow, paymentsInWindow } from "../support/windows";
import { MetricKey, buildMetric } from "../metric-ids";

/** Revenue collected today — sum of payments recorded on the target date. */
export function revenueCollectedToday(s: ClinicDataSnapshot): Metric {
  const value = s.payments
    .filter((p) => p.paymentDate === s.date)
    .reduce((sum, p) => sum + p.amount, 0);
  return buildMetric(MetricKey.REVENUE_COLLECTED_TODAY, value, s.clinicId, s.date, s.asOf);
}

/**
 * Treatment statuses that count towards money a patient actually owes.
 *
 * This deliberately mirrors `BILLABLE_TREATMENT_STATUSES` in
 * `lib/billing/balance.ts`, which is the application's single source of truth
 * for outstanding balance. The two are stated separately rather than imported
 * because the Business Brain must not depend on application code — but they
 * describe one business rule and must not diverge. `revenue.spec.ts` asserts
 * this exact set so a change here is always deliberate.
 *
 * `planned` is excluded on purpose: work that has been planned but not started
 * is not yet owed. That value is reported separately by
 * {@link pendingTreatmentValue}; counting it here would double-count it across
 * two metrics and make `revenue.high_outstanding` fire on unbilled work.
 */
export const BILLABLE_TREATMENT_STATUSES: readonly string[] = ["completed", "in_progress"];

/**
 * Everything one treatment adds to a patient's dues: its cost when billable, plus
 * any consultation (OPD) and radiograph (X-ray) charge recorded against it. OPD
 * and X-ray are owed whenever they happened, independent of the treatment's own
 * status — the patient was seen / filmed either way.
 *
 * This mirrors `treatmentTotalCharge` in `lib/billing/balance.ts` exactly. It is
 * replicated rather than imported to keep the Business Brain module free of app
 * imports (the same reason `BILLABLE_TREATMENT_STATUSES` is duplicated above);
 * `revenue.spec.ts` pins the two to the same numbers so they cannot drift.
 */
function treatmentTotalCharge(t: {
  cost: number;
  status: string;
  opdCharged?: boolean;
  opdFee?: number;
  xrayTaken?: boolean;
  xrayCost?: number;
}): number {
  const treatmentCost = BILLABLE_TREATMENT_STATUSES.includes(t.status) ? t.cost : 0;
  const opd = t.opdCharged ? Math.max(0, t.opdFee ?? 0) : 0;
  const xray = t.xrayTaken ? Math.max(0, t.xrayCost ?? 0) : 0;
  return treatmentCost + opd + xray;
}

/**
 * Outstanding payments — money the clinic is still owed for delivered work.
 *
 * Charge per treatment = billable cost + OPD fee + X-ray cost (see
 * `treatmentTotalCharge`), matching the canonical `lib/billing/balance.ts` so the
 * metric reconciles with every screen's balance.
 *
 * Clamped PER PATIENT: the clinic total is the sum of each patient's own
 * `max(0, their charges − their payments)`. This fixes a real under-report — a
 * single clinic-level `max(0, Σcharged − Σpaid)` let a deposit on one patient's
 * PLANNED (non-billable) work, or one patient's overpayment, silently cancel
 * another patient's genuine debt.
 *
 * Rows without a patientId (hand-built test snapshots) all fall into one bucket,
 * which reproduces the old clinic-level behaviour — so the change is a no-op for
 * single-patient fixtures and only differs once real per-patient data is present.
 */
export function outstandingPayments(s: ClinicDataSnapshot): Metric {
  const chargedByPatient = new Map<string, number>();
  const paidByPatient = new Map<string, number>();

  for (const t of s.treatments) {
    // A deleted patient owes nothing the clinic can still collect.
    if (t.patientDeleted) continue;
    const charge = treatmentTotalCharge(t);
    if (charge === 0) continue;
    const key = t.patientId ?? "";
    chargedByPatient.set(key, (chargedByPatient.get(key) ?? 0) + charge);
  }
  for (const p of s.payments) {
    if (p.patientDeleted) continue;
    const key = p.patientId ?? "";
    paidByPatient.set(key, (paidByPatient.get(key) ?? 0) + p.amount);
  }

  let value = 0;
  for (const [key, charged] of chargedByPatient) {
    value += Math.max(0, charged - (paidByPatient.get(key) ?? 0));
  }
  return buildMetric(MetricKey.REVENUE_OUTSTANDING, value, s.clinicId, s.date, s.asOf);
}

/**
 * Pending treatment value — total cost of treatments that are planned but not
 * yet completed (`planned` or `in_progress`). Represents recorded-but-unrealised
 * clinical revenue.
 */
export function pendingTreatmentValue(s: ClinicDataSnapshot): Metric {
  const value = s.treatments
    .filter((t) => !t.patientDeleted && (t.status === "planned" || t.status === "in_progress"))
    .reduce((sum, t) => sum + t.cost, 0);
  return buildMetric(MetricKey.REVENUE_PENDING_TREATMENT_VALUE, value, s.clinicId, s.date, s.asOf);
}


/**
 * Production over the trailing window — the gross value of treatment actually
 * DELIVERED, by the date it was performed.
 *
 * Production and collection are dentistry's fundamental pair, and reporting only
 * one of them hides the most common failure mode: a clinic that is busy and
 * delivering well but not getting paid looks identical to one with no demand.
 * Gross, not clinic share — this measures work done, not what was retained.
 */
export function production30d(s: ClinicDataSnapshot): Metric {
  const value = completedInWindow(s, METRIC_WINDOWS.TRAILING_DAYS).reduce(
    (sum, t) => sum + t.cost,
    0,
  );
  return buildMetric(MetricKey.REVENUE_PRODUCTION_30D, value, s.clinicId, s.date, s.asOf);
}

/**
 * Collection rate over the trailing window — cash received as a percentage of
 * work delivered.
 *
 * Near 100% means the clinic converts delivered work into money. A persistent
 * gap is a collections process problem, not a demand problem, and this is the
 * metric that separates the two.
 *
 * WITHHELD when production is zero: a ratio against nothing is undefined, and
 * reporting 0% would read as "we collected nothing" when the truth is "we
 * delivered nothing". Not capped at 100% — collecting historic dues genuinely
 * can exceed the window's production, and flattening that would hide it.
 */
export function collectionRate30d(s: ClinicDataSnapshot): Metric | null {
  const days = METRIC_WINDOWS.TRAILING_DAYS;
  const produced = completedInWindow(s, days).reduce((sum, t) => sum + t.cost, 0);
  if (produced <= 0) {
    return null;
  }
  const collected = paymentsInWindow(s, days).reduce((sum, p) => sum + p.amount, 0);
  const value = Math.round((collected / produced) * 1000) / 10;
  return buildMetric(MetricKey.REVENUE_COLLECTION_RATE_30D, value, s.clinicId, s.date, s.asOf);
}

/**
 * Cash collected over the trailing window.
 *
 * The numerator inside {@link collectionRate30d}, published separately because
 * a clinic owner reads it directly as "what I took in this month", and because
 * it is the correct yardstick for sizing a daily-revenue threshold: today's cash
 * should be judged against this clinic's own typical daily cash, not a constant.
 */
export function collected30d(s: ClinicDataSnapshot): Metric {
  const value = paymentsInWindow(s, METRIC_WINDOWS.TRAILING_DAYS).reduce(
    (sum, p) => sum + p.amount,
    0,
  );
  return buildMetric(MetricKey.REVENUE_COLLECTED_30D, value, s.clinicId, s.date, s.asOf);
}

/**
 * Portion of the outstanding total covered by an agreed payment plan.
 *
 * Sums each payment-plan patient's own clamped outstanding balance (charges
 * minus payments, floored at zero — the same per-patient clamp
 * {@link outstandingPayments} uses), never a flat share of the clinic total. A
 * flat share would misrepresent a patient whose plan covers a small balance as
 * if it covered a proportional slice of everyone else's debt too.
 *
 * WITHHELD, never zero, when the snapshot carries no `patientsOnPaymentPlan` —
 * that means no repository support, not "nobody is on a plan". An empty (but
 * present) set legitimately returns 0.
 */
export function outstandingOnPaymentPlan(s: ClinicDataSnapshot): Metric | null {
  const onPlan = s.patientsOnPaymentPlan;
  if (onPlan === undefined) return null;

  const chargedByPatient = new Map<string, number>();
  const paidByPatient = new Map<string, number>();

  for (const t of s.treatments) {
    if (!t.patientId || !onPlan.has(t.patientId)) continue;
    const charge = treatmentTotalCharge(t);
    if (charge === 0) continue;
    chargedByPatient.set(t.patientId, (chargedByPatient.get(t.patientId) ?? 0) + charge);
  }
  for (const p of s.payments) {
    if (!p.patientId || !onPlan.has(p.patientId)) continue;
    paidByPatient.set(p.patientId, (paidByPatient.get(p.patientId) ?? 0) + p.amount);
  }

  let value = 0;
  for (const [patientId, charged] of chargedByPatient) {
    value += Math.max(0, charged - (paidByPatient.get(patientId) ?? 0));
  }
  return buildMetric(
    MetricKey.REVENUE_OUTSTANDING_ON_PAYMENT_PLAN,
    value,
    s.clinicId,
    s.date,
    s.asOf,
  );
}
