/**
 * Minimal producer objects for the findings specs. Each builder fills only the
 * fields the normaliser reads; everything a producer decides is set explicitly
 * by the test that depends on it.
 */

import type {
  Achievement,
  ActionPlan,
  Constraint,
  ConstraintCategory,
  Diagnosis,
  Opportunity,
  Outcome,
  Value,
  Workflow,
} from "../../../domain";
import type { FindingSources } from "../normalize";

export const CLINIC = "clinic_a";
export const OTHER = "clinic_b";
export const DATE = "2026-09-14";
export const NOW = "2026-09-14T08:00:00.000Z";

export const hoursFromNow = (h: number) => new Date(Date.parse(NOW) + h * 3_600_000).toISOString();

export function constraint(
  category: ConstraintCategory,
  severity: Constraint["severity"],
  over: Partial<Constraint> = {},
): Constraint {
  return {
    id: `constraint.${category}:${over.id === undefined ? CLINIC : "x"}:${DATE}`,
    name: `${category} constraint`,
    description: "",
    category,
    severity,
    relatedDiagnosisIds: [`diagnosis.${category}:${CLINIC}:${DATE}`],
    identifiedAt: NOW,
    ...over,
  };
}

export function diagnosis(
  category: string,
  over: {
    severity?: string;
    confidence?: number;
    persistence?: Diagnosis["persistence"];
    consecutiveDays?: number;
    cappedByUnknown?: boolean;
    pattern?: string;
    hypotheses?: { id: string; status: string }[];
    id?: string;
  } = {},
): Diagnosis {
  return {
    id: over.id ?? `diagnosis.${category}:${CLINIC}:${DATE}`,
    pattern: over.pattern ?? category,
    severity: over.severity ?? "medium",
    confidence: over.confidence ?? 0.8,
    persistence: over.persistence ?? "sustained",
    persistenceDetail: {
      consecutiveDays: over.consecutiveDays ?? 1,
      priorFiredDays: 0,
      unknownDays: 0,
      historyDaysSupplied: 7,
      cappedByUnknown: over.cappedByUnknown ?? false,
    },
    hypotheses: over.hypotheses ?? [],
  } as unknown as Diagnosis;
}

export function workflow(constraintId: string, timeframe: Workflow["timeframe"]): Workflow {
  return { id: `workflow:${constraintId}`, constraintId, timeframe } as unknown as Workflow;
}

export function plan(constraintId: string): ActionPlan {
  return {
    id: `plan:${constraintId}`,
    constraintId,
    actions: [{ id: `action:${constraintId}` }],
    primaryActionId: `action:${constraintId}`,
  } as unknown as ActionPlan;
}

export function value(amount: number, unit: Value["unit"], description = "at stake"): Value {
  return { id: "v", type: "revenue", amount, unit, description, measuredAt: NOW } as unknown as Value;
}

export function opportunity(over: {
  id?: string;
  type?: Opportunity["type"];
  clinicId?: string;
  priority?: Opportunity["priority"];
  confidence?: number;
  expiresAt?: string | null;
  patients?: number;
  minutes?: number | null;
  constraintId?: string | null;
  overlapsWith?: string[];
  impact?: number | null;
  lowerBound?: boolean;
}): Opportunity {
  const type = over.type ?? "forward_capacity_match";
  return {
    id: over.id ?? `opportunity.${type}:${over.clinicId ?? CLINIC}:${DATE}`,
    type,
    clinicId: over.clinicId ?? CLINIC,
    date: DATE,
    title: `${type} opportunity`,
    measuredValue: { value: 4, unit: "appointments", label: "bookings supportable" },
    surplus: {
      description: "",
      measured: over.minutes === null ? [] : [{ value: over.minutes ?? 372, unit: "minutes", label: "unused chair time" }],
      lowerBound: false,
    },
    demand: { description: "", measured: [], lowerBound: over.lowerBound ?? false },
    entities: Array.from({ length: over.patients ?? 4 }, (_, i) => ({ type: "patient", id: `p${i}`, facts: {} })),
    entityOrdering: "unranked",
    confidence: over.confidence ?? 0.9,
    confidenceBasis: [],
    evidence: [],
    window: { opensAt: NOW, expiresAt: over.expiresAt === undefined ? hoursFromNow(72) : over.expiresAt, basis: "" },
    impact:
      over.impact === null || over.impact === undefined
        ? null
        : { amount: { value: over.impact, unit: "currency", label: "recorded planned value" }, basis: "recorded_value", statement: "" },
    priority: over.priority ?? "medium",
    priorityReason: "",
    relatedCategories: [],
    constraintId: over.constraintId ?? null,
    overlapsWith: over.overlapsWith ?? [],
    actionPlan: { actions: [{ id: "a" }], primaryActionId: "a", timeframe: "this_week" },
    detectedAt: NOW,
  } as unknown as Opportunity;
}

