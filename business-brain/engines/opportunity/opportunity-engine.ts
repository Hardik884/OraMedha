/**
 * Business Brain — Opportunity Engine
 *
 * Pairs a measured surplus with measured demand, from the clinic ledger.
 *
 *   forward_capacity_match  contiguous open chair time in the next 7 days
 *                           × patients with planned treatment or an overdue
 *                             recall and nothing booked
 *   freed_slot_refill       a future appointment cancelled whose slot is still
 *                           open, with enough notice left to offer it
 *                           × the same waiting patients
 *   unpaid_delivered_work   work delivered and charged
 *                           × the recorded balance still owed for it
 *
 * ## The rules it cannot break
 *
 * - Both sides measured from recorded rows, or nothing is emitted. Each type's
 *   assessment says which side was missing, and distinguishes "measured and
 *   absent" (`not_detected`) from "could not be measured" (`insufficient_data`).
 * - Surplus is never overstated. A truncated schedule read makes capacity
 *   `insufficient_data` rather than a lower bound, because a cut appointment
 *   list shows MORE free time than exists.
 * - Demand is never invented and never ranked. See ./demand.ts.
 * - Impact is a recorded amount or null. No fill rate, no conversion, no ML.
 *
 * Pure: `now` injected, no clock, no I/O, no model. Same input → same output.
 */

import {
  ConstraintCategory,
  EntityType,
  OpportunityType,
  WorkflowOwner,
  WorkflowTimeframe,
  type ActionPlan,
  type Constraint,
  type Opportunity,
  type OpportunityAssessment,
  type OpportunityEntity,
  type OpportunityQuantity,
} from "../../domain";
import type { CapacityWindowFact, ClinicLedgerGraph } from "../../ledger";
import { LedgerFactKind } from "../../ledger";
import { Priority, type Evidence } from "../../types";
import { addDays } from "../../utils";
import { prepareActionPlan } from "../action/action-engine";
import type { ActionPlanStep } from "../action/action-plans";
import {
  appointmentInterval,
  gapsForDay,
  overlapping,
  withinOpenHours,
  type DayGaps,
} from "./capacity-gaps";
import { owingPatients, waitingDemand, type DemandPopulation, type WaitingPatient } from "./demand";
import {
  resolveOpportunityConfig,
  type OpportunityConfig,
} from "./opportunity-config";
import { forwardCapacitySteps, FREED_SLOT_STEPS, UNPAID_WORK_STEPS } from "./opportunity-plans";

const SOURCE = "OpportunityEngine";
const HOUR = 3_600_000;

export interface OpportunityEngineInput {
  readonly clinicId: string;
  /** Clinic-local business date the run describes — today. */
  readonly date: string;
  /** ISO-8601 moment of the run. */
  readonly now: string;
  /** Published capacity from `date` to `date + forwardDays`, or null when unread. */
  readonly capacity: CapacityWindowFact | null;
  /** Appointment-window graph over the same dates, or null when unread. */
  readonly schedule: ClinicLedgerGraph | null;
  /** Open-work graph (patients with planned work, overdue recalls or balances). */
  readonly openWork: ClinicLedgerGraph | null;
  /** This run's constraints, worst first, so an opportunity can attach to one. */
  readonly constraints: readonly Constraint[];
  readonly config?: Parameters<typeof resolveOpportunityConfig>[0];
}

export interface OpportunityResult {
  readonly opportunities: readonly Opportunity[];
  readonly assessments: readonly OpportunityAssessment[];
}

const RELATED: Readonly<Record<OpportunityType, readonly ConstraintCategory[]>> = {
  [OpportunityType.FORWARD_CAPACITY_MATCH]: [
    ConstraintCategory.FORWARD_SCHEDULE,
    ConstraintCategory.CAPACITY,
    ConstraintCategory.TREATMENT_ACCEPTANCE,
    ConstraintCategory.RETENTION,
  ],
  [OpportunityType.FREED_SLOT_REFILL]: [ConstraintCategory.SCHEDULING, ConstraintCategory.FORWARD_SCHEDULE],
  [OpportunityType.UNPAID_DELIVERED_WORK]: [ConstraintCategory.REVENUE_LEAKAGE],
};

