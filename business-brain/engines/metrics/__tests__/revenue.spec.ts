import { describe, expect, it } from "vitest";

import {
  BILLABLE_TREATMENT_STATUSES,
  collectionRate30d,
  outstandingOnPaymentPlan,
  outstandingPayments,
  pendingTreatmentValue,
  productionPaidRate30d,
  productionUnpaid30d,
  revenueCollectedToday,
} from "../calculators/revenue-metrics";
// The canonical billing definition, imported here so the metric is pinned to it
// and cannot drift — the calculator itself replicates the formula to keep the
// Business Brain module free of app imports.
import { computeOutstandingBalance } from "@/lib/billing/balance";
import { DATE, payment, snapshot, treatment, valueOf } from "./fixtures/snapshot-fixtures";

describe("revenueCollectedToday", () => {
  it("sums only payments recorded on the target date", () => {
    const s = snapshot({
      payments: [
        payment({ amount: 1500, paymentDate: DATE }),
        payment({ amount: 500, paymentDate: DATE }),
        payment({ amount: 9999, paymentDate: "2026-07-27" }),
        payment({ amount: 9999, paymentDate: "2026-07-29" }),
      ],
    });
    expect(valueOf(revenueCollectedToday, s)).toBe(2000);
  });

  it("reports zero for a day with no payments", () => {
    expect(valueOf(revenueCollectedToday, snapshot())).toBe(0);
  });
});

describe("outstandingPayments", () => {
  it("counts only billable statuses, matching lib/billing/balance.ts", () => {
    expect(BILLABLE_TREATMENT_STATUSES).toEqual(["completed", "in_progress"]);
  });

  it("EXCLUDES planned treatments — accepted work is not yet owed", () => {
    const s = snapshot({
      treatments: [
        treatment({ cost: 5000, status: "completed" }),
        treatment({ cost: 3000, status: "planned" }),
      ],
      payments: [],
    });
    // 5000 billable; the 3000 planned treatment must not appear in dues.
    expect(valueOf(outstandingPayments, s)).toBe(5000);
  });

  it("includes in_progress treatments", () => {
    const s = snapshot({
      treatments: [treatment({ cost: 2000, status: "in_progress" })],
    });
    expect(valueOf(outstandingPayments, s)).toBe(2000);
  });

  it("excludes cancelled treatments", () => {
    const s = snapshot({
      treatments: [
        treatment({ cost: 4000, status: "completed" }),
        treatment({ cost: 8000, status: "cancelled" }),
      ],
    });
    expect(valueOf(outstandingPayments, s)).toBe(4000);
  });

  it("subtracts all payments regardless of date", () => {
    const s = snapshot({
      treatments: [treatment({ cost: 5000, status: "completed" })],
      payments: [
        payment({ amount: 2000, paymentDate: "2026-01-01" }),
        payment({ amount: 1000, paymentDate: DATE }),
      ],
    });
    expect(valueOf(outstandingPayments, s)).toBe(2000);
  });

  it("floors at zero so an overpayment never reads as negative dues", () => {
    const s = snapshot({
      treatments: [treatment({ cost: 1000, status: "completed" })],
      payments: [payment({ amount: 4000 })],
    });
    expect(valueOf(outstandingPayments, s)).toBe(0);
  });

  it("does not double-count planned work against pendingTreatmentValue", () => {
    // The same planned treatment must appear in exactly one of the two metrics.
    const s = snapshot({
      treatments: [treatment({ cost: 7000, status: "planned" })],
    });
    expect(valueOf(outstandingPayments, s)).toBe(0);
    expect(valueOf(pendingTreatmentValue, s)).toBe(7000);
  });

  it("clamps per patient — a deposit on planned work can't erase another patient's debt", () => {
    // A owes 1000 for completed work; B put a 1000 deposit against B's PLANNED
    // (non-billable) treatment. B's deposit must stay with B, not cancel A's debt.
    const s = snapshot({
      treatments: [
        treatment({ patientId: "A", cost: 1000, status: "completed" }),
        treatment({ patientId: "B", cost: 5000, status: "planned" }),
      ],
      payments: [payment({ patientId: "B", amount: 1000 })],
    });
    expect(valueOf(outstandingPayments, s)).toBe(1000); // was 0 under clinic-level netting
  });

  it("clamps per patient — one patient's overpayment doesn't cancel another's dues", () => {
    // A overpaid by 500 (clamped to 0); C still owes 800. Total is 800, not 300.
    const s = snapshot({
      treatments: [
        treatment({ patientId: "A", cost: 1000, status: "completed" }),
        treatment({ patientId: "C", cost: 800, status: "completed" }),
      ],
      payments: [payment({ patientId: "A", amount: 1500 })],
    });
    expect(valueOf(outstandingPayments, s)).toBe(800); // was 300 under clinic-level netting
  });

  it("includes OPD and X-ray charges (cost + OPD + X-ray − payments)", () => {
    // Completed cost 1000 + OPD 300 + X-ray 500 = 1800 charged; paid 500 → 1300.
    const s = snapshot({
      treatments: [
        treatment({ cost: 1000, status: "completed", opdCharged: true, opdFee: 300, xrayTaken: true, xrayCost: 500 }),
      ],
      payments: [payment({ amount: 500 })],
    });
    expect(valueOf(outstandingPayments, s)).toBe(1300);
  });

  it("charges OPD and X-ray even on a planned treatment (the consultation happened)", () => {
    // The planned cost is NOT billable, but the OPD consultation and the X-ray
    // are owed regardless of the treatment's status — 0 + 300 + 500 = 800.
    const s = snapshot({
      treatments: [
        treatment({ cost: 5000, status: "planned", opdCharged: true, opdFee: 300, xrayTaken: true, xrayCost: 500 }),
      ],
    });
    expect(valueOf(outstandingPayments, s)).toBe(800);
  });

  it("matches lib/billing computeOutstandingBalance exactly (per patient)", () => {
    // One patient, a mix that exercises billable cost, OPD, X-ray, a non-billable
    // planned line, and a partial payment. The metric must equal the canonical
    // per-patient balance so the two never diverge.
    const rows = [
      { cost: 1000, status: "completed", opd_charged: true, opd_fee: 300, xray_taken: true, xray_cost: 500 },
      { cost: 800, status: "planned", opd_charged: false, xray_taken: false },
    ];
    const pays = [{ amount: 400 }];
    const canonical = computeOutstandingBalance(rows, pays);
    const s = snapshot({
      treatments: rows.map((t) =>
        treatment({
          patientId: "A",
          cost: t.cost,
          status: t.status,
          opdCharged: t.opd_charged,
          opdFee: t.opd_fee,
          xrayTaken: t.xray_taken,
          xrayCost: t.xray_cost,
        }),
      ),
      payments: pays.map((p) => payment({ patientId: "A", amount: p.amount })),
    });
    expect(valueOf(outstandingPayments, s)).toBe(canonical);
    expect(canonical).toBe(1400); // 1000 + 300 + 500 − 400
  });
});

