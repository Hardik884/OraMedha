/**
 * Prints the consolidated discriminator manifest — the outstanding data
 * requirements this phase produced, grouped by what it would take to satisfy them.
 *
 * It is a test rather than a script so it cannot drift from the shipped catalogue:
 * it asserts every entry is reachable from a real matcher, and prints the manifest
 * as a side effect of proving that.
 */

import { describe, expect, it } from "vitest";

import { ALL_DISCRIMINATORS, Availability } from "../support/discriminators";
import { diagnoseRun } from "./fixtures/diagnose-harness";
import {
  ATTRITION_BALANCED,
  ATTRITION_CANCELLATION_DOMINANT,
  BASE_EROSION,
  CHRONIC_OVERRUN,
  COLLECTION_GAP,
  CONGESTION_CAPACITY_BOUND,
  CONGESTION_FLOW_BOUND,
  DATE,
  DORMANT_PATIENT_BASE,
  DEMAND_SUPPLY_NO_PENDING,
  DEMAND_SUPPLY_WITH_PENDING,
  HIGH_OUTSTANDING,
  ISOLATED_SIGNAL,
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
} from "./fixtures/run-fixtures";

const SCENARIOS = [
  DEMAND_SUPPLY_WITH_PENDING,
  DEMAND_SUPPLY_NO_PENDING,
  REVENUE_YIELD_DRIVEN,
  REVENUE_VOLUME_DRIVEN,
  REVENUE_AMBIGUOUS,
  CONGESTION_CAPACITY_BOUND,
  CONGESTION_FLOW_BOUND,
  ATTRITION_CANCELLATION_DOMINANT,
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

/** Every diagnosis the corpus produces, with and without history. */
function everyDiagnosis() {
  const all = [];
  for (const values of SCENARIOS) {
    for (const history of [undefined, [-3, -2, -1].map((offset) => run(values, { date: shiftDate(DATE, offset) }))]) {
      all.push(...diagnoseRun(run(values, { previous: PRIOR }), { history }).diagnoses);
    }
  }
  return all;
}

/** Discriminator slugs actually attached to a diagnosis across the corpus. */
function emittedSlugs(): Set<string> {
  const slugs = new Set<string>();
  for (const values of SCENARIOS) {
    for (const history of [undefined, [-3, -2, -1].map((offset) => run(values, { date: shiftDate(DATE, offset) }))]) {
      const result = diagnoseRun(run(values, { previous: PRIOR }), { history });
      for (const diagnosis of result.diagnoses) {
        for (const discriminator of diagnosis.discriminators) {
          slugs.add(discriminator.id.split("#d.")[1]);
        }
      }
    }
  }
  return slugs;
}

describe("discriminator manifest", () => {
  it("every catalogued discriminator is reachable from a real matcher", () => {
    const emitted = emittedSlugs();
    const unreachable = ALL_DISCRIMINATORS.filter((spec) => !emitted.has(spec.slug));
    expect(unreachable.map((spec) => spec.slug)).toEqual([]);
  });

  it("prints the consolidated manifest", () => {
    const groups: readonly Availability[] = [
      Availability.REQUIRES_ENTITY_DATA,
      Availability.REQUIRES_NEW_METRIC,
      Availability.REQUIRES_DATA_CAPTURE,
      Availability.REQUIRES_LONGER_HISTORY,
      Availability.AVAILABLE,
    ];
    const lines: string[] = ["", "CONSOLIDATED DISCRIMINATOR MANIFEST", ""];
    for (const group of groups) {
      const entries = ALL_DISCRIMINATORS.filter((spec) => spec.availability === group);
      lines.push(`${group} (${entries.length})`);
      for (const spec of entries) {
        lines.push(`  - ${spec.slug}${spec.portMethod ? `  ->  ${spec.portMethod}()` : ""}`);
      }
      lines.push("");
    }
    console.log(lines.join("\n"));
    expect(ALL_DISCRIMINATORS.length).toBe(28);
  });

  /**
   * The domain type states this as an if-and-only-if: a hypothesis the engine
   * settled needs nothing further, and one it could not settle must say what it
   * would take. Nothing enforced it until now — a matcher could list `requires`
   * on a settled hypothesis and no test would notice.
   */
  it("lists required data if and only if a hypothesis is undetermined", () => {
    for (const diagnosis of everyDiagnosis()) {
      for (const h of diagnosis.hypotheses) {
        if (h.status === "undetermined") {
          expect(
            h.requiredData.length,
            `${diagnosis.pattern}/${h.id} is undetermined and names nothing that would settle it`,
          ).toBeGreaterThan(0);
        } else {
          expect(
            h.requiredData,
            `${diagnosis.pattern}/${h.id} is ${h.status} yet still asks for data`,
          ).toEqual([]);
        }
      }
    }
  });
});