export function deriveOpportunities(input: OpportunityEngineInput): OpportunityResult {
  const config = resolveOpportunityConfig(input.config);
  const assessments: OpportunityAssessment[] = [];
  const opportunities: Opportunity[] = [];

  const demand = input.openWork === null ? null : waitingDemand(input.openWork, input.date, input.now);

  const forward = detectForwardCapacity(input, config, demand);
  assessments.push(forward.assessment);
  const freed = detectFreedSlots(input, config, demand);
  assessments.push(freed.assessment);
  const unpaid = detectUnpaidWork(input, config);
  assessments.push(unpaid.assessment);

  // Freed slots are carved out of the same week's open time the forward match
  // counts. Cross-reference them so nothing downstream adds the two together.
  const forwardOpportunity = forward.opportunity;
  const freedOpportunities = freed.opportunities.map((o) =>
    forwardOpportunity === null ? o : { ...o, overlapsWith: [forwardOpportunity.id] },
  );
  if (forwardOpportunity !== null) {
    opportunities.push({ ...forwardOpportunity, overlapsWith: freedOpportunities.map((o) => o.id) });
  }
  opportunities.push(...freedOpportunities);
  if (unpaid.opportunity !== null) opportunities.push(unpaid.opportunity);

  return { opportunities, assessments };
}

// ── forward_capacity_match ──────────────────────────────────────────────────

