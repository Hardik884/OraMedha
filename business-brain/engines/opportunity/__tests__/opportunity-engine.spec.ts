/**
 * The Opportunity Engine, over literal ledgers.
 *
 * Organised by the rules rather than by the code: both sides or nothing, never
 * invent demand, never overstate surplus, never rank a patient, never claim
 * revenue — and every opportunity is worked through the existing prepared-action
 * system.
 */

import { describe, expect, it } from "vitest";

import {
  ActionChannel,
  ActionExecution,
  ConstraintCategory,
  OpportunityType,
  type Constraint,
  type Opportunity,
} from "../../../domain";
import { LedgerFactKind } from "../../../ledger";
import { Priority } from "../../../types";
import { addDays } from "../../../utils";
import { ACTION_CATALOG, Capability } from "../../action/action-catalog";
import { deriveOpportunities, type OpportunityEngineInput } from "../opportunity-engine";
import {
  appointment,
  capacity,
  CLINIC,
  DATE,
  followUp,
  NOW,
  openWork,
  patient,
  payment,
  schedule,
  treatment,
} from "./opportunity-fixtures";

function input(over: Partial<OpportunityEngineInput> = {}): OpportunityEngineInput {
  return {
    clinicId: CLINIC,
    date: DATE,
    now: NOW,
    capacity: capacity(),
    schedule: schedule([]),
    openWork: openWork(),
    constraints: [],
    ...over,
  };
}

/** Two waiting patients: one with planned work, one with an overdue recall. */
function waiting() {
  return openWork({
    patients: [patient("p_plan"), patient("p_recall")],
    treatments: [treatment({ id: "t1", patientId: "p_plan", charge: { treatment: 0, consultation: 0, radiograph: 0, total: 0, quoted: 22_000 } })],
    followUps: [followUp({ id: "f1", patientId: "p_recall", dueDate: "2026-08-03" })],
  });
}

function only(result: ReturnType<typeof deriveOpportunities>, type: Opportunity["type"]) {
  return result.opportunities.filter((o) => o.type === type);
}

function assessment(result: ReturnType<typeof deriveOpportunities>, type: Opportunity["type"]) {
  return result.assessments.find((a) => a.type === type);
}

describe("forward capacity match: both sides or nothing", () => {
  it("pairs next week's open gaps with patients already waiting", () => {
    const result = deriveOpportunities(input({ openWork: waiting() }));
    const [o] = only(result, OpportunityType.FORWARD_CAPACITY_MATCH);

    // 5 weekdays × 8 half-hour gaps, and 2 contactable waiting patients.
    expect(o.surplus.measured[0]).toMatchObject({ value: 40, unit: "appointments" });
    expect(o.demand.measured[0]).toMatchObject({ value: 2, unit: "patients" });
    // Never more than either side can support.
    expect(o.measuredValue).toMatchObject({ value: 2, unit: "appointments" });
    expect(assessment(result, OpportunityType.FORWARD_CAPACITY_MATCH)?.outcome).toBe("detected");
  });

  it("does not emit on surplus alone: open time with nobody recorded as waiting", () => {
    const result = deriveOpportunities(input({ openWork: openWork({ patients: [patient("p_idle")] }) }));
    expect(only(result, OpportunityType.FORWARD_CAPACITY_MATCH)).toEqual([]);
    const a = assessment(result, OpportunityType.FORWARD_CAPACITY_MATCH);
    expect(a?.outcome).toBe("not_detected");
    expect(a?.reason).toContain("no contactable patient");
  });

  it("does not emit on demand alone: patients waiting and a full week", () => {
    const booked = Array.from({ length: 7 }, (_, day) =>
      Array.from({ length: 8 }, (_, slot) =>
        appointment({
          id: `b${day}_${slot}`,
          scheduledAt: `${addDays(DATE, day + 1)}T${String(9 + Math.floor(slot / 2)).padStart(2, "0")}:${slot % 2 === 0 ? "00" : "30"}:00.000Z`,
        }),
      ),
    ).flat();
    const result = deriveOpportunities(input({ schedule: schedule(booked), openWork: waiting() }));
    expect(only(result, OpportunityType.FORWARD_CAPACITY_MATCH)).toEqual([]);
    expect(assessment(result, OpportunityType.FORWARD_CAPACITY_MATCH)?.reason).toContain("effectively full");
  });

  it("counts only contiguous gaps: unbooked slivers too short for an appointment are not surplus", () => {
    // Appointments every 30 minutes lasting 25: 5-minute slivers remain all day.
    const slivers = Array.from({ length: 7 }, (_, day) =>
      Array.from({ length: 8 }, (_, slot) =>
        appointment({
          id: `s${day}_${slot}`,
          durationMinutes: 25,
          scheduledAt: `${addDays(DATE, day + 1)}T${String(9 + Math.floor(slot / 2)).padStart(2, "0")}:${slot % 2 === 0 ? "00" : "30"}:00.000Z`,
        }),
      ),
    ).flat();
    const result = deriveOpportunities(input({ schedule: schedule(slivers), openWork: waiting() }));
    expect(only(result, OpportunityType.FORWARD_CAPACITY_MATCH)).toEqual([]);
  });

  it("refuses a truncated appointment book rather than overstating free time", () => {
    const result = deriveOpportunities(
      input({ schedule: schedule([], { truncated: [LedgerFactKind.APPOINTMENT] }), openWork: waiting() }),
    );
    expect(result.opportunities).toEqual([]);
    expect(assessment(result, OpportunityType.FORWARD_CAPACITY_MATCH)?.outcome).toBe("insufficient_data");
  });

  it("reports unconfigured availability as unmeasurable, not as an empty week", () => {
    const result = deriveOpportunities(input({ capacity: capacity({ availabilityConfigured: false }), openWork: waiting() }));
    expect(assessment(result, OpportunityType.FORWARD_CAPACITY_MATCH)?.outcome).toBe("insufficient_data");
  });

  it("sizes gaps with an assumed length only with a stated confidence penalty", () => {
    const configured = only(deriveOpportunities(input({ openWork: waiting() })), OpportunityType.FORWARD_CAPACITY_MATCH)[0];
    const assumed = only(
      deriveOpportunities(input({ capacity: capacity({ typicalAppointmentMinutes: null }), openWork: waiting() })),
      OpportunityType.FORWARD_CAPACITY_MATCH,
    )[0];
    expect(assumed.confidence).toBeLessThan(configured.confidence);
    expect(assumed.confidenceBasis.join(" ")).toContain("assumed 30 minutes");
  });
});

