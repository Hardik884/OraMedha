/**
 * Business Brain — Opportunity Engine: recorded demand
 *
 * Demand is never inferred. A patient counts only through a fact on their own
 * ledger:
 *
 *   planned_treatment  a live treatment in status `planned`
 *   overdue_recall     a pending follow-up whose due date has passed
 *
 * and only while nothing is booked for them — a patient with an upcoming visit is
 * already on the schedule, and offering them a second slot would be filling a
 * gap with a double booking.
 *
 * ## Waiting is not the same as reachable
 *
 * Two recorded facts decide whether outreach can be prepared at all: a usable
 * phone number, and communications consent not withdrawn. A patient failing
 * either still has demand — their treatment is still needed — but no outreach is
 * prepared for them, so they are counted separately and never listed as an
 * affected entity. That is the same rule the reminder send list applies.
 *
 * ## Unanswerable is excluded, and says so
 *
 * A patient whose appointments, treatments or follow-ups the slice cannot answer
 * (a truncated read) is left OUT of every count, and the result is marked a lower
 * bound. Counting them would require assuming they have nothing booked.
 */

import type { ClinicLedgerGraph } from "../../ledger";
import { LedgerFactKind } from "../../ledger";
import { daysBetween, localDatePart } from "../../utils";

export type DemandPool = "planned_treatment" | "overdue_recall";

export interface WaitingPatient {
  readonly patientId: string;
  readonly pools: readonly DemandPool[];
  readonly plannedTreatments: number;
  /** Sum of recorded quoted cost of the planned treatments. Not owed, not accepted. */
  readonly plannedValue: number;
  /** Days since the oldest planned treatment was recorded, or null. */
  readonly oldestPlanAgeDays: number | null;
  /** Days past due of the most overdue pending follow-up, or null. */
  readonly mostDaysOverdue: number | null;
  readonly contactable: boolean;
}

export interface DemandPopulation {
  /** Waiting patients who can be contacted. The only ones any action is prepared for. */
  readonly contactable: readonly WaitingPatient[];
  /** Waiting, but with no usable number on record. */
  readonly withoutUsableNumber: number;
  /** Waiting, but communications consent withdrawn. */
  readonly consentWithdrawn: number;
  /** Patients the slice could not answer for, left out of every count. */
  readonly unanswerable: number;
  /** True when the population is at least what is counted, not exactly it. */
  readonly lowerBound: boolean;
}

const BOOKED = new Set(["scheduled", "checked_in", "in_progress"]);

/**
 * Waiting, contactable demand from an open-work slice, as of `now` on `date`.
 *
 * Sorted by patient id: a stable order that means nothing, which is the point.
 */
export function waitingDemand(graph: ClinicLedgerGraph, date: string, now: string, timezone?: string): DemandPopulation {
  const nowMs = Date.parse(now);
  const contactable: WaitingPatient[] = [];
  let withoutUsableNumber = 0;
  let consentWithdrawn = 0;
  let unanswerable = 0;

  for (const patient of [...graph.slice.patients].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const appointments = graph.appointmentsOfPatient(patient.id);
    const treatments = graph.treatmentsOfPatient(patient.id);
    const followUps = graph.followUpsOfPatient(patient.id);
    if (appointments.status !== "known" || treatments.status !== "known" || followUps.status !== "known") {
      unanswerable += 1;
      continue;
    }

    const booked = appointments.value.some((a) => BOOKED.has(a.status) && Date.parse(a.scheduledAt) > nowMs);
    if (booked) continue;

    const planned = treatments.value.filter((t) => t.status === "planned");
    const overdue = followUps.value.filter((f) => f.status === "pending" && f.dueDate < date);
    const pools: DemandPool[] = [];
    if (planned.length > 0) pools.push("planned_treatment");
    if (overdue.length > 0) pools.push("overdue_recall");
    if (pools.length === 0) continue;

    if (patient.communicationsWithdrawn) {
      consentWithdrawn += 1;
      continue;
    }
    if (!patient.reachableByPhone) {
      withoutUsableNumber += 1;
      continue;
    }

    // Ages on the clinic calendar: a plan recorded at 00:30 local belongs to that day.
    const oldestPlan = planned.map((t) => localDatePart(t.recordedAt, timezone)).sort()[0];
    const earliestDue = overdue.map((f) => f.dueDate).sort()[0];
    contactable.push({
      patientId: patient.id,
      pools,
      plannedTreatments: planned.length,
      plannedValue: planned.reduce((sum, t) => sum + t.charge.quoted, 0),
      oldestPlanAgeDays: oldestPlan === undefined ? null : Math.max(0, daysBetween(oldestPlan, date)),
      mostDaysOverdue: earliestDue === undefined ? null : Math.max(0, daysBetween(earliestDue, date)),
      contactable: true,
    });
  }

  return {
    contactable,
    withoutUsableNumber,
    consentWithdrawn,
    unanswerable,
    lowerBound: unanswerable > 0 || graph.slice.truncated.includes(LedgerFactKind.PATIENT),
  };
}

export interface OwingPatient {
  readonly patientId: string;
  readonly charged: number;
  readonly paid: number;
  readonly outstanding: number;
  readonly deliveredTreatments: number;
  readonly onPaymentPlan: boolean;
  readonly contactable: boolean;
  /** Days since the most recent work that carries a charge. */
  readonly daysSinceLatestDelivery: number | null;
}

export interface BalancePopulation {
  readonly owing: readonly OwingPatient[];
  readonly unanswerable: number;
  readonly lowerBound: boolean;
}

/**
 * Per-patient balances: recorded charges less recorded payments, clamped at zero
 * — the rule `revenue.outstanding` and `lib/billing/balance.ts` share.
 *
 * Per patient, never per treatment: the app allocates payments oldest-first
 * across a patient's whole ledger, and naming a specific treatment as the unpaid
 * one would be a claim the payment records do not make.
 */
export function owingPatients(graph: ClinicLedgerGraph, date: string, timezone?: string): BalancePopulation {
  const owing: OwingPatient[] = [];
  let unanswerable = 0;

  for (const patient of [...graph.slice.patients].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const treatments = graph.treatmentsOfPatient(patient.id);
    const payments = graph.paymentsOfPatient(patient.id);
    if (treatments.status !== "known" || payments.status !== "known") {
      unanswerable += 1;
      continue;
    }
    const chargeable = treatments.value.filter((t) => t.charge.total > 0);
    const charged = chargeable.reduce((sum, t) => sum + t.charge.total, 0);
    if (charged <= 0) continue;
    const paid = payments.value.reduce((sum, p) => sum + p.amount, 0);
    const outstanding = charged - paid;
    if (outstanding <= 0) continue;

    const latest = chargeable
      .map((t) => localDatePart(t.performedAt ?? t.recordedAt, timezone))
      .sort()
      .at(-1);
    owing.push({
      patientId: patient.id,
      charged,
      paid,
      outstanding,
      deliveredTreatments: chargeable.length,
      onPaymentPlan: patient.paymentPlanUntil !== null && patient.paymentPlanUntil >= date,
      contactable: patient.reachableByPhone && !patient.communicationsWithdrawn,
      daysSinceLatestDelivery: latest === undefined ? null : Math.max(0, daysBetween(latest, date)),
    });
  }

  return {
    owing,
    unanswerable,
    lowerBound: unanswerable > 0 || graph.slice.truncated.includes(LedgerFactKind.PATIENT),
  };
}
