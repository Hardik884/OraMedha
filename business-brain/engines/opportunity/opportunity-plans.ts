/**
 * Business Brain — Opportunity Engine: prepared work per opportunity
 *
 * Steps from the EXISTING capability catalog — no new screens, no new drafts,
 * no second action system. The Action Engine's `prepareActionPlan` turns these
 * into the same prepared, never-performed actions every workflow gets.
 *
 * Steps are conditional on what was measured: a forward match whose waiting
 * patients are all overdue recalls does not open the planned-treatment list,
 * because that screen would show nobody the opportunity is about.
 */

import { DentGrowArea } from "../../domain";
import { Capability } from "../action/action-catalog";
import type { ActionPlanStep } from "../action/action-plans";

export function forwardCapacitySteps(pools: {
  readonly planned: boolean;
  readonly recall: boolean;
}): readonly ActionPlanStep[] {
  return [
    {
      capability: Capability.OPEN_WEEK_SCHEDULE,
      primary: true,
      title: "See where next week's open gaps are",
    },
    ...(pools.planned
      ? [
          {
            capability: Capability.OPEN_PLANNED_TREATMENTS,
            title: "Open patients with planned treatment and nothing booked",
          },
        ]
      : []),
    ...(pools.recall
      ? [
          {
            capability: Capability.OPEN_OVERDUE_FOLLOW_UPS,
            title: "Open patients whose recall is overdue",
          },
        ]
      : []),
    {
      capability: Capability.PREPARE_CALL_LIST,
      title: "Call them and offer a specific gap",
      area: pools.planned ? DentGrowArea.TREATMENTS : DentGrowArea.FOLLOW_UPS,
      after: [Capability.OPEN_WEEK_SCHEDULE],
    },
    {
      capability: Capability.OPEN_APPOINTMENT_SCHEDULER,
      title: "Book each patient who agrees, on the call",
    },
  ];
}

export const FREED_SLOT_STEPS: readonly ActionPlanStep[] = [
  {
    capability: Capability.OPEN_APPOINTMENT_SCHEDULER,
    primary: true,
    title: "Offer the freed slot before it passes",
  },
  {
    capability: Capability.DRAFT_STANDBY_SLOT_OFFER,
    title: "Prepare the slot offer",
  },
  {
    capability: Capability.PREPARE_CALL_LIST,
    title: "Call patients waiting for a booking",
    area: DentGrowArea.TREATMENTS,
  },
];

export const UNPAID_WORK_STEPS: readonly ActionPlanStep[] = [
  { capability: Capability.OPEN_OUTSTANDING_BALANCES, primary: true },
  { capability: Capability.DRAFT_PAYMENT_REMINDER },
  { capability: Capability.OPEN_PATIENT_LEDGER, title: "Check each balance against the ledger first" },
  {
    capability: Capability.RECORD_PAYMENT,
    title: "Record anything already paid but not entered",
    after: [Capability.OPEN_OUTSTANDING_BALANCES],
  },
];
