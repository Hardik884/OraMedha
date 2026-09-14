/**
 * Strategy coverage — keeps the playbook and the Diagnosis Engine from drifting.
 *
 * The Diagnosis Engine and the Strategy Engine are edited in different files, at
 * different times, by whoever is adding the next pattern. Nothing structural
 * stops someone adding a hypothesis to a matcher and forgetting that a settled
 * cause with no strategy ends in generic "investigate further" advice — the
 * exact gap this suite exists to close.
 *
 * The contract, stated once and enforced here:
 *
 *   Every hypothesis slug a matcher can emit is accounted for EXACTLY ONCE —
 *   either in `CORRECTIVE_BY_HYPOTHESIS` (it has a strategy) or in
 *   `CAUSES_WITHOUT_STRATEGY` (it deliberately has none, with a written reason).
 *
 * A new cause with neither entry fails the first test. A strategy template for a
 * slug no matcher emits fails the second. A cause the engine actually SETTLES
 * with no corrective strategy — the drift that produces generic advice — fails
 * the third.
 *
 * Slugs are read from the real matcher corpus rather than hard-coded, so the set
 * cannot fall behind the matchers the way a restated list would.
 */

import { describe, expect, it } from "vitest";

import { CAUSES_WITHOUT_STRATEGY, STRATEGISED_CAUSES } from "../strategy";
import { MetricUnit, type Diagnosis } from "../../domain";
import { applyEntityResolution, type EntityContext } from "../diagnosis/resolution";
import { diagnoseRun } from "../diagnosis/__tests__/fixtures/diagnose-harness";
import {
  ATTRITION_BALANCED,
  ATTRITION_CANCELLATION_DOMINANT,
  ATTRITION_NO_SHOW_DOMINANT,
  BASE_EROSION,
  COLLECTION_GAP,
  CHRONIC_OVERRUN,
  CONGESTION_CAPACITY_BOUND,
  CONGESTION_FLOW_BOUND,
  DATE,
  DORMANT_PATIENT_BASE,
  DEMAND_SUPPLY_NO_PENDING,
  DEMAND_SUPPLY_WITH_PENDING,
  HIGH_OUTSTANDING,
  ISOLATED_SIGNAL,
  NOW,
  PRIOR,
  PRODUCTION_COLLECTION_GAP,
  RECALL_BACKLOG,
  FORWARD_SCHEDULE_GAP,
  REPEAT_NON_ATTENDANCE,
  RECALL_FAILURE,
  REVENUE_AMBIGUOUS,
  REVENUE_VOLUME_DRIVEN,
  REVENUE_YIELD_DRIVEN,
  SUSTAINED_IDLE_CAPACITY,
  run,
  shiftDate,
} from "../diagnosis/__tests__/fixtures/run-fixtures";

/**
 * Every metric scenario the fixtures provide, chosen to fire every matcher.
 * `manifest.spec.ts` proves this same corpus reaches all 27 discriminators; a
 * matcher that fires attaches all of its hypotheses, so firing them all is what
 * makes the declared-slug set complete.
 */
const SCENARIOS = [
  DEMAND_SUPPLY_WITH_PENDING,
  DEMAND_SUPPLY_NO_PENDING,
  REVENUE_YIELD_DRIVEN,
  REVENUE_VOLUME_DRIVEN,
  REVENUE_AMBIGUOUS,
  CONGESTION_CAPACITY_BOUND,
  CONGESTION_FLOW_BOUND,
  ATTRITION_CANCELLATION_DOMINANT,
  ATTRITION_NO_SHOW_DOMINANT,
  ATTRITION_BALANCED,
  COLLECTION_GAP,
  BASE_EROSION,
  RECALL_FAILURE,
  ISOLATED_SIGNAL,
  HIGH_OUTSTANDING,
  RECALL_BACKLOG,
  FORWARD_SCHEDULE_GAP,
  REPEAT_NON_ATTENDANCE,
  DORMANT_PATIENT_BASE,
  CHRONIC_OVERRUN,
  PRODUCTION_COLLECTION_GAP,
  SUSTAINED_IDLE_CAPACITY,
];

/** Diagnose every scenario, with and without a history window. */
function everyDiagnosis(): Diagnosis[] {
  const all: Diagnosis[] = [];
  for (const values of SCENARIOS) {
    const histories = [
      undefined,
      [-3, -2, -1].map((offset) => run(values, { date: shiftDate(DATE, offset) })),
    ];
    for (const history of histories) {
      all.push(...diagnoseRun(run(values, { previous: PRIOR }), { history }).diagnoses);
    }
  }
  return all;
}

/** Hypothesis slug from a `<diagnosisId>#h.<slug>` id. */
function slugOf(hypothesisId: string): string {
  return hypothesisId.split("#h.")[1];
}

/** Every hypothesis slug the corpus declares, in any status. */
function declaredSlugs(): Set<string> {
  const slugs = new Set<string>();
  for (const diagnosis of everyDiagnosis()) {
    for (const h of diagnosis.hypotheses) slugs.add(slugOf(h.id));
  }
  return slugs;
}

/**
 * Entity rows rich enough to drive every registered resolver to a conclusion.
 *
 * The metric corpus alone settles the matcher-level causes; the ten entity-level
 * causes only settle once these rows are folded in. Supplying a generous,
 * internally consistent set lets the "every settled cause has a strategy" test
 * exercise the resolver-settled causes too, not just the matcher-settled ones.
 */