function detectForwardCapacity(
  input: OpportunityEngineInput,
  config: OpportunityConfig,
  demand: DemandPopulation | null,
): { opportunity: Opportunity | null; assessment: OpportunityAssessment } {
  const type = OpportunityType.FORWARD_CAPACITY_MATCH;
  const surplusUnreadable = surplusUnavailable(input);
  if (surplusUnreadable !== null) return notEmitted(type, "insufficient_data", surplusUnreadable);
  if (demand === null) return notEmitted(type, "insufficient_data", "The open-work ledger was not read, so demand cannot be measured.");

  const capacity = input.capacity as CapacityWindowFact;
  const schedule = input.schedule as ClinicLedgerGraph;
  const configuredLength = capacity.typicalAppointmentMinutes;
  const length = configuredLength ?? config.assumedAppointmentMinutes;
  const from = addDays(input.date, 1);
  const to = addDays(input.date, config.forwardDays);
  const days: DayGaps[] = capacity.days
    .filter((d) => d.date >= from && d.date <= to)
    .map((d) => gapsForDay(d, capacity.chairCount, schedule.slice.appointments, length));

  const fittable = days.reduce((sum, d) => sum + d.fittableAppointments, 0);
  const openChairMinutes = days.reduce((sum, d) => sum + d.openChairMinutes, 0);
  const bookedChairMinutes = days.reduce((sum, d) => sum + d.bookedChairMinutes, 0);

  if (openChairMinutes <= 0) {
    return notEmitted(type, "not_detected", `The clinic publishes no open time between ${from} and ${to}.`);
  }
  if (fittable === 0) {
    return notEmitted(
      type,
      "not_detected",
      `No contiguous gap of ${length} minutes is free between ${from} and ${to}; the week is effectively full.`,
    );
  }
  if (demand.contactable.length === 0 && demand.unanswerable > 0) {
    return notEmitted(type, "insufficient_data", `${demand.unanswerable} patient(s) with open work could not be read in full, and no other contactable patient is waiting.`);
  }
  if (demand.contactable.length === 0) {
    return notEmitted(
      type,
      "not_detected",
      `${fittable} appointment-length gap(s) are open, but no contactable patient has planned treatment or an overdue recall with nothing booked.`,
    );
  }

  const measured = Math.min(fittable, demand.contactable.length);
  const planned = demand.contactable.filter((p) => p.pools.includes("planned_treatment"));
  const recall = demand.contactable.filter((p) => p.pools.includes("overdue_recall"));
  const plannedValue = planned.reduce((sum, p) => sum + p.plannedValue, 0);
  const id = opportunityId(type, input);
  const gapDays = days.filter((d) => d.fittableAppointments > 0);

  const basis: string[] = ["Open time comes from the clinic's published hours; booked time from live appointments."];
  let confidence = 1;
  if (configuredLength === null) {
    confidence -= config.penalties.assumedAppointmentLength;
    basis.push(`No typical appointment length is configured, so gaps were sized at an assumed ${length} minutes.`);
  }
  if (demand.lowerBound) {
    confidence -= config.penalties.demandLowerBound;
    basis.push("Part of the open-work population could not be read, so demand is at least the figure shown.");
  }
  confidence -= config.penalties.patientAvailabilityUnrecorded;
  basis.push("Patient availability is not recorded, so no patient is claimed to fit a particular gap.");

  const priority =
    measured >= config.highPriorityFillable
      ? Priority.HIGH
      : measured >= config.mediumPriorityFillable
        ? Priority.MEDIUM
        : Priority.LOW;

  const opportunity: Opportunity = {
    id,
    type,
    clinicId: input.clinicId,
    date: input.date,
    title: "Open chair time next week, and patients already waiting to be booked",
    measuredValue: qty(measured, "appointments", "bookings the open gaps and waiting patients can both support"),
    surplus: {
      description: `Contiguous free chair time between ${from} and ${to}, in gaps of at least ${length} minutes.`,
      measured: [
        qty(fittable, "appointments", `appointment-length gaps free (${length} min each)`),
        qty(Math.max(0, openChairMinutes - bookedChairMinutes), "minutes", "chair time open and unbooked"),
      ],
      lowerBound: false,
    },
    demand: {
      description: "Patients with planned treatment or an overdue recall, nothing booked, and reachable.",
      measured: [
        qty(demand.contactable.length, "patients", "contactable patients waiting for a booking"),
        qty(planned.length, "patients", "with planned treatment and nothing booked"),
        qty(recall.length, "patients", "with an overdue recall and nothing booked"),
        qty(demand.withoutUsableNumber, "patients", "also waiting, but with no usable number on record"),
        qty(demand.consentWithdrawn, "patients", "also waiting, but communications consent withdrawn"),
      ],
      lowerBound: demand.lowerBound,
    },
    entities: demand.contactable.map(waitingEntity),
    entityOrdering: "unranked",
    confidence: round2(Math.max(0, confidence)),
    confidenceBasis: basis,
    evidence: [
      evidence(id, "surplus", `${fittable} gap(s) of ${length} min across ${gapDays.length} day(s); ${bookedChairMinutes} of ${openChairMinutes} chair-minutes booked.`, { days }, input.now),
      evidence(id, "demand", `${demand.contactable.length} contactable patient(s) waiting: ${planned.length} with planned treatment, ${recall.length} with an overdue recall (a patient can be in both).`, {
        withoutUsableNumber: demand.withoutUsableNumber,
        consentWithdrawn: demand.consentWithdrawn,
        unanswerable: demand.unanswerable,
      }, input.now),
    ],
    window: {
      opensAt: gapDays[0]?.firstGapAt ?? input.now,
      expiresAt: gapDays.at(-1)?.lastGapEndsAt ?? null,
      basis: "From the first free gap to the end of the last one in the coming week; each gap expires as it passes.",
    },
    impact:
      plannedValue > 0
        ? {
            amount: qty(plannedValue, "currency", "recorded quoted value of planned treatment for these patients"),
            basis: "recorded_value",
            statement:
              "The quoted cost already recorded against these patients' planned treatment. It is not a forecast: planned is not accepted, and nothing records whether a call will lead to a booking.",
          }
        : null,
    priority,
    priorityReason: `${measured} booking(s) are supportable by both open gaps and waiting patients (high at ${config.highPriorityFillable}, medium at ${config.mediumPriorityFillable}).`,
    relatedCategories: RELATED[type],
    constraintId: linkedConstraint(type, input.constraints),
    overlapsWith: [],
    actionPlan: plan(
      input,
      `opportunity.${type}`,
      id,
      "Fill next week's gaps from patients already waiting",
      priority,
      WorkflowTimeframe.THIS_WEEK,
      type,
      forwardCapacitySteps({ planned: planned.length > 0, recall: recall.length > 0 }),
      demand.contactable.map((p) => p.patientId),
    ),
    detectedAt: input.now,
  };
  return { opportunity, assessment: emitted(type, 1, "Both open gaps and waiting, contactable patients were measured.") };
}