describe("demand is recorded, reachable and never invented", () => {
  it("leaves out a patient who already has a visit booked", () => {
    const graph = openWork({
      patients: [patient("p_plan"), patient("p_booked")],
      treatments: [treatment({ id: "t1", patientId: "p_plan" }), treatment({ id: "t2", patientId: "p_booked" })],
      appointments: [appointment({ id: "a_next", patientId: "p_booked", scheduledAt: `${addDays(DATE, 3)}T09:00:00.000Z` })],
    });
    const [o] = only(deriveOpportunities(input({ openWork: graph })), OpportunityType.FORWARD_CAPACITY_MATCH);
    expect(o.entities.map((e) => e.id)).toEqual(["p_plan"]);
  });

  it("prepares nothing for a patient who withdrew consent or has no usable number, and counts them apart", () => {
    const graph = openWork({
      patients: [patient("p_ok"), patient("p_withdrawn", { communicationsWithdrawn: true }), patient("p_nophone", { reachableByPhone: false })],
      treatments: ["p_ok", "p_withdrawn", "p_nophone"].map((id, i) => treatment({ id: `t${i}`, patientId: id })),
    });
    const [o] = only(deriveOpportunities(input({ openWork: graph })), OpportunityType.FORWARD_CAPACITY_MATCH);
    expect(o.entities.map((e) => e.id)).toEqual(["p_ok"]);
    expect(o.actionPlan.actions.every((a) => a.involvedEntities.every((e) => e.id === "p_ok"))).toBe(true);
    expect(o.demand.measured.find((q) => q.label.includes("consent withdrawn"))?.value).toBe(1);
    expect(o.demand.measured.find((q) => q.label.includes("no usable number"))?.value).toBe(1);
  });

  it("lists affected patients unranked, in an order that means nothing", () => {
    // p_b has five times the planned value of p_a; the list must not put it first.
    const graph = openWork({
      patients: [patient("p_b"), patient("p_a")],
      treatments: [
        treatment({ id: "t_b", patientId: "p_b", charge: { treatment: 0, consultation: 0, radiograph: 0, total: 0, quoted: 50_000 } }),
        treatment({ id: "t_a", patientId: "p_a", charge: { treatment: 0, consultation: 0, radiograph: 0, total: 0, quoted: 10_000 } }),
      ],
    });
    const [o] = only(deriveOpportunities(input({ openWork: graph })), OpportunityType.FORWARD_CAPACITY_MATCH);
    expect(o.entityOrdering).toBe("unranked");
    expect(o.entities.map((e) => e.id)).toEqual(["p_a", "p_b"]);
  });

  it("marks a cut population as a lower bound and lowers confidence", () => {
    const full = only(deriveOpportunities(input({ openWork: waiting() })), OpportunityType.FORWARD_CAPACITY_MATCH)[0];
    const cut = only(
      deriveOpportunities(input({ openWork: openWork({ ...waiting().slice, truncated: [LedgerFactKind.PATIENT] }) })),
      OpportunityType.FORWARD_CAPACITY_MATCH,
    )[0];
    expect(cut.demand.lowerBound).toBe(true);
    expect(cut.confidence).toBeLessThan(full.confidence);
  });

  it("treats demand it cannot read as unmeasured, not as absent", () => {
    const graph = openWork({ ...waiting().slice, truncated: [LedgerFactKind.APPOINTMENT] });
    const result = deriveOpportunities(input({ openWork: graph }));
    expect(assessment(result, OpportunityType.FORWARD_CAPACITY_MATCH)?.outcome).toBe("insufficient_data");
  });

  it("states recorded planned value as impact, and never a forecast", () => {
    const [o] = only(deriveOpportunities(input({ openWork: waiting() })), OpportunityType.FORWARD_CAPACITY_MATCH);
    expect(o.impact).toMatchObject({ basis: "recorded_value", amount: { value: 22_000, unit: "currency" } });
    expect(o.impact?.statement).toContain("not a forecast");
  });
});

