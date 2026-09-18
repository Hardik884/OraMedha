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
 * Each patient's own unpaid balance, clamped at zero.
 *
 * The one place the clamp is expressed, so the clinic total, the payment-plan
 * share and the unpaid-production attribution cannot drift apart. A deleted
 * patient owes nothing the clinic can still collect and is absent entirely.
 *
 * Rows without a patientId (hand-built test snapshots) all fall into one bucket,
 * which reproduces the old clinic-level behaviour.
 */
function outstandingByPatient(s: ClinicDataSnapshot): Map<string, number> {
  const chargedByPatient = new Map<string, number>();
  const paidByPatient = new Map<string, number>();

  for (const t of s.treatments) {
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

  const balances = new Map<string, number>();
  for (const [key, charged] of chargedByPatient) {
    balances.set(key, Math.max(0, charged - (paidByPatient.get(key) ?? 0)));
  }
  return balances;
}

/**
 * Value of the work delivered in the trailing window that has not been paid for.
 *
 * ## How the attribution works, and what it does NOT assume
 *
 * Per patient: the unpaid part of this window's work is their CURRENT balance,
 * capped at what they were charged in the window. Two facts do the work, and
 * neither is invented:
 *
 *   - a balance that survives is the most recent work, because a payment settles
 *     the oldest charge first — the convention every ledger in dentistry runs on;
 *   - it cannot exceed what was charged in the window, so older debt can never
 *     be counted against recent work, which is the exact defect in
 *     {@link collectionRate30d}.
 *
 * No payment is matched to a treatment. OraMedha does not record that link, and
 * this metric does not pretend it does. The oldest-first convention is also the
 * app's own: `lib/billing/payout.ts` allocates a patient's payments across their
 * treatments in exactly that order, and for an aggregate the two agree —
 * everything older is settled first, so what can still be unpaid on the window's
 * work is the surviving balance, capped at what the window charged.
 *
 * ## Deleted patients are excluded, here only
 *
 * Their delivered work still counts toward production (§5.14a) — it happened.
 * But it is deliberately outside this measurement: their balance is not
 * collectable and nothing about its payment can still be acted on, so including
 * it would report a collection gap no one can close.
 */
export function productionUnpaid30d(s: ClinicDataSnapshot): Metric {
  const balances = outstandingByPatient(s);
  const chargedInWindow = new Map<string, number>();
  for (const t of completedInWindow(s, METRIC_WINDOWS.TRAILING_DAYS)) {
    if (t.patientDeleted) continue;
    const key = t.patientId ?? "";
    chargedInWindow.set(key, (chargedInWindow.get(key) ?? 0) + t.cost);
  }

  let value = 0;
  for (const [key, charged] of chargedInWindow) {
    value += Math.min(charged, balances.get(key) ?? 0);
  }
  return buildMetric(
    MetricKey.REVENUE_PRODUCTION_UNPAID_30D,
    Math.round(value * 100) / 100,
    s.clinicId,
    s.date,
    s.asOf,
  );
}

/**
 * Share of the work delivered in the trailing window that has been paid for.
 *
 * The question "collection rate" is always read as, and the one
 * {@link collectionRate30d} does not answer. See
 * {@link MetricKey.REVENUE_PRODUCTION_PAID_RATE_30D}.
 *
 * WITHHELD when the window's collectable production is zero: a share of nothing
 * is undefined, and 0% would read as "none of our work gets paid for" when the
 * truth is "we delivered nothing".
 */
export function productionPaidRate30d(s: ClinicDataSnapshot): Metric | null {
  const balances = outstandingByPatient(s);
  const chargedInWindow = new Map<string, number>();
  for (const t of completedInWindow(s, METRIC_WINDOWS.TRAILING_DAYS)) {
    if (t.patientDeleted) continue;
    const key = t.patientId ?? "";
    chargedInWindow.set(key, (chargedInWindow.get(key) ?? 0) + t.cost);
  }

  let charged = 0;
  let unpaid = 0;
  for (const [key, amount] of chargedInWindow) {
    charged += amount;
    unpaid += Math.min(amount, balances.get(key) ?? 0);
  }
  if (charged <= 0) return null;

  const value = Math.round(((charged - unpaid) / charged) * 1000) / 10;
  return buildMetric(
    MetricKey.REVENUE_PRODUCTION_PAID_RATE_30D,
    value,
    s.clinicId,
    s.date,
    s.asOf,
  );
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
  let value = 0;
  for (const balance of outstandingByPatient(s).values()) value += balance;
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
 * Cash received in the trailing window as a percentage of work delivered in it.
 *
 * ## This is a CASH-FLOW ratio, and not the clinic's collection rate
 *
 * The numerator and the denominator describe different cohorts of work: money
 * arriving this month may be settling a crown fitted in March, while a filling
 * placed yesterday is not in either figure. So it answers "is cash keeping pace
 * with production", which is a real question — and it does NOT answer "how much
 * of what we deliver gets paid for", which is what a reader assumes.
 *
 * The test clinic's normal reading was a median of 115%, because it was steadily
 * clearing old balances. Nothing was wrong with the arithmetic; the name was
 * wrong, and {@link productionPaidRate30d} is the metric it was mistaken for.
 *
 * WITHHELD when production is zero: a ratio against nothing is undefined, and
 * reporting 0% would read as "we collected nothing" when the truth is "we
 * delivered nothing". Not capped at 100% — clearing historic dues genuinely does
 * exceed the window's production, and flattening that would hide it.
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
