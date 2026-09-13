/**
 * The three new outcome cards, end to end.
 *
 * Composed from the REAL engines rather than asserted link by link, for the same
 * reason `briefing-forward-schedule.spec.ts` is: every stage passed its own tests
 * while `capacity.booked_next_7d` sat orphaned and reached no dentist. A metric,
 * a signal and a matcher can each be correct while the chain between them is
 * broken, and only composing them proves anything is on the screen.
 *
 * Two of these cards exist because the previous wording was WRONG rather than
 * missing — a queue reported under "your chair was empty today", and a retention
 * card sized by a population its own sentence did not describe. Those are the
 * assertions to read first.
 */

import { describe, expect, it } from "vitest";

import { ConstraintCategory } from "@/business-brain";
import { deriveConstraints } from "@/business-brain/engines/constraint";
import { deriveValues } from "@/business-brain/engines/value";
import { proposeStrategies } from "@/business-brain/engines/strategy";
import { generateWorkflows } from "@/business-brain/engines/workflow";
import { MetricKey } from "@/business-brain/engines/metrics/metric-ids";
import { diagnoseRun } from "@/business-brain/engines/diagnosis/__tests__/fixtures/diagnose-harness";
import {
  CHRONIC_OVERRUN,
  CLINIC_ID,
  CONGESTION_FLOW_BOUND,
  DATE,
  DORMANT_PATIENT_BASE,
  NOW,
  SUSTAINED_IDLE_CAPACITY,
  metrics,
  run,
} from "@/business-brain/engines/diagnosis/__tests__/fixtures/run-fixtures";
import { buildBriefing, COPY_CATEGORIES } from "../briefing-view";

/**
 * Compose the deterministic pipeline the way the service does.
 *
 * `diagnoses` is threaded into the projection deliberately — the month-level
 * capacity card is chosen from the diagnoses rather than inferred from the
 * metrics, so a harness that dropped them would silently test the wrong branch.
 */
function briefingFor(values: Parameters<typeof metrics>[0]) {
  const current = metrics(values);
  const diagnoses = diagnoseRun(run(values)).diagnoses;
  const { constraints } = deriveConstraints(diagnoses, CLINIC_ID, DATE, NOW);
  const valued = deriveValues(constraints, current, NOW);
  const { strategies } = proposeStrategies(
    constraints,
    diagnoses,
    CLINIC_ID,
    DATE,
    NOW,
    valued.byConstraint,
  );
  const { workflows } = generateWorkflows(strategies, constraints, CLINIC_ID, DATE, NOW);
  const view = buildBriefing(
    {
      constraints,
      diagnoses,
      valueAtStake: valued.byConstraint,
      workflows,
    } as unknown as Parameters<typeof buildBriefing>[0],
    current,
  );
  return { diagnoses, constraints, view };
}

const problemIn = (view: ReturnType<typeof briefingFor>["view"], category: string) =>
  view.problems.find((p) => p.category === category);
const actionIn = (view: ReturnType<typeof briefingFor>["view"], category: string) =>
  view.actions.find((a) => a.category === category);

// ── Completeness ─────────────────────────────────────────────────────────────

describe("briefing copy covers every outcome", () => {
  it("has plain-language copy for every constraint category", () => {
    // Without an entry the card silently falls back to the engine's own wording
    // — "bottleneck", "findings point here" — which is precisely the vocabulary
    // this page exists to keep off the screen.
    for (const category of Object.values(ConstraintCategory)) {
      expect(COPY_CATEGORIES, `no briefing copy for ${category}`).toContain(category);
    }
  });
});

// ── patient_flow ─────────────────────────────────────────────────────────────