// ── freed_slot_refill ───────────────────────────────────────────────────────

function detectFreedSlots(
  input: OpportunityEngineInput,
  config: OpportunityConfig,
  demand: DemandPopulation | null,
): { opportunities: readonly Opportunity[]; assessment: OpportunityAssessment } {
  const type = OpportunityType.FREED_SLOT_REFILL;
  const none = (outcome: "not_detected" | "insufficient_data", reason: string) => ({
    opportunities: [],
    assessment: { type, outcome, reason, detected: 0 },
  });
  const surplusUnreadable = surplusUnavailable(input);
  if (surplusUnreadable !== null) return none("insufficient_data", surplusUnreadable);
  if (demand === null) return none("insufficient_data", "The open-work ledger was not read, so demand cannot be measured.");

  const capacity = input.capacity as CapacityWindowFact;
  const appointments = (input.schedule as ClinicLedgerGraph).slice.appointments;
  const earliest = Date.parse(input.now) + config.minimumRefillLeadMinutes * 60_000;

  const seen = new Set<string>();
  const slots = appointments
    .filter((a) => a.status === "cancelled" && Date.parse(a.scheduledAt) >= earliest)
    .sort((a, b) => (a.scheduledAt < b.scheduledAt ? -1 : a.scheduledAt > b.scheduledAt ? 1 : a.id < b.id ? -1 : 1))
    .filter((a) => {
      const key = `${a.dentistId}|${a.scheduledAt}`;
      if (seen.has(key)) return false;
      seen.add(key);
      const at = Date.parse(a.scheduledAt);
      const day = capacity.days.find((d) => at >= Date.parse(d.startsAt) && at <= Date.parse(d.endsAt));
      if (day === undefined) return false;
      const interval = appointmentInterval(a);
      if (!withinOpenHours(interval, day)) return false;
      const occupying = overlapping(interval, appointments);
      // Still open: the same dentist is free, and a chair is free throughout.
      return !occupying.some((o) => o.dentistId === a.dentistId) && occupying.length < capacity.chairCount;
    });

  if (demand.contactable.length === 0 && demand.unanswerable > 0) {
    return none("insufficient_data", `${demand.unanswerable} patient(s) with open work could not be read in full, and no other contactable patient is waiting.`);
  }
  if (slots.length === 0) {
    return none("not_detected", "No future cancellation leaves a slot still open with enough notice to offer it.");
  }

  const results: Opportunity[] = [];
  for (const slot of slots.slice(0, config.maxFreedSlots)) {
    // The patient who gave the slot up is not offered it back.
    const candidates = demand.contactable.filter((p) => p.patientId !== slot.patientId);
    if (candidates.length === 0) continue;

    const startsInHours = (Date.parse(slot.scheduledAt) - Date.parse(input.now)) / HOUR;
    const priority =
      startsInHours <= config.freedSlotHighWithinHours
        ? Priority.HIGH
        : startsInHours <= config.freedSlotMediumWithinHours
          ? Priority.MEDIUM
          : Priority.LOW;
    const id = `${opportunityId(type, input)}:${slot.id}`;
    const minutes = appointmentInterval(slot);
    const lengthMinutes = Math.round((minutes.end - minutes.start) / 60_000);

    const basis = ["The slot's cancellation and its still-open state are both recorded."];
    let confidence = 1 - config.penalties.patientAvailabilityUnrecorded;
    basis.push("No standby list is recorded, so candidates are patients waiting for a booking, not patients who asked for an earlier slot.");
    if (demand.lowerBound) {
      confidence -= config.penalties.demandLowerBound;
      basis.push("Part of the open-work population could not be read, so candidates are at least the figure shown.");
    }

    results.push({
      id,
      type,
      clinicId: input.clinicId,
      date: input.date,
      title: "A cancelled slot is still open, and patients are waiting for a booking",
      measuredValue: qty(1, "appointments", `${lengthMinutes}-minute slot to refill`),
      surplus: {
        description: `A cancelled ${lengthMinutes}-minute appointment at ${slot.scheduledAt}, not rebooked.`,
        measured: [qty(lengthMinutes, "minutes", "freed chair-minutes, still open")],
        lowerBound: false,
      },
      demand: {
        description: "Contactable patients with planned treatment or an overdue recall and nothing booked.",
        measured: [qty(candidates.length, "patients", "contactable patients who could be offered the slot")],
        lowerBound: demand.lowerBound,
      },
      entities: [
        { type: EntityType.APPOINTMENT, id: slot.id, facts: { scheduledAt: slot.scheduledAt, minutes: lengthMinutes } },
        ...candidates.map(waitingEntity),
      ],
      entityOrdering: "unranked",
      confidence: round2(Math.max(0, confidence)),
      confidenceBasis: basis,
      evidence: [
        evidence(id, "surplus", `Appointment ${slot.id} was cancelled; no live appointment for the same dentist overlaps it and a chair is free.`, { scheduledAt: slot.scheduledAt, minutes: lengthMinutes }, input.now),
        evidence(id, "demand", `${candidates.length} contactable patient(s) are waiting for a booking.`, { candidates: candidates.length }, input.now),
      ],
      window: {
        opensAt: input.now,
        expiresAt: new Date(Date.parse(slot.scheduledAt) - config.minimumRefillLeadMinutes * 60_000).toISOString(),
        basis: `Offerable until ${config.minimumRefillLeadMinutes} minutes before the slot starts.`,
      },
      // No impact on purpose: nothing records what a refilled slot would earn.
      impact: null,
      priority,
      priorityReason: `Starts in ${Math.round(startsInHours)} hour(s) (high within ${config.freedSlotHighWithinHours}, medium within ${config.freedSlotMediumWithinHours}).`,
      relatedCategories: RELATED[type],
      constraintId: linkedConstraint(type, input.constraints),
      overlapsWith: [],
      actionPlan: plan(
        input,
        `opportunity.${type}.${slot.id}`,
        id,
        "Refill a freed slot",
        priority,
        startsInHours <= 24 ? WorkflowTimeframe.TODAY : WorkflowTimeframe.THIS_WEEK,
        type,
        FREED_SLOT_STEPS,
        candidates.map((p) => p.patientId),
      ),
      detectedAt: input.now,
    });
  }

  return results.length === 0
    ? none("not_detected", "Freed slots are open, but no contactable patient other than the one who cancelled is waiting.")
    : { opportunities: results, assessment: emitted(type, results.length, "A still-open freed slot and waiting patients were both measured.") };
}