describe("pendingTreatmentValue", () => {
  it("sums planned and in_progress treatments only", () => {
    const s = snapshot({
      treatments: [
        treatment({ cost: 1000, status: "planned" }),
        treatment({ cost: 2000, status: "in_progress" }),
        treatment({ cost: 4000, status: "completed" }),
        treatment({ cost: 8000, status: "cancelled" }),
      ],
    });
    expect(valueOf(pendingTreatmentValue, s)).toBe(3000);
  });

  it("uses gross cost, not the clinic's share", () => {
    const s = snapshot({
      treatments: [treatment({ cost: 1000, status: "planned" })],
    });
    expect(valueOf(pendingTreatmentValue, s)).toBe(1000);
  });
});


describe("outstandingOnPaymentPlan", () => {
  it("is WITHHELD, never zero, when the snapshot carries no payment-plan set", () => {
    // Absence must mean "no repository support", never "nobody has one" — the
    // same withheld-not-zero discipline every other optional input follows.
    const s = snapshot({
      treatments: [treatment({ patientId: "A", cost: 5000, status: "completed" })],
    });
    expect(outstandingOnPaymentPlan(s)).toBeNull();
  });

  it("reports 0 when the set is present but empty — a real, reportable fact", () => {
    const s = snapshot({
      treatments: [treatment({ patientId: "A", cost: 5000, status: "completed" })],
      patientsOnPaymentPlan: new Set(),
    });
    expect(valueOf(outstandingOnPaymentPlan, s)).toBe(0);
  });

  it("sums only the plan patients' own clamped balance, not a share of the total", () => {
    const s = snapshot({
      treatments: [
        treatment({ patientId: "A", cost: 50_000, status: "completed" }),
        treatment({ patientId: "B", cost: 10_000, status: "completed" }),
      ],
      payments: [payment({ patientId: "A", amount: 5_000 })],
      patientsOnPaymentPlan: new Set(["A"]),
    });
    // A owes 45,000 under the plan; B's 10,000 is unrelated and must not appear.
    expect(valueOf(outstandingOnPaymentPlan, s)).toBe(45_000);
    // The clinic-wide total is unaffected — the money is still genuinely owed.
    expect(valueOf(outstandingPayments, s)).toBe(55_000);
  });

  it("never reads negative even if a plan patient has overpaid", () => {
    const s = snapshot({
      treatments: [treatment({ patientId: "A", cost: 1_000, status: "completed" })],
      payments: [payment({ patientId: "A", amount: 5_000 })],
      patientsOnPaymentPlan: new Set(["A"]),
    });
    expect(valueOf(outstandingOnPaymentPlan, s)).toBe(0);
  });
});

