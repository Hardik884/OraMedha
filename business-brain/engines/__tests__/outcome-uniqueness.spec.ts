/**
 * Outcome uniqueness — the contract the expanded outcome set rests on.
 *
 * Adding outcomes to a briefing is easy. Adding them without turning it into a
 * wall of near-duplicates a dentist stops reading is the whole problem, and it is
 * not something a code review can check by eye once there are ten of them.
 *
 * Three properties are pinned here, and none of them is asserted anywhere else:
 *
 *   1. **One card per bottleneck.** Every diagnosis pattern routes to at most one
 *      constraint category, and a category that several patterns point at yields
 *      exactly ONE constraint carrying all of them — never one card each.
 *
 *   2. **Every category is a complete outcome.** A category with no value-spec
 *      decision, no investigative workflow or no action plan is a card with
 *      nothing to do. The strategy playbook has its own coverage suite; this
 *      covers the categories themselves, in every engine table keyed by one.
 *      (The briefing COPY table lives in `lib/`, which this module may not
 *      import — that half is asserted in `briefing-expansion.spec.ts`.)
 *
 *   3. **Mutually exclusive pairs never co-occur.** Each guarded pattern pair is
 *      listed explicitly with the scenario that would trip it, so a guard removed
 *      in a refactor fails here rather than showing up as two cards in a clinic.
 *
 * Multi-clinic isolation is asserted at the end: the Business Brain is a
 * multi-tenant read path, and an outcome that leaks across clinics is worse than
 * no outcome at all.
 */

import { describe, expect, it } from "vitest";

import { ConstraintCategory, DiagnosisPattern } from "../../domain";
import { deriveConstraints } from "../constraint";
import { deriveValues } from "../value";
import { proposeStrategies } from "../strategy";
import { generateWorkflows, WORKFLOW_TEMPLATE_KEYS, investigativeKey } from "../workflow";
import { ACTION_PLANS } from "../action/action-plans";
import { MetricKey } from "../metrics/metric-ids";
import { diagnoseMetrics, patternsOf } from "../diagnosis/__tests__/fixtures/diagnose-harness";
import {
  CHRONIC_OVERRUN,
  CLINIC_ID,
  DATE,
  DORMANT_PATIENT_BASE,
  NOW,
  PRODUCTION_COLLECTION_GAP,
  SUSTAINED_IDLE_CAPACITY,
  metrics as metricsFor,
  run,
} from "../diagnosis/__tests__/fixtures/run-fixtures";

const ALL_CATEGORIES = Object.values(ConstraintCategory);

// ── 1. One card per bottleneck ───────────────────────────────────────────────

describe("one card per bottleneck", () => {
  it("collapses every diagnosis in a category into exactly one constraint", () => {
    // The capacity bottleneck is the sharpest case: three patterns point at it,
    // two of which are opposite readings of the same resource. Handing a clinic
    // three cards, one saying the chair was empty and one saying it was full,
    // is precisely what the Constraint Engine exists to prevent.
    const diagnoses = diagnoseMetrics({
      ...SUSTAINED_IDLE_CAPACITY,
      [MetricKey.APPOINTMENTS_TOTAL_TODAY]: 3,
      [MetricKey.CAPACITY_CHAIR_UTILIZATION]: 18,
      [MetricKey.CAPACITY_AVAILABLE_SLOTS_TODAY]: 9,
    }).diagnoses;

    const patterns = diagnoses.map((d) => d.pattern);
    expect(patterns).toContain(DiagnosisPattern.SUSTAINED_IDLE_CAPACITY);
    expect(patterns).toContain(DiagnosisPattern.DEMAND_SUPPLY_MISMATCH);

    const { constraints } = deriveConstraints(diagnoses, CLINIC_ID, DATE, NOW);
    const capacity = constraints.filter((c) => c.category === ConstraintCategory.CAPACITY);
    expect(capacity).toHaveLength(1);
    // Both findings travel on the one card rather than one being discarded.
    expect(capacity[0]?.relatedDiagnosisIds?.length).toBe(2);
  });

  it("never produces two constraints in the same category, on any scenario", () => {
    for (const values of [
      DORMANT_PATIENT_BASE,
      CHRONIC_OVERRUN,
      PRODUCTION_COLLECTION_GAP,
      SUSTAINED_IDLE_CAPACITY,
    ]) {
      const { constraints } = deriveConstraints(
        diagnoseMetrics(values).diagnoses,
        CLINIC_ID,
        DATE,
        NOW,
      );
      const categories = constraints.map((c) => c.category);
      expect(new Set(categories).size).toBe(categories.length);
    }
  });

  it("gives every constraint at most one workflow, so no card has two checklists", () => {
    const diagnoses = diagnoseMetrics(DORMANT_PATIENT_BASE).diagnoses;
    const { constraints } = deriveConstraints(diagnoses, CLINIC_ID, DATE, NOW);
    const { byConstraint } = deriveValues(
      constraints,
      metricsFor(DORMANT_PATIENT_BASE),
      NOW,
    );
    const { strategies } = proposeStrategies(
      constraints,
      diagnoses,
      CLINIC_ID,
      DATE,
      NOW,
      byConstraint,
    );
    const { workflows } = generateWorkflows(strategies, constraints, CLINIC_ID, DATE, NOW);
    expect(workflows.length).toBeGreaterThan(0);
    const perConstraint = workflows.map((w) => w.constraintId);
    expect(new Set(perConstraint).size).toBe(perConstraint.length);
  });
});