function fullEntityContext(): EntityContext {
  const money = (value: number) => ({ value, unit: MetricUnit.CURRENCY });
  const at = (h: number) => `${DATE}T${String(h).padStart(2, "0")}:00:00.000Z`;
  return {
    // All at 09:00, high notice, none refilled: clustered + recoverable + lost.
    cancellationEvents: Array.from({ length: 8 }, (_, i) => ({
      appointmentId: `appt_c_${i}`,
      date: DATE,
      scheduledStart: at(9),
      localHour: "09:00",
      cancelledAt: at(7),
      noticeHours: 48,
      outcome: "cancelled" as const,
      treatmentType: "checkup",
      slotRefilled: false,
    })),
    // All non-attenders have missed before: patient-level concentration.
    noShowHistory: Array.from({ length: 8 }, (_, i) => ({
      patientId: `pt_n_${i}`,
      appointmentId: `appt_n_${i}`,
      date: DATE,
      priorAttended: 1,
      priorMissed: 3,
      lastAttendedDate: shiftDate(DATE, -90),
    })),
    // All aged and all one high-value type: standing backlog concentrated by cost.
    pendingTreatments: Array.from({ length: 8 }, (_, i) => ({
      treatmentId: `tx_${i}`,
      patientId: `pt_p_${i}`,
      acceptedOn: shiftDate(DATE, -60),
      ageDays: 60,
      treatmentType: "implant",
      quotedValue: money(60_000),
    })),
    // Aged balances dominate by value: standing receivable book.
    outstandingBalances: Array.from({ length: 8 }, (_, i) => ({
      invoiceId: `inv_${i}`,
      patientId: `pt_b_${i}`,
      raisedOn: shiftDate(DATE, -60),
      ageDays: 60,
      amountOutstanding: money(20_000),
      amountPaid: money(0),
    })),
    // Billed high, collected low, all one type: a collection gap, one heavy type.
    completedTreatments: Array.from({ length: 8 }, (_, i) => ({
      treatmentId: `ctx_${i}`,
      patientId: `pt_ct_${i}`,
      date: DATE,
      treatmentType: "crown",
      billedValue: money(20_000),
      collectedValue: money(1_000),
    })),
    // All arrived in one hour and all ran long: bunched arrivals AND overruns.
    appointmentArrivals: Array.from({ length: 8 }, (_, i) => ({
      appointmentId: `appt_a_${i}`,
      date: DATE,
      scheduledStart: at(10),
      arrivedAt: at(10),
      arrivalLocalHour: "10:00",
      arrivalDeltaMinutes: 0,
      seenAt: at(10),
      finishedAt: at(11),
      scheduledMinutes: 30,
      actualMinutes: 60,
    })),
  };
}

/** Slugs the engine actually SETTLES (status supported) across the corpus. */
function settledSlugs(): Set<string> {
  const entity = fullEntityContext();
  const slugs = new Set<string>();
  for (const values of SCENARIOS) {
    const histories = [
      undefined,
      [-3, -2, -1].map((offset) => run(values, { date: shiftDate(DATE, offset) })),
    ];
    for (const history of histories) {
      const { diagnoses } = diagnoseRun(run(values, { previous: PRIOR }), { history });
      const resolved = applyEntityResolution(diagnoses, entity, NOW);
      for (const diagnosis of resolved) {
        for (const h of diagnosis.hypotheses) {
          if (h.status === "supported") slugs.add(slugOf(h.id));
        }
      }
    }
  }
  return slugs;
}

describe("strategy coverage", () => {
  it("classifies every cause the matchers can emit exactly once", () => {
    const declared = declaredSlugs();
    const unclassified = [...declared].filter(
      (slug) => !STRATEGISED_CAUSES.has(slug) && !(slug in CAUSES_WITHOUT_STRATEGY),
    );
    expect(
      unclassified,
      `these causes have neither a corrective strategy nor a documented reason for having none: ${unclassified.join(", ")}`,
    ).toEqual([]);
  });

  it("carries no corrective strategy for a cause no matcher emits", () => {
    const declared = declaredSlugs();
    const dead = [...STRATEGISED_CAUSES].filter((slug) => !declared.has(slug));
    expect(
      dead,
      `these strategy templates name causes no matcher produces (dead templates): ${dead.join(", ")}`,
    ).toEqual([]);
  });

  it("names no cause in the without-strategy list that no matcher emits", () => {
    const declared = declaredSlugs();
    const stale = Object.keys(CAUSES_WITHOUT_STRATEGY).filter((slug) => !declared.has(slug));
    expect(
      stale,
      `these without-strategy entries reference causes no matcher produces: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("never lists a cause as both strategised and deliberately unstrategised", () => {
    const both = [...STRATEGISED_CAUSES].filter((slug) => slug in CAUSES_WITHOUT_STRATEGY);
    expect(both, `these causes appear in both tables: ${both.join(", ")}`).toEqual([]);
  });

  it("gives every cause the engine can settle a strategy, or a benign reason for none", () => {
    const settled = settledSlugs();
    // A settled cause is covered if it has a corrective strategy, or is
    // explicitly recorded as benign — a finding that warrants no action.
    const uncovered = [...settled].filter((slug) => {
      if (STRATEGISED_CAUSES.has(slug)) return false;
      const without = CAUSES_WITHOUT_STRATEGY[slug];
      return without === undefined || without.kind !== "benign";
    });
    expect(
      uncovered,
      `these causes reach a settled 'supported' status with no strategy and no benign reason: ${uncovered.join(", ")}`,
    ).toEqual([]);
  });

  it("settles both matcher-level and entity-level causes in the corpus", () => {
    // A guard on the guard: if the corpus stopped exercising the resolvers the
    // previous test would quietly weaken, so assert a known entity-settled cause
    // and a known matcher-settled cause both appear.
    const settled = settledSlugs();
    expect(settled.has("no_show_dominant")).toBe(true); // matcher-level
    expect(settled.has("patient_level_pattern")).toBe(true); // entity-level (resolver)
  });
});
