/**
 * Opportunities on the existing briefing.
 *
 * They ride on the action card for the finding about the same resource — never
 * a new column, never a card of their own — and they obey that card's snooze.
 * When no card exists they are carried, unrendered, for the next UI step.
 */

import { describe, expect, it } from "vitest";

import { deriveOpportunities } from "@/business-brain/engines/opportunity";
import {
  appointment,
  capacity,
  CLINIC,
  DATE,
  NOW,
  openWork,
  patient,
  schedule,
  treatment,
  followUp,
} from "@/business-brain/engines/opportunity/__tests__/opportunity-fixtures";
import { ConstraintCategory, type BusinessBrainResult, type Constraint } from "@/business-brain";
import { addDays } from "@/business-brain";
import { buildBriefing, opportunityView } from "../briefing-view";

const forwardConstraint: Constraint = {
  id: `constraint.forward_schedule:${CLINIC}:${DATE}`,
  name: "Next week",
  description: "",
  category: ConstraintCategory.FORWARD_SCHEDULE,
  severity: "medium",
  identifiedAt: NOW,
};

function opportunities(constraints: readonly Constraint[]) {
  return deriveOpportunities({
    clinicId: CLINIC,
    date: DATE,
    now: NOW,
    capacity: capacity(),
    schedule: schedule([
      appointment({ id: "a_cx", patientId: "p_x", status: "cancelled", scheduledAt: `${addDays(DATE, 1)}T10:00:00.000Z` }),
    ]),
    openWork: openWork({
      patients: [patient("p_plan"), patient("p_recall"), patient("p_owes")],
      treatments: [
        treatment({ id: "t1", patientId: "p_plan", charge: { treatment: 0, consultation: 0, radiograph: 0, total: 0, quoted: 22_000 } }),
        treatment({ id: "t2", patientId: "p_owes", status: "completed", charge: { treatment: 9000, consultation: 0, radiograph: 0, total: 9000, quoted: 9000 } }),
      ],
      followUps: [followUp({ id: "f1", patientId: "p_recall" })],
    }),
    constraints,
  }).opportunities;
}

function briefing(constraints: readonly Constraint[], suppressed?: ReadonlySet<string>) {
  return buildBriefing(
    {
      constraints,
      valueAtStake: new Map(),
      workflows: [],
      diagnoses: [],
      opportunities: opportunities(constraints),
    } as unknown as BusinessBrainResult,
    [],
    undefined,
    suppressed,
  );
}

describe("opportunities on the briefing", () => {
  it("attach to the action card for the same finding, not to a card of their own", () => {
    const view = briefing([forwardConstraint]);
    expect(view.actions).toHaveLength(1);
    const types = view.actions[0].opportunities?.map((o) => o.type).sort();
    expect(types).toEqual(["forward_capacity_match", "freed_slot_refill"]);
    // Revenue leakage raised no card, so its opportunity waits unrendered.
    expect(view.unattachedOpportunities?.map((o) => o.type)).toEqual(["unpaid_delivered_work"]);
  });

  it("are withheld with the finding the clinic snoozed", () => {
    const view = briefing([forwardConstraint], new Set(["forward_schedule"]));
    expect(view.actions).toEqual([]);
    const shown = [...(view.unattachedOpportunities ?? [])].map((o) => o.type);
    expect(shown).not.toContain("forward_capacity_match");
  });

  it("leave a run with no opportunities byte-identical to before", () => {
    const view = buildBriefing(
      { constraints: [forwardConstraint], valueAtStake: new Map(), workflows: [], diagnoses: [] } as unknown as BusinessBrainResult,
      [],
    );
    expect(view.actions[0].opportunities).toBeUndefined();
    expect("unattachedOpportunities" in view).toBe(false);
  });

  it("say both halves in plain words, with no ranking, forecast or engine vocabulary", () => {
    const lines = opportunities([]).map(opportunityView);
    const forward = lines.find((l) => l.type === "forward_capacity_match");
    expect(forward?.headline).toBe("Room for 2 more bookings next week, from patients already waiting");
    expect(forward?.surplusLine).toBe("40 appointment-length gaps are open over the next 7 days.");
    expect(forward?.impactLine).toBe("₹22,000 of treatment is already planned for them — quoted, not yet accepted.");

    const unpaid = lines.find((l) => l.type === "unpaid_delivered_work");
    expect(unpaid?.headline).toBe("₹9,000 is owed for work already done");

    const text = lines.flatMap((l) => [l.headline, l.surplusLine, l.demandLine, l.impactLine ?? ""]).join(" ");
    expect(text).not.toMatch(/\bwill (earn|generate|book)\b|\blikely\b|\bprobab|\bconfidence\b|\bconstraint\b|\bsignal\b|\btop\b|\bbest\b|\bpriority\b/i);
  });
});