// ── unpaid_delivered_work ───────────────────────────────────────────────────

function detectUnpaidWork(
  input: OpportunityEngineInput,
  config: OpportunityConfig,
): { opportunity: Opportunity | null; assessment: OpportunityAssessment } {
  const type = OpportunityType.UNPAID_DELIVERED_WORK;
  if (input.openWork === null) {
    return notEmitted(type, "insufficient_data", "The open-work ledger was not read.");
  }
  const truncated = input.openWork.slice.truncated;
  if (truncated.includes(LedgerFactKind.TREATMENT) || truncated.includes(LedgerFactKind.PAYMENT)) {
    return notEmitted(type, "insufficient_data", "A balance cannot be judged from part of a ledger, and the charge or payment read was cut.");
  }

  const population = owingPatients(input.openWork, input.date);
  const actionable = population.owing.filter((p) => !p.onPaymentPlan);
  const onPlan = population.owing.filter((p) => p.onPaymentPlan);
  const actionableAmount = actionable.reduce((sum, p) => sum + p.outstanding, 0);
  if (actionableAmount <= 0) {
    return notEmitted(
      type,
      "not_detected",
      onPlan.length > 0
        ? "Every recorded balance belongs to a patient on an agreed payment plan."
        : "No patient's recorded charges exceed their recorded payments.",
    );
  }

  const id = opportunityId(type, input);
  const delivered = actionable.reduce((sum, p) => sum + p.charged, 0);
  const aged = actionable.filter((p) => (p.daysSinceLatestDelivery ?? 0) >= config.agedBalanceDays);
  const agedAmount = aged.reduce((sum, p) => sum + p.outstanding, 0);
  const priority = aged.length > 0 ? Priority.MEDIUM : Priority.LOW;

  const basis = ["Charges and payments are both recorded, and balances are clamped per patient."];
  let confidence = 1 - config.penalties.discountsUnrecorded;
  basis.push("Discounts and write-offs are not recorded, so part of a balance may be an intended reduction.");
  if (population.lowerBound) {
    confidence -= config.penalties.demandLowerBound;
    basis.push("Part of the open-work population could not be read, so the amount owed is at least the figure shown.");
  }

  const opportunity: Opportunity = {
    id,
    type,
    clinicId: input.clinicId,
    date: input.date,
    title: "Delivered work with a recorded balance still owed",
    measuredValue: qty(actionableAmount, "currency", "owed for delivered work, excluding agreed payment plans"),
    surplus: {
      description: "Work already delivered and charged to the patients who still owe for it.",
      measured: [
        qty(delivered, "currency", "charged for delivered work to these patients"),
        qty(actionable.reduce((sum, p) => sum + p.deliveredTreatments, 0), "treatments", "charged treatments behind it"),
      ],
      lowerBound: population.lowerBound,
    },
    demand: {
      description: "Recorded charges less recorded payments, per patient.",
      measured: [
        qty(actionableAmount, "currency", "owed, excluding agreed payment plans"),
        qty(actionable.length, "patients", "patients owing"),
        qty(agedAmount, "currency", `owed by patients whose latest charged work is ${config.agedBalanceDays}+ days old`),
        qty(onPlan.reduce((sum, p) => sum + p.outstanding, 0), "currency", "also owed, but under an agreed payment plan"),
      ],
      lowerBound: population.lowerBound,
    },
    entities: actionable.map((p) => ({
      type: EntityType.PATIENT,
      id: p.patientId,
      facts: {
        outstanding: p.outstanding,
        charged: p.charged,
        paid: p.paid,
        daysSinceLatestDelivery: p.daysSinceLatestDelivery,
        contactable: p.contactable,
      },
    })),
    entityOrdering: "unranked",
    confidence: round2(Math.max(0, confidence)),
    confidenceBasis: basis,
    evidence: [
      evidence(id, "demand", `${actionable.length} patient(s) owe a combined ${actionableAmount}; ${aged.length} of them for work ${config.agedBalanceDays}+ days old.`, { actionableAmount, agedAmount }, input.now),
      evidence(id, "excluded", `${onPlan.length} patient(s) on an agreed payment plan are left out of the actionable amount.`, { onPlan: onPlan.length }, input.now),
    ],
    window: {
      opensAt: input.now,
      expiresAt: null,
      basis: "A recorded balance has no deadline; age is reported instead.",
    },
    impact: {
      amount: qty(actionableAmount, "currency", "recorded balance owed"),
      basis: "recorded_value",
      statement: "Recorded charges less recorded payments. It is money owed on the books, not a prediction of what will be collected.",
    },
    priority,
    priorityReason:
      aged.length > 0
        ? `${aged.length} balance(s) are for work ${config.agedBalanceDays}+ days old.`
        : `Every balance is for work less than ${config.agedBalanceDays} days old.`,
    relatedCategories: RELATED[type],
    constraintId: linkedConstraint(type, input.constraints),
    overlapsWith: [],
    actionPlan: plan(
      input,
      `opportunity.${type}`,
      id,
      "Collect recorded balances for delivered work",
      priority,
      WorkflowTimeframe.ONGOING,
      type,
      UNPAID_WORK_STEPS,
      actionable.filter((p) => p.contactable).map((p) => p.patientId),
    ),
    detectedAt: input.now,
  };
  return { opportunity, assessment: emitted(type, 1, "Delivered charges and an unpaid balance were both measured.") };
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Why the surplus side cannot be measured, or null when it can. A truncated
 * schedule is refused rather than read as a lower bound: missing appointments
 * would make the week look emptier than it is.
 */
function surplusUnavailable(input: OpportunityEngineInput): string | null {
  if (input.capacity === null) return "Published capacity was not read.";
  if (input.schedule === null) return "The forward appointment book was not read.";
  if (!input.capacity.availabilityConfigured) return "The clinic has no active availability rules, so open time is unknown.";
  if (input.schedule.slice.truncated.includes(LedgerFactKind.APPOINTMENT)) {
    return "The forward appointment read hit its row limit, and a partial book would overstate free time.";
  }
  if (input.capacity.clinicId !== input.clinicId || input.schedule.slice.clinicId !== input.clinicId) {
    return "Capacity or schedule belongs to a different clinic.";
  }
  return null;
}

function notEmitted(
  type: Opportunity["type"],
  outcome: "not_detected" | "insufficient_data",
  reason: string,
): { opportunity: null; assessment: OpportunityAssessment } {
  return { opportunity: null, assessment: { type, outcome, reason, detected: 0 } };
}

function emitted(type: Opportunity["type"], detected: number, reason: string): OpportunityAssessment {
  return { type, outcome: "detected", reason, detected };
}

function opportunityId(type: string, input: OpportunityEngineInput): string {
  return `opportunity.${type}:${input.clinicId}:${input.date}`;
}

/**
 * The constraint about the same resource, most specific category first.
 *
 * RELATED lists categories from the closest description of the resource to the
 * loosest, so a forward match lands on next week's finding before today's idle
 * chair, even when today's finding is the more severe of the two.
 */
function linkedConstraint(type: Opportunity["type"], constraints: readonly Constraint[]): string | null {
  for (const category of RELATED[type]) {
    const match = constraints.find((c) => c.category === category);
    if (match !== undefined) return match.id;
  }
  return null;
}

function qty(value: number, unit: OpportunityQuantity["unit"], label: string): OpportunityQuantity {
  return { value: round2(value), unit, label };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function evidence(id: string, part: string, description: string, data: unknown, now: string): Evidence {
  return { id: `${id}#e.${part}`, source: SOURCE, description, data, capturedAt: now };
}

function waitingEntity(p: WaitingPatient): OpportunityEntity {
  return {
    type: EntityType.PATIENT,
    id: p.patientId,
    facts: {
      pools: p.pools.join(","),
      plannedTreatments: p.plannedTreatments,
      plannedValue: p.plannedValue,
      oldestPlanAgeDays: p.oldestPlanAgeDays,
      mostDaysOverdue: p.mostDaysOverdue,
    },
  };
}

function plan(
  input: OpportunityEngineInput,
  key: string,
  opportunityIdValue: string,
  title: string,
  priority: Priority,
  timeframe: WorkflowTimeframe,
  type: Opportunity["type"],
  steps: readonly ActionPlanStep[],
  patientIds: readonly string[],
): ActionPlan {
  const built = prepareActionPlan(
    {
      key,
      id: opportunityIdValue,
      title,
      priority,
      owner: WorkflowOwner.RECEPTIONIST,
      timeframe,
      constraintId: linkedConstraint(type, input.constraints) ?? opportunityIdValue,
      strategyId: opportunityIdValue,
      workflowId: opportunityIdValue,
      involvedEntities: patientIds.map((id) => ({ type: EntityType.PATIENT, id })),
    },
    steps,
    input.clinicId,
    input.date,
    input.now,
  );
  // Unreachable while every step names a catalog capability — which
  // opportunity-engine.spec.ts asserts.
  if (built === null) throw new Error(`Opportunity plan ${key} produced no actions.`);
  return built;
}