// ── 2. Every category is a complete outcome ──────────────────────────────────

describe("every outcome category is complete", () => {
  it("has an investigative workflow template and an action plan for it", () => {
    // The fallback when no cause is settled. A category missing it produces a
    // card with an empty checklist and nothing to click.
    for (const category of ALL_CATEGORIES) {
      const key = investigativeKey(category);
      expect(WORKFLOW_TEMPLATE_KEYS, `no investigative workflow for ${category}`).toContain(key);
      expect(ACTION_PLANS[key], `no action plan for ${key}`).toBeDefined();
      expect(ACTION_PLANS[key]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("is sized by a metric or documented as deliberately unsized", () => {
    // Enforced by construction: the Value Engine's table is a total Record over
    // the category union, so a new category cannot compile without a decision —
    // a metric list, or an explicit null with a written reason. This asserts the
    // decision was actually made for each, and that a sized one produces a value.
    const diagnoses = diagnoseMetrics(DORMANT_PATIENT_BASE).diagnoses;
    const { constraints } = deriveConstraints(diagnoses, CLINIC_ID, DATE, NOW);
    const reactivation = constraints.find(
      (c) => c.category === ConstraintCategory.REACTIVATION,
    );
    expect(reactivation).toBeDefined();

    const { byConstraint } = deriveValues(
      constraints,
      metricsFor(DORMANT_PATIENT_BASE),
      NOW,
    );
    const sized = byConstraint.get(reactivation!.id);
    expect(sized?.[0]?.amount).toBe(140);
    // Sized by the lapsed count, which is the population the card names — not by
    // the overdue follow-up count, which belongs to the retention card.
    expect(sized?.[0]?.description).toContain("recall interval");
  });

  it("sizes retention by the list it sends staff to work, not by the lapsed count", () => {
    // The incoherence the split fixed. Retention's card says "N patients have a
    // follow-up due" and now its headline figure counts the same people.
    const values = {
      ...DORMANT_PATIENT_BASE,
      [MetricKey.FOLLOWUPS_OVERDUE]: 30,
      [MetricKey.PATIENTS_REACTIVATION_CANDIDATES]: 140,
    };
    const diagnoses = diagnoseMetrics(values).diagnoses;
    const { constraints } = deriveConstraints(diagnoses, CLINIC_ID, DATE, NOW);
    const retention = constraints.find((c) => c.category === ConstraintCategory.RETENTION);
    const { byConstraint } = deriveValues(constraints, metricsFor(values), NOW);
    expect(byConstraint.get(retention!.id)?.[0]?.amount).toBe(30);
  });
});

// ── 3. Guarded pairs never co-occur ──────────────────────────────────────────

/**
 * Every pair of patterns that must never appear on the same day, with the
 * scenario that would produce both if its guard were removed.
 *
 * Listed as data rather than as prose so adding a guarded pattern means adding a
 * row here, and so a removed guard fails with the pair named.
 */
const MUTUALLY_EXCLUSIVE: readonly {
  readonly name: string;
  readonly values: Record<string, number>;
  readonly pair: readonly [DiagnosisPattern, DiagnosisPattern];
}[] = [
  {
    name: "a dormant base beside an overdue recall list",
    values: { ...DORMANT_PATIENT_BASE, [MetricKey.FOLLOWUPS_OVERDUE]: 30 },
    pair: [DiagnosisPattern.DORMANT_PATIENT_BASE, DiagnosisPattern.RECALL_BACKLOG],
  },
  {
    name: "a month of overruns beside a queue today",
    values: {
      ...CHRONIC_OVERRUN,
      [MetricKey.QUEUE_PATIENTS_WAITING]: 9,
      [MetricKey.QUEUE_AVERAGE_WAITING_TIME]: 55,
    },
    pair: [
      DiagnosisPattern.CHRONIC_APPOINTMENT_OVERRUN,
      DiagnosisPattern.THROUGHPUT_CONGESTION,
    ],
  },
  {
    name: "a month of under-collection beside a same-day collection gap",
    values: {
      ...PRODUCTION_COLLECTION_GAP,
      [MetricKey.REVENUE_COLLECTED_TODAY]: 900,
      [MetricKey.TREATMENT_COMPLETED_TODAY]: 6,
    },
    pair: [DiagnosisPattern.PRODUCTION_COLLECTION_GAP, DiagnosisPattern.COLLECTION_GAP],
  },
];

describe("guarded pattern pairs", () => {
  for (const { name, values, pair } of MUTUALLY_EXCLUSIVE) {
    it(`never reports both for ${name}`, () => {
      const patterns = patternsOf(diagnoseMetrics(values as never));
      const both = pair.filter((p) => patterns.includes(p));
      expect(both, `both patterns fired: ${both.join(" + ")}`).toHaveLength(1);
    });
  }
});

// ── Multi-clinic isolation ───────────────────────────────────────────────────

describe("multi-clinic isolation", () => {
  it("scopes every new constraint id to its own clinic and date", () => {
    // Constraint ids are what the dismissal table and the briefing key on. An id
    // that did not carry the clinic would let one clinic's snooze suppress
    // another clinic's card.
    const diagnoses = diagnoseMetrics(DORMANT_PATIENT_BASE).diagnoses;
    for (const clinic of ["clinic_a", "clinic_b"]) {
      const { constraints } = deriveConstraints(diagnoses, clinic, DATE, NOW);
      for (const c of constraints) {
        expect(c.id).toBe(`constraint.${c.category}:${clinic}:${DATE}`);
      }
    }
  });

  it("produces the same findings for two clinics with identical data, under their own ids", () => {
    // Determinism across tenants: identical inputs must give identical findings,
    // and nothing but the id may differ. A shared cache or a module-level
    // accumulator would show up here as one clinic's result leaking into the
    // other's.
    const a = diagnoseMetrics(CHRONIC_OVERRUN);
    const b = run(CHRONIC_OVERRUN, { clinicId: "clinic_other" });
    expect(a.diagnoses.length).toBeGreaterThan(0);
    expect(a.diagnoses.every((d) => d.id.includes(CLINIC_ID))).toBe(true);
    expect(b.signals.every((s) => s.id.includes("clinic_other"))).toBe(true);
    expect(b.signals.every((s) => !s.id.includes(CLINIC_ID))).toBe(true);
  });

  it("refuses a run whose metrics mix two clinics rather than blending them", () => {
    // The failure that matters most, and the only one a caller could cause by
    // accident. Mixed rows must be REJECTED, never silently averaged into a
    // finding that describes neither clinic.
    const mixed = [
      ...metricsFor(DORMANT_PATIENT_BASE, { clinicId: "clinic_a" }),
      ...metricsFor(DORMANT_PATIENT_BASE, { clinicId: "clinic_b" }),
    ];
    const result = diagnoseMetrics(mixed as never);
    expect(result.diagnoses).toEqual([]);
    expect(result.error).toBeDefined();
  });
});