describe("freed slot refill", () => {
  const cancelled = (over = {}) =>
    appointment({
      id: "a_cancelled",
      patientId: "p_canceller",
      status: "cancelled",
      scheduledAt: `${addDays(DATE, 1)}T10:00:00.000Z`,
      ...over,
    });

  it("offers a still-open cancelled slot to waiting patients, expiring before it starts", () => {
    const result = deriveOpportunities(input({ schedule: schedule([cancelled()]), openWork: waiting() }));
    const [o] = only(result, OpportunityType.FREED_SLOT_REFILL);
    expect(o.measuredValue).toMatchObject({ value: 1, unit: "appointments" });
    expect(o.demand.measured[0].value).toBe(2);
    // 120 minutes of notice before a 10:00 start.
    expect(o.window.expiresAt).toBe(`${addDays(DATE, 1)}T08:00:00.000Z`);
    // Starts in 26 hours: medium (high only within 24).
    expect(o.priority).toBe(Priority.MEDIUM);
    // Nothing records what a refilled slot would earn.
    expect(o.impact).toBeNull();
  });

  it("does not offer a slot someone else already took", () => {
    const retaken = appointment({ id: "a_new", scheduledAt: `${addDays(DATE, 1)}T10:15:00.000Z` });
    const result = deriveOpportunities(input({ schedule: schedule([cancelled(), retaken]), openWork: waiting() }));
    expect(only(result, OpportunityType.FREED_SLOT_REFILL)).toEqual([]);
  });

  it("does not offer a slot inside the notice period, or outside open hours", () => {
    const soon = cancelled({ scheduledAt: "2026-09-14T09:30:00.000Z" });
    const closed = cancelled({ id: "a_evening", scheduledAt: `${addDays(DATE, 1)}T15:00:00.000Z` });
    const result = deriveOpportunities(input({ schedule: schedule([soon, closed]), openWork: waiting() }));
    expect(only(result, OpportunityType.FREED_SLOT_REFILL)).toEqual([]);
  });

  it("does not offer the slot back to the patient who gave it up", () => {
    const graph = openWork({
      patients: [patient("p_canceller")],
      treatments: [treatment({ id: "t1", patientId: "p_canceller" })],
    });
    const result = deriveOpportunities(input({ schedule: schedule([cancelled()]), openWork: graph }));
    expect(only(result, OpportunityType.FREED_SLOT_REFILL)).toEqual([]);
  });

  it("cross-references the week's forward match, so the same minutes are never added twice", () => {
    const result = deriveOpportunities(input({ schedule: schedule([cancelled()]), openWork: waiting() }));
    const forward = only(result, OpportunityType.FORWARD_CAPACITY_MATCH)[0];
    const freed = only(result, OpportunityType.FREED_SLOT_REFILL)[0];
    expect(forward.overlapsWith).toEqual([freed.id]);
    expect(freed.overlapsWith).toEqual([forward.id]);
  });

  it("gives each freed slot its own action ids", () => {
    const second = cancelled({ id: "a_cancelled_2", scheduledAt: `${addDays(DATE, 2)}T11:00:00.000Z` });
    const freed = only(deriveOpportunities(input({ schedule: schedule([cancelled(), second]), openWork: waiting() })), OpportunityType.FREED_SLOT_REFILL);
    const ids = freed.flatMap((o) => o.actionPlan.actions.map((a) => a.id));
    expect(freed).toHaveLength(2);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("unpaid delivered work", () => {
  function owing(over: Parameters<typeof openWork>[0] = {}) {
    return openWork({
      patients: [patient("p_owes"), patient("p_plan", { paymentPlanUntil: "2026-12-31" }), patient("p_over")],
      treatments: [
        treatment({ id: "t1", patientId: "p_owes", status: "completed", performedAt: "2026-08-01T10:00:00.000Z", charge: { treatment: 9000, consultation: 0, radiograph: 0, total: 9000, quoted: 9000 } }),
        treatment({ id: "t2", patientId: "p_plan", status: "completed", charge: { treatment: 5000, consultation: 0, radiograph: 0, total: 5000, quoted: 5000 } }),
        treatment({ id: "t3", patientId: "p_over", status: "completed", charge: { treatment: 1000, consultation: 0, radiograph: 0, total: 1000, quoted: 1000 } }),
      ],
      payments: [payment({ id: "pay1", patientId: "p_owes", amount: 2000 }), payment({ id: "pay3", patientId: "p_over", amount: 4000 })],
      ...over,
    });
  }

  it("measures what is owed per patient, excluding agreed payment plans", () => {
    const [o] = only(deriveOpportunities(input({ openWork: owing() })), OpportunityType.UNPAID_DELIVERED_WORK);
    // 9000 − 2000. The overpayer's 3000 credit does not net against it, and the
    // payment-plan balance is reported but not actionable.
    expect(o.measuredValue).toMatchObject({ value: 7000, unit: "currency" });
    expect(o.demand.measured.find((q) => q.label.startsWith("also owed"))?.value).toBe(5000);
    expect(o.entities.map((e) => e.id)).toEqual(["p_owes"]);
    // Latest charged work is 44 days old: aged, so medium.
    expect(o.priority).toBe(Priority.MEDIUM);
    expect(o.window.expiresAt).toBeNull();
    expect(o.impact?.statement).toContain("not a prediction");
  });

  it("is not emitted when every balance is under a payment plan", () => {
    const result = deriveOpportunities(input({
      openWork: openWork({
        patients: [patient("p_plan", { paymentPlanUntil: "2026-12-31" })],
        treatments: [treatment({ id: "t2", patientId: "p_plan", status: "completed" })],
      }),
    }));
    expect(only(result, OpportunityType.UNPAID_DELIVERED_WORK)).toEqual([]);
    expect(assessment(result, OpportunityType.UNPAID_DELIVERED_WORK)?.reason).toContain("payment plan");
  });

  it("will not judge a balance from part of a ledger", () => {
    const result = deriveOpportunities(input({ openWork: owing({ truncated: [LedgerFactKind.PAYMENT] }) }));
    expect(assessment(result, OpportunityType.UNPAID_DELIVERED_WORK)?.outcome).toBe("insufficient_data");
  });
});

describe("integration with the finding and action architecture", () => {
  const forwardConstraint: Constraint = {
    id: `constraint.forward_schedule:${CLINIC}:${DATE}`,
    name: "Next week",
    description: "",
    category: ConstraintCategory.FORWARD_SCHEDULE,
    severity: "medium",
    identifiedAt: NOW,
  };

  it("attaches to the constraint about the same resource when one fired", () => {
    const [o] = only(deriveOpportunities(input({ openWork: waiting(), constraints: [forwardConstraint] })), OpportunityType.FORWARD_CAPACITY_MATCH);
    expect(o.constraintId).toBe(forwardConstraint.id);
    expect(o.actionPlan.constraintId).toBe(forwardConstraint.id);
  });

  it("prefers the most specific finding over the most severe one", () => {
    const todayIdle: Constraint = { ...forwardConstraint, id: `constraint.capacity:${CLINIC}:${DATE}`, category: ConstraintCategory.CAPACITY, severity: "high" };
    // Worst first, as the Constraint Engine orders them: today's idle chair leads.
    const [o] = only(deriveOpportunities(input({ openWork: waiting(), constraints: [todayIdle, forwardConstraint] })), OpportunityType.FORWARD_CAPACITY_MATCH);
    expect(o.constraintId).toBe(forwardConstraint.id);
  });

  it("stands on its own when no such constraint fired", () => {
    const [o] = only(deriveOpportunities(input({ openWork: waiting() })), OpportunityType.FORWARD_CAPACITY_MATCH);
    expect(o.constraintId).toBeNull();
  });

  it("builds every action from the existing catalog, prepared and never performed", () => {
    const result = deriveOpportunities(input({
      schedule: schedule([appointment({ id: "a_cx", patientId: "p_x", status: "cancelled", scheduledAt: `${addDays(DATE, 1)}T10:00:00.000Z` })]),
      openWork: openWork({
        ...waiting().slice,
        patients: [...waiting().slice.patients, patient("p_owes")],
        treatments: [...waiting().slice.treatments, treatment({ id: "t_done", patientId: "p_owes", status: "completed" })],
      }),
    }));
    expect(new Set(result.opportunities.map((o) => o.type)).size).toBe(3);
    for (const o of result.opportunities) {
      expect(o.actionPlan.actions.length).toBeGreaterThan(0);
      expect(o.actionPlan.primaryActionId).toBe(o.actionPlan.actions.find((a) => a.id === o.actionPlan.primaryActionId)?.id);
      for (const action of o.actionPlan.actions) {
        expect(ACTION_CATALOG.has(action.capability)).toBe(true);
        expect(action.delivery.channel).toBe(ActionChannel.IN_APP);
        expect(action.delivery.execution).toBe(ActionExecution.PREPARE_ONLY);
      }
    }
  });

  it("opens only the lists the measured demand is actually on", () => {
    const recallOnly = openWork({ patients: [patient("p_recall")], followUps: [followUp({ id: "f1", patientId: "p_recall" })] });
    const [o] = only(deriveOpportunities(input({ openWork: recallOnly })), OpportunityType.FORWARD_CAPACITY_MATCH);
    const capabilities = o.actionPlan.actions.map((a) => a.capability);
    expect(capabilities).toContain(Capability.OPEN_OVERDUE_FOLLOW_UPS);
    expect(capabilities).not.toContain(Capability.OPEN_PLANNED_TREATMENTS);
  });
});

describe("determinism and discipline", () => {
  it("returns identical output for identical input, without mutating it", () => {
    const frozen = Object.freeze(input({ openWork: waiting(), schedule: schedule([appointment({ id: "a1" })]) }));
    expect(deriveOpportunities(frozen)).toEqual(deriveOpportunities(frozen));
  });

  it("always assesses every type exactly once", () => {
    for (const run of [input(), input({ openWork: null }), input({ capacity: null, schedule: null })]) {
      expect(deriveOpportunities(run).assessments.map((a) => a.type).sort()).toEqual(Object.values(OpportunityType).sort());
    }
  });

  it("reports an unread ledger as unmeasured for every type", () => {
    const result = deriveOpportunities(input({ capacity: null, schedule: null, openWork: null }));
    expect(result.assessments.every((a) => a.outcome === "insufficient_data")).toBe(true);
  });

  it("never phrases a forecast, a probability or a ranking", () => {
    const result = deriveOpportunities(input({
      schedule: schedule([appointment({ id: "a_cx", patientId: "p_x", status: "cancelled", scheduledAt: `${addDays(DATE, 1)}T10:00:00.000Z` })]),
      openWork: openWork({
        ...waiting().slice,
        patients: [...waiting().slice.patients, patient("p_owes")],
        treatments: [...waiting().slice.treatments, treatment({ id: "t_done", patientId: "p_owes", status: "completed" })],
      }),
    }));
    const text = result.opportunities
      .flatMap((o) => [o.title, o.surplus.description, o.demand.description, o.priorityReason, o.impact?.statement ?? "", ...o.confidenceBasis])
      .join(" \n ");
    expect(text).not.toMatch(/\bwill (earn|generate|bring|book)\b|\bexpected revenue\b|\bprobabilit|\blikely to\b|\bmost valuable\b|\btop patients?\b|\bbest patients?\b/i);
  });
});
