/**
 * A deleted patient's records: the past still counts, the future does not.
 *
 * Deleting a patient soft-deletes their treatments and payments. The work was
 * delivered and the money collected, so production and collections for those
 * dates must not change; but nothing a deleted patient "owes" can be collected,
 * and nothing they had planned is pipeline any more.
 */

import { describe, expect, it } from "vitest";

import {
  collected30d,
  outstandingOnPaymentPlan,
  outstandingPayments,
  pendingTreatmentValue,
  production30d,
  revenueCollectedToday,
} from "../calculators/revenue-metrics";
import { acceptedTreatmentsPendingScheduling, treatmentsCompletedToday } from "../calculators/treatment-metrics";
import { DATE, payment, snapshot, treatment, valueOf } from "./fixtures/snapshot-fixtures";

const live = snapshot({
  treatments: [treatment({ patientId: "p1", cost: 1000 })],
  payments: [payment({ patientId: "p1", amount: 400 })],
});
const withDeleted = snapshot({
  treatments: [
    ...live.treatments,
    treatment({ cost: 2500, patientDeleted: true, isScheduled: null }),
    treatment({ cost: 900, status: "planned", performedAt: null, patientDeleted: true, isScheduled: null }),
  ],
  payments: [...live.payments, payment({ amount: 600, patientDeleted: true })],
  patientsOnPaymentPlan: new Set(["p1"]),
});

describe("patient-deleted history", () => {
  it("still counts toward money collected and work delivered", () => {
    expect(valueOf(revenueCollectedToday, withDeleted)).toBe(1000);
    expect(valueOf(collected30d, withDeleted)).toBe(1000);
    expect(valueOf(production30d, withDeleted)).toBe(3500);
    expect(valueOf(treatmentsCompletedToday, withDeleted)).toBe(2);
  });

  it("never counts toward what is owed or what is still to come", () => {
    expect(valueOf(outstandingPayments, withDeleted)).toBe(valueOf(outstandingPayments, live));
    expect(valueOf(outstandingOnPaymentPlan, withDeleted)).toBe(600);
    expect(valueOf(pendingTreatmentValue, withDeleted)).toBe(0);
    expect(valueOf(acceptedTreatmentsPendingScheduling, withDeleted)).toBe(0);
  });

  it("a deleted patient's payment cannot cancel a live patient's debt", () => {
    const s = snapshot({
      treatments: [treatment({ cost: 1000 })],
      payments: [payment({ amount: 1000, patientDeleted: true, paymentDate: DATE })],
    });
    expect(valueOf(outstandingPayments, s)).toBe(1000);
  });
});
