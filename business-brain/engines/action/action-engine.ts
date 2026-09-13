/**
 * Business Brain — Action Engine
 *
 * The last stage of the pipeline. It converts workflows into the specific things
 * DentGrow can prepare so the clinic does less work to complete them.
 *
 *   Strategy  WHAT should be done.
 *   Workflow  HOW the clinic should approach it.
 *   Action    HOW DENTGROW helps execute it.
 *
 * ## It does not think
 *
 * By the time a workflow arrives, every business judgement has been made: the
 * signals fired, the diagnosis settled a cause or admitted it could not, a
 * constraint grouped the findings, the Value Engine sized them, a strategy
 * decided what to do, and the workflow decided how, who and when. This engine
 * adds none of that. `priority`, `owner` and `timeframe` are copied off the
 * workflow verbatim, and there is no branch anywhere in this file that reads a
 * metric, a signal or a diagnosis.
 *
 * What it does is a table lookup: workflow template key → an ordered list of
 * catalog capabilities → concrete actions, with the run's date windows filled in.
 * A pure function of (workflows, clinicId, date, now).
 *
 * ## It prepares work; it never performs it
 *
 * No sends, no writes, no jobs, no network, no model. A draft is text with
 * `state: "draft"` sitting in the UI; a target is somewhere to go, not a request
 * to make. Every action is emitted with `channel: "in_app"` and
 * `execution: "prepare_only"`, and `action-engine.spec.ts` fails if one ever is
 * not — which is what makes this a guarantee rather than an intention.
 *
 * ## Determinism
 *
 * Same workflows, same clinic, same date → byte-identical plans. `now` is passed
 * in; nothing here reads a clock, a random source or a database.
 */

import {
  ActionExecution,
  ActionChannel,
  type Action,
  type ActionPlan,
  type RelatedEntity,
  type Workflow,
  type WorkflowOwner,
  type WorkflowTimeframe,
} from "../../domain";
import type { Priority } from "../../types";
import { ACTION_CATALOG, buildDraft, type ActionCapability } from "./action-catalog";
import { ACTION_PLANS, type ActionPlanStep } from "./action-plans";
import { actionDateWindows } from "./action-dates";

/**
 * Whatever a plan of prepared actions serves, reduced to what the plan copies.
 *
 * A workflow is one source; an opportunity is another. Both hand over their
 * already-decided priority, owner, timeframe and provenance, and this engine
 * builds identical kinds of action from either — which is what keeps an
 * opportunity from growing a parallel action system of its own.
 */
export interface ActionPlanSource {
  /** Template key: a workflow template, or `opportunity.<type>`. */
  readonly key: string;
  readonly id: string;
  readonly title: string;
  readonly priority: Priority;
  readonly owner: WorkflowOwner;
  readonly timeframe: WorkflowTimeframe;
  readonly constraintId: string;
  readonly strategyId: string;
  readonly workflowId: string;
  readonly involvedEntities: readonly RelatedEntity[];
}

export interface ActionResult {
  /** One plan per workflow that has a mapping, in the workflows' own order. */
  readonly plans: readonly ActionPlan[];
}

/**
 * Turn workflows into ready-to-use action plans.
 *
 * Workflow order is preserved rather than re-sorted. The Workflow Engine already
 * ordered by priority and then by urgency; re-ranking here would be this engine
 * making a judgement, which is precisely what it must not do.
 *
 * A workflow with no plan entry is skipped in silence. That path is unreachable
 * in practice — `action-coverage.spec.ts` asserts every template key has a plan —
 * and skipping rather than inventing a generic plan is the right failure: a
 * plausible-looking shortcut to the wrong screen costs more trust than an absent
 * one.
 *
 * @param workflows The execution plans to prepare help for.
 * @param clinicId  Scoping identifier.
 * @param date      The business date, already resolved in the clinic's timezone.
 * @param now       ISO-8601 creation timestamp (injected for determinism).
 */
export function generateActions(
  workflows: readonly Workflow[],
  clinicId: string,
  date: string,
  now: string,
): ActionResult {
  const plans: ActionPlan[] = [];

  for (const workflow of workflows) {
    const steps = ACTION_PLANS[workflow.templateKey];
    if (steps === undefined || steps.length === 0) continue;
    const plan = prepareActionPlan(
      {
        key: workflow.templateKey,
        id: workflow.id,
        title: workflow.title,
        priority: workflow.priority,
        owner: workflow.owner,
        timeframe: workflow.timeframe,
        constraintId: workflow.constraintId,
        strategyId: workflow.strategyId,
        workflowId: workflow.id,
        involvedEntities: workflow.involvedEntities,
      },
      steps,
      clinicId,
      date,
      now,
    );
    if (plan !== null) plans.push(plan);
  }

  return { plans };
}