// ── Collecting for the work, rather than in the same month as it ─────────────

describe("productionPaidRate30d", () => {
  /** One patient's window: work delivered, and what they have paid in total. */
  function patientWindow(charged: number, paidTotal: number, id = "p1") {
    return {
      treatments: [treatment({ patientId: id, cost: charged, status: "completed" })],
      payments: paidTotal === 0 ? [] : [payment({ patientId: id, amount: paidTotal })],
    };
  }

  it("is the share of the window's own work that has been paid for", () => {
    const s = snapshot(patientWindow(10_000, 7_500));
    expect(valueOf(productionPaidRate30d, s)).toBe(75);
    expect(valueOf(productionUnpaid30d, s)).toBe(2_500);
  });

  it("does not count old debt being cleared as this month's collection", () => {
    // THE defect. This patient owed 40,000 for work done long before the window,
    // cleared it this month, and also paid for the 10,000 of work delivered
    // inside the window. Cash in (50,000) against work out (10,000) reads 500%
    // — which is where a "normal collection rate" of 115% comes from. The work
    // delivered in the window was paid for in full, which is 100%.
    const s = snapshot({
      treatments: [
        treatment({ patientId: "p1", cost: 40_000, status: "completed", performedAt: "2026-01-04T10:00:00.000Z" }),
        treatment({ patientId: "p1", cost: 10_000, status: "completed" }),
      ],
      payments: [payment({ patientId: "p1", amount: 50_000 })],
    });

    expect(valueOf(collectionRate30d, s)).toBe(500);
    expect(valueOf(productionPaidRate30d, s)).toBe(100);
    expect(valueOf(productionUnpaid30d, s)).toBe(0);
  });

  it("attributes a surviving balance to the most recent work, capped at it", () => {
    // Same patient, 40,000 of old work and 10,000 of new, but only 35,000 paid.
    // 15,000 is still owed; only 10,000 of it can be this window's work, because
    // that is all the window charged. The other 5,000 is old debt and is not
    // this month's collection problem.
    const s = snapshot({
      treatments: [
        treatment({ patientId: "p1", cost: 40_000, status: "completed", performedAt: "2026-01-04T10:00:00.000Z" }),
        treatment({ patientId: "p1", cost: 10_000, status: "completed" }),
      ],
      payments: [payment({ patientId: "p1", amount: 35_000 })],
    });

    expect(valueOf(productionUnpaid30d, s)).toBe(10_000);
    expect(valueOf(productionPaidRate30d, s)).toBe(0);
  });

  it("never lets one patient's overpayment cover another's unpaid work", () => {
    const s = snapshot({
      treatments: [
        treatment({ patientId: "p1", cost: 10_000, status: "completed" }),
        treatment({ patientId: "p2", cost: 10_000, status: "completed" }),
      ],
      // p1 paid double; p2 paid nothing.
      payments: [payment({ patientId: "p1", amount: 20_000 })],
    });

    expect(valueOf(productionUnpaid30d, s)).toBe(10_000);
    expect(valueOf(productionPaidRate30d, s)).toBe(50);
  });

  it("cannot exceed 100%, however much cash arrives", () => {
    const s = snapshot({
      treatments: [treatment({ patientId: "p1", cost: 5_000, status: "completed" })],
      payments: [payment({ patientId: "p1", amount: 500_000 })],
    });
    expect(valueOf(productionPaidRate30d, s)).toBe(100);
  });

  it("is WITHHELD when the window delivered no collectable work", () => {
    // Not 0%. "None of our work gets paid for" and "we delivered nothing" are
    // different statements, and only one of them is true here.
    expect(productionPaidRate30d(snapshot())).toBeNull();
  });

  it("leaves a deleted patient's work out of the measurement entirely", () => {
    // Their production still happened and still counts (§5.14a); their balance
    // is not collectable, so a gap against it is one nobody can close.
    const s = snapshot({
      treatments: [
        treatment({ cost: 8_000, status: "completed", patientDeleted: true }),
        treatment({ patientId: "p1", cost: 2_000, status: "completed" }),
      ],
      payments: [payment({ patientId: "p1", amount: 2_000 })],
    });
    expect(valueOf(productionPaidRate30d, s)).toBe(100);
    expect(valueOf(productionUnpaid30d, s)).toBe(0);
  });
});