describe("patient flow gets its own card instead of the empty-chair one", () => {
  it("describes a queue as a queue, not as an idle chair", () => {
    // The defect this fixes. `throughput_congestion` used to route into CAPACITY,
    // so a clinic whose patients waited 55 minutes was handed a card headed
    // "Your chair was empty today" and sized in unbooked minutes.
    const { view } = briefingFor(CONGESTION_FLOW_BOUND);
    const flow = problemIn(view, ConstraintCategory.PATIENT_FLOW);
    expect(flow).toBeDefined();
    expect(flow?.title).toContain("waited");
    expect(flow?.title).not.toContain("empty");
    expect(view.problems.map((p) => p.category)).not.toContain(ConstraintCategory.CAPACITY);
  });

  it("states the wait in minutes a clinic would say aloud", () => {
    const { view } = briefingFor(CONGESTION_FLOW_BOUND);
    const flow = problemIn(view, ConstraintCategory.PATIENT_FLOW);
    expect(flow?.summary).toContain("55 min");
    expect(flow?.atStake).toBe("55 min");
  });

  it("offers no inline action, because nothing undoes a wait that already happened", () => {
    // An empty action list is the honest answer here. A button that did nothing
    // for the finding would be worse than none.
    const { view } = briefingFor(CONGESTION_FLOW_BOUND);
    const action = actionIn(view, ConstraintCategory.PATIENT_FLOW);
    expect(action?.primaryActions).toEqual([]);
    expect(action?.moreInfoLink?.href).toBe("/dentist/queue");
  });
});

// ── reactivation ─────────────────────────────────────────────────────────────

describe("the dormant patient base gets a card of its own", () => {
  it("names the lapsed population and its size", () => {
    const { view } = briefingFor(DORMANT_PATIENT_BASE);
    const card = problemIn(view, ConstraintCategory.REACTIVATION);
    expect(card).toBeDefined();
    expect(card?.summary).toContain("140");
    expect(card?.atStake).toBe("140");
  });

  it("does not also raise the retention card, which is about different people", () => {
    // The whole point of the split. One clinic, one morning's phone calls, one
    // card — not a reactivation card and a retention card describing overlapping
    // lists with different numbers.
    const { view } = briefingFor(DORMANT_PATIENT_BASE);
    const categories = view.problems.map((p) => p.category);
    expect(categories).toContain(ConstraintCategory.REACTIVATION);
    expect(categories).not.toContain(ConstraintCategory.RETENTION);
  });

  it("hands back to retention when the clinic does have an overdue recall list", () => {
    const { view } = briefingFor({
      ...DORMANT_PATIENT_BASE,
      [MetricKey.FOLLOWUPS_OVERDUE]: 30,
    });
    const categories = view.problems.map((p) => p.category);
    expect(categories).toContain(ConstraintCategory.RETENTION);
    expect(categories).not.toContain(ConstraintCategory.REACTIVATION);
  });

  it("links to the inactive-patient list rather than to overdue follow-ups", () => {
    // These patients are by definition NOT on the follow-up list, so that screen
    // would show a dentist the wrong people.
    const { view } = briefingFor(DORMANT_PATIENT_BASE);
    const action = actionIn(view, ConstraintCategory.REACTIVATION);
    expect(action?.moreInfoLink?.href).toBe("/dentist/patients?filter=inactive");
    // No contact action: the recall message belongs to the retention population,
    // and pointing both at one message kind would collapse the split.
    expect(action?.primaryActions.map((a) => a.kind)).not.toContain("contact_patients");
    expect(action?.primaryActions.map((a) => a.kind)).toContain("book_appointment");
  });
});

// ── schedule_accuracy ────────────────────────────────────────────────────────