/**
 * Build one plan of prepared actions from catalog steps.
 *
 * Returns null when no step names a real capability. Every action carries
 * `channel: in_app` and `execution: prepare_only`, whoever the source is.
 */
export function prepareActionPlan(
  source: ActionPlanSource,
  steps: readonly ActionPlanStep[],
  clinicId: string,
  date: string,
  now: string,
): ActionPlan | null {
  if (steps.length === 0) return null;
  const windows = actionDateWindows(date);

  // Ids are resolved in one pass first, so `dependsOn` can reference sibling
  // action ids rather than capability names — the UI should never have to
  // re-derive an id to draw a dependency.
  const idFor = new Map<string, string>();
  for (const step of steps) {
    idFor.set(step.capability, actionId(source.key, step.capability, clinicId, date));
  }

  const actions: Action[] = [];
  steps.forEach((step, index) => {
    const capability = ACTION_CATALOG.get(step.capability);
    // A step naming a capability that does not exist is a coverage failure, not
    // something to paper over at runtime.
    if (capability === undefined) return;
    actions.push(buildAction(step, capability, source, index + 1, idFor, clinicId, date, now, windows));
  });

  if (actions.length === 0) return null;

  const primaryStep = steps.find((s) => s.primary === true);
  const primaryActionId =
    primaryStep !== undefined ? (idFor.get(primaryStep.capability) ?? null) : actions[0].id;

  return {
    id: `plan.${source.key}:${clinicId}:${date}`,
    workflowId: source.workflowId,
    workflowKey: source.key,
    workflowTitle: source.title,
    priority: source.priority,
    owner: source.owner,
    timeframe: source.timeframe,
    constraintId: source.constraintId,
    strategyId: source.strategyId,
    actions,
    primaryActionId,
    createdAt: now,
  };
}

function actionId(
  workflowKey: string,
  capability: string,
  clinicId: string,
  date: string,
): string {
  return `action.${workflowKey}.${capability}:${clinicId}:${date}`;
}

function buildAction(
  step: ActionPlanStep,
  capability: ActionCapability,
  workflow: ActionPlanSource,
  order: number,
  idFor: ReadonlyMap<string, string>,
  clinicId: string,
  date: string,
  now: string,
  windows: ReturnType<typeof actionDateWindows>,
): Action {
  const catalogFilters = capability.filters?.(windows) ?? {};

  return {
    id: idFor.get(step.capability) ?? actionId(workflow.key, step.capability, clinicId, date),
    capability: capability.id,
    kind: capability.kind,
    category: capability.category,
    title: step.title ?? capability.title,
    description: step.description ?? capability.description,
    order,
    // Copied, never computed. This engine has no opinion on urgency.
    priority: workflow.priority,
    // A role-bound capability wins: changing a clinic-wide rule is the dentist's
    // job whoever owns the workflow it belongs to.
    owner: capability.owner ?? workflow.owner,
    effort: capability.effort,
    readiness: capability.readiness,
    target: {
      area: step.area ?? capability.area,
      // Plan overrides last: a plan narrowing a shared list is the specific case.
      filters: { ...catalogFilters, ...(step.filters ?? {}) },
      sortHint: capability.sortHint,
    },
    draft: buildDraft(capability),
    requires: capability.requires,
    delivery: {
      // Fixed for this phase, and asserted by test. Widening these is the whole
      // of what "add a channel" means later — see the Action domain header.
      channel: ActionChannel.IN_APP,
      execution: ActionExecution.PREPARE_ONLY,
      supportedChannels: capability.supportedChannels,
    },
    expectedImpact: {
      statement: capability.impact,
      valueType: capability.valueType,
    },
    dependsOn: (step.after ?? [])
      .map((c) => idFor.get(c))
      .filter((id): id is string => id !== undefined),
    // Empty until the Action Engine is given a record-level context port. Stated
    // as an empty list rather than omitted: "we did not identify anyone" and
    // "there is nobody" are different, and the UI must not read the first as the
    // second.
    involvedEntities: workflow.involvedEntities,
    workflowId: workflow.id,
    strategyId: workflow.strategyId,
    constraintId: workflow.constraintId,
    createdAt: now,
  };
}