export function achievement(metricKey: string, over: Partial<Achievement> = {}): Achievement {
  return {
    id: `achievement.${metricKey}:${CLINIC}:${DATE}`,
    metricKey,
    dimension: "attendance",
    current: 5,
    baseline: 10,
    delta: -5,
    bandEdge: 8,
    observations: 14,
    consecutiveDays: 3,
    sustained: true,
    confidence: 0.9,
    measuredAt: NOW,
    ...over,
  } as Achievement;
}

export function outcome(metricKey: string, improved: boolean, attribution: Outcome["attribution"] = "observed_after"): Outcome {
  return {
    id: `outcome.${metricKey}`,
    completionId: "c1",
    category: "retention",
    constraintId: `constraint.retention:${CLINIC}:2026-09-10`,
    status: "completed",
    source: "declared",
    completedAt: "2026-09-10T09:00:00.000Z",
    attribution,
    metric: { key: metricKey, before: 12, after: improved ? 3 : 15, delta: improved ? -9 : 3, improved },
  } as unknown as Outcome;
}

export function sources(over: Partial<FindingSources> = {}): FindingSources {
  return {
    clinicId: CLINIC,
    date: DATE,
    constraints: [],
    diagnoses: [],
    valueAtStake: new Map(),
    workflows: [],
    actionPlans: [],
    opportunities: [],
    achievements: [],
    ...over,
  };
}

/** A constraint with its diagnosis, workflow and plan — what the pipeline would emit together. */
export function problem(
  category: ConstraintCategory,
  severity: Constraint["severity"],
  over: {
    confidence?: number;
    persistence?: Diagnosis["persistence"];
    consecutiveDays?: number;
    timeframe?: Workflow["timeframe"];
    value?: Value;
    actionable?: boolean;
    cappedByUnknown?: boolean;
  } = {},
) {
  const c = constraint(category, severity);
  return {
    constraint: c,
    diagnosis: diagnosis(category, {
      severity,
      confidence: over.confidence,
      persistence: over.persistence,
      consecutiveDays: over.consecutiveDays,
      cappedByUnknown: over.cappedByUnknown,
    }),
    workflow: workflow(c.id, over.timeframe ?? "this_week"),
    plan: over.actionable === false ? null : plan(c.id),
    value: over.value,
  };
}

export function withProblems(
  problems: ReturnType<typeof problem>[],
  over: Partial<FindingSources> = {},
): FindingSources {
  return sources({
    constraints: problems.map((p) => p.constraint),
    diagnoses: [...problems.map((p) => p.diagnosis), ...(over.diagnoses ?? [])],
    workflows: problems.map((p) => p.workflow),
    actionPlans: problems.flatMap((p) => (p.plan ? [p.plan] : [])),
    valueAtStake: new Map(problems.flatMap((p) => (p.value ? [[p.constraint.id, [p.value]] as const] : []))),
    ...over,
    ...(over.diagnoses ? { diagnoses: [...problems.map((p) => p.diagnosis), ...over.diagnoses] } : {}),
  });
}