describe("the booking-length card", () => {
  it("states the overrun and the sample it rests on", () => {
    const { view } = briefingFor(CHRONIC_OVERRUN);
    const card = problemIn(view, ConstraintCategory.SCHEDULE_ACCURACY);
    expect(card).toBeDefined();
    expect(card?.summary).toContain("38%");
    // The sample is what makes the percentage credible rather than anecdotal.
    expect(card?.summary).toContain("71 visits");
  });

  it("shows no at-stake figure, because the only measurement is a ratio", () => {
    // Deliberately unsized, the same choice FORWARD_SCHEDULE makes. Publishing a
    // 30-day total beside cards that all state today's figures would invite
    // reading it as today's loss.
    const { view } = briefingFor(CHRONIC_OVERRUN);
    const card = problemIn(view, ConstraintCategory.SCHEDULE_ACCURACY);
    expect(card?.atStake).toBeNull();
    expect(card?.atStakeLabel).toBeNull();
  });

  it("gives a checklist that changes the booking template, not the day", () => {
    const { view } = briefingFor(CHRONIC_OVERRUN);
    const action = actionIn(view, ConstraintCategory.SCHEDULE_ACCURACY);
    expect(action?.title).toContain("Book the time");
    expect(action?.checklist.length).toBeGreaterThan(0);
    expect(action?.primaryActions).toEqual([]);
  });
});

// ── the month-level capacity variant ─────────────────────────────────────────

describe("capacity, when only the month-level reading fired", () => {
  it("talks about the month rather than claiming the chair was empty today", () => {
    // Today's utilization is healthy in this scenario. The today-level copy would
    // describe a day that was, in fact, fine.
    const { view } = briefingFor(SUSTAINED_IDLE_CAPACITY);
    const card = problemIn(view, ConstraintCategory.CAPACITY);
    expect(card).toBeDefined();
    expect(card?.title).toContain("month after month");
    expect(card?.summary).toContain("28%");
    // And no at-stake figure: the sized value is today's unbooked minutes, and
    // today was not the problem.
    expect(card?.atStake).toBeNull();
  });

  it("is filed as this week's work, never as today's", () => {
    // A month-long level labelled "Today" would make the genuinely urgent cards
    // beside it indistinguishable from it.
    const { view } = briefingFor(SUSTAINED_IDLE_CAPACITY);
    expect(actionIn(view, ConstraintCategory.CAPACITY)?.timeframeLabel).toBe("This week");
  });

  it("reverts to today's wording as soon as a today-level reading fires too", () => {
    // One card either way; only the words change, and they change to match
    // whichever readings actually fired.
    const { view } = briefingFor({
      ...SUSTAINED_IDLE_CAPACITY,
      [MetricKey.APPOINTMENTS_TOTAL_TODAY]: 3,
      [MetricKey.CAPACITY_CHAIR_UTILIZATION]: 18,
      [MetricKey.CAPACITY_AVAILABLE_SLOTS_TODAY]: 9,
    });
    const capacityCards = view.problems.filter(
      (p) => p.category === ConstraintCategory.CAPACITY,
    );
    expect(capacityCards).toHaveLength(1);
    expect(capacityCards[0]?.title).not.toContain("month after month");
  });
});

// ── no duplicate cards, on any of the new scenarios ──────────────────────────

describe("the briefing never shows two cards for one bottleneck", () => {
  for (const [name, values] of [
    ["a dormant patient base", DORMANT_PATIENT_BASE],
    ["a month of overruns", CHRONIC_OVERRUN],
    ["a month of idle chairs", SUSTAINED_IDLE_CAPACITY],
    ["a queue today", CONGESTION_FLOW_BOUND],
  ] as const) {
    it(`renders one problem and one action per category for ${name}`, () => {
      const { view } = briefingFor(values);
      const problemCategories = view.problems.map((p) => p.category);
      const actionCategories = view.actions.map((a) => a.category);
      expect(new Set(problemCategories).size).toBe(problemCategories.length);
      expect(new Set(actionCategories).size).toBe(actionCategories.length);
      // And every problem has exactly one action paired to it, so neither column
      // can render an orphan.
      expect(view.actions).toHaveLength(view.problems.length);
      for (const problem of view.problems) {
        expect(view.actions.filter((a) => a.problemId === problem.id)).toHaveLength(1);
      }
    });
  }
});
