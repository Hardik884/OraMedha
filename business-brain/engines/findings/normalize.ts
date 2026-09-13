/**
 * Business Brain — Findings: normalisation
 *
 * Converts what each existing producer already emitted into one Finding shape.
 * It decides nothing any producer did not already decide: which constraints
 * exist, what an opportunity measured, which improvements cleared their gates.
 * What it adds is a common vocabulary — kind, resource, and evidence fields the
 * prioritiser can compare — and a statement of the data gaps behind each figure.
 *
 * Tenant isolation is checked here, at the door: a source object that names a
 * different clinic stops normalisation outright.
 */

import {
  ConstraintCategory,
  FindingKind,
  FindingResource,
  OpportunityType,
  WorkflowTimeframe,
  type Achievement,
  type ActionPlan,
  type Constraint,
  type DataQualityNote,
  type Diagnosis,
  type Finding,
  type FindingEvidence,
  type FindingMeasure,
  type FindingTrend,
  type MetricTrajectory,
  type Opportunity,
  type Outcome,
  type RootCauseAnalysis,
  type Value,
  type Workflow,
  TrajectoryState,
} from "../../domain";
import { FINDINGS_CONFIG } from "./findings-config";

export class FindingIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindingIntegrityError";
  }
}

export interface FindingSources {
  readonly clinicId: string;
  readonly date: string;
  readonly constraints: readonly Constraint[];
  readonly diagnoses: readonly Diagnosis[];
  readonly valueAtStake: ReadonlyMap<string, readonly Value[]>;
  readonly workflows: readonly Workflow[];
  readonly actionPlans: readonly ActionPlan[];
  readonly opportunities: readonly Opportunity[];
  readonly achievements: readonly Achievement[];
  /** Action outcomes, when the caller has loaded them. */
  readonly outcomes?: readonly Outcome[];
  /** Metric trajectories from the Trajectory Engine, when the run produced them. */
  readonly trajectories?: readonly MetricTrajectory[];
  /** Root-cause analyses, each naming the finding it belongs to. */
  readonly rootCauses?: readonly RootCauseAnalysis[];
}

// ── trajectories ────────────────────────────────────────────────────────────

/** States worth attaching to a finding. New, stable and insufficient say nothing yet. */
const SURFACED_STATES: ReadonlySet<string> = new Set([
  TrajectoryState.WORSENING,
  TrajectoryState.PERSISTENT,
  TrajectoryState.IMPROVING,
  TrajectoryState.RECOVERING,
  TrajectoryState.RESOLVED,
]);

/** Worst first: the order a group's lead trajectory is chosen in. */
function trajectoryWeight(t: MetricTrajectory): number {
  if (t.state === TrajectoryState.WORSENING) return t.conflict === "worsening_within_normal_range" ? 3 : 5;
  if (t.state === TrajectoryState.PERSISTENT) return 4;
  if (t.state === TrajectoryState.IMPROVING) return 2;
  if (t.state === TrajectoryState.RECOVERING) return 1;
  return 0;
}

export function orderTrajectories(list: readonly MetricTrajectory[]): readonly MetricTrajectory[] {
  return [...list].sort(
    (a, b) =>
      trajectoryWeight(b) - trajectoryWeight(a) ||
      b.confidence - a.confidence ||
      (a.metricKey < b.metricKey ? -1 : a.metricKey > b.metricKey ? 1 : 0),
  );
}

function trendOfTrajectory(t: MetricTrajectory): FindingTrend {
  if (t.state === TrajectoryState.WORSENING) return "worsening";
  if (t.state === TrajectoryState.PERSISTENT) return "steady";
  if (t.state === TrajectoryState.IMPROVING || t.state === TrajectoryState.RECOVERING || t.state === TrajectoryState.RESOLVED) {
    return "improving";
  }
  return "unknown";
}

/**
 * A trajectory-only finding's severity, from its state — the only thing the
 * trajectory can speak to. A deterioration still inside the normal range is low;
 * one outside it, or a lasting one, is medium; recovery is informational. Never
 * high: a trajectory alone has no measured stake behind it.
 */
function trajectorySeverity(t: MetricTrajectory): Constraint["severity"] {
  if (t.state === TrajectoryState.WORSENING) return t.conflict === "worsening_within_normal_range" ? "low" : "medium";
  if (t.state === TrajectoryState.PERSISTENT) return "medium";
  if (t.state === TrajectoryState.IMPROVING) return "low";
  return "info";
}

const STATE_TITLE: Readonly<Record<string, string>> = {
  worsening: "worsening",
  persistent: "persistently worse than normal",
  improving: "worse than normal but improving",
  recovering: "recovering",
  resolved: "back to normal",
};

/**
 * The kind of a constraint, by the TENSE of what its category measures.
 *
 * A fixed table rather than a rule, so reclassifying a category is a reviewed
 * one-line change rather than behaviour that emerges from thresholds.
 */
export const CONSTRAINT_KIND: Readonly<Record<ConstraintCategory, FindingKind>> = {
  // Already happened: money not collected, work not booked, a day's chair time
  // gone, appointments lost, patients who did not return or register.
  [ConstraintCategory.REVENUE_LEAKAGE]: FindingKind.PROBLEM,
  [ConstraintCategory.TREATMENT_ACCEPTANCE]: FindingKind.PROBLEM,
  [ConstraintCategory.CAPACITY]: FindingKind.PROBLEM,
  [ConstraintCategory.SCHEDULING]: FindingKind.PROBLEM,
  [ConstraintCategory.RETENTION]: FindingKind.PROBLEM,
  [ConstraintCategory.REACTIVATION]: FindingKind.PROBLEM,
  [ConstraintCategory.ACQUISITION]: FindingKind.PROBLEM,
  // Standing process conditions that keep costing while they last.
  [ConstraintCategory.PATIENT_FLOW]: FindingKind.OPERATIONAL_RISK,
  [ConstraintCategory.SCHEDULE_ACCURACY]: FindingKind.OPERATIONAL_RISK,
  // A measured shortfall in time still ahead. Measured, not forecast.
  [ConstraintCategory.FORWARD_SCHEDULE]: FindingKind.EARLY_WARNING,
};

export const CONSTRAINT_RESOURCE: Readonly<Record<ConstraintCategory, FindingResource>> = {
  [ConstraintCategory.REVENUE_LEAKAGE]: FindingResource.RECEIVABLES,
  [ConstraintCategory.TREATMENT_ACCEPTANCE]: FindingResource.PLANNED_TREATMENT,
  [ConstraintCategory.CAPACITY]: FindingResource.CHAIR_TIME_TODAY,
  [ConstraintCategory.SCHEDULING]: FindingResource.LOST_APPOINTMENTS,
  [ConstraintCategory.RETENTION]: FindingResource.RECALL,
  [ConstraintCategory.REACTIVATION]: FindingResource.LAPSED_PATIENTS,
  [ConstraintCategory.ACQUISITION]: FindingResource.NEW_PATIENTS,
  [ConstraintCategory.PATIENT_FLOW]: FindingResource.PATIENT_FLOW,
  [ConstraintCategory.SCHEDULE_ACCURACY]: FindingResource.BOOKING_TEMPLATE,
  [ConstraintCategory.FORWARD_SCHEDULE]: FindingResource.CHAIR_TIME_AHEAD,
};

const OPPORTUNITY_RESOURCE: Readonly<Record<Opportunity["type"], FindingResource>> = {
  [OpportunityType.FORWARD_CAPACITY_MATCH]: FindingResource.CHAIR_TIME_AHEAD,
  [OpportunityType.FREED_SLOT_REFILL]: FindingResource.CHAIR_TIME_AHEAD,
  [OpportunityType.UNPAID_DELIVERED_WORK]: FindingResource.RECEIVABLES,
};

const SEVERITY_RANK: Readonly<Record<string, number>> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

/** The `<clinic>` segment of an id shaped `<prefix>:<clinic>:<date>`. */
function clinicOf(id: string): string | null {
  const parts = id.split(":");
  return parts.length >= 3 ? parts[1] : null;
}

function assertClinic(sources: FindingSources, id: string, clinicId: string | null): void {
  if (clinicId !== sources.clinicId) {
    throw new FindingIntegrityError(
      `Source ${id} belongs to clinic ${clinicId ?? "(unknown)"}, not ${sources.clinicId}. Findings may never span tenants.`,
    );
  }
}

/** The diagnosis that drives a constraint's severity — the same rule the briefing uses. */
export function drivingDiagnosis(constraint: Constraint, diagnoses: readonly Diagnosis[]): Diagnosis | null {
  const ids = new Set(constraint.relatedDiagnosisIds ?? []);
  const contributing = diagnoses.filter((d) => ids.has(d.id));
  if (contributing.length === 0) return null;
  return contributing.reduce((worst, d) => {
    const a = SEVERITY_RANK[d.severity] ?? 0;
    const b = SEVERITY_RANK[worst.severity] ?? 0;
    if (a !== b) return a > b ? d : worst;
    return d.id < worst.id ? d : worst;
  });
}

function trendOf(diagnosis: Diagnosis | null): FindingTrend {
  switch (diagnosis?.persistence) {
    case "worsening":
      return "worsening";
    case "improving":
      return "improving";
    case "sustained":
      return "steady";
    default:
      return "unknown";
  }
}

/** Short words for what a Value measures. The Value's own description is a paragraph. */
const VALUE_LABEL: Readonly<Record<string, string>> = {
  revenue_recovered: "money at stake",
  hours_saved: "chair time at stake",
  appointments_booked: "appointments at stake",
  retention_improved: "patients at stake",
  other: "at stake",
};

function measureFromValue(value: Value | undefined): FindingMeasure | null {
  if (value === undefined) return null;
  const label = VALUE_LABEL[value.type] ?? "at stake";
  switch (value.unit) {
    case "currency":
    case "minutes":
    case "count":
    case "percentage":
    case "days":
      return { value: value.amount, unit: value.unit, label };
    case "hours":
      return { value: value.amount * 60, unit: "minutes", label };
    default:
      // A ratio has no unit a clinic can compare against anything else.
      return null;
  }
}

function applyPenalties(source: number, notes: readonly DataQualityNote[]): number {
  const penalised = notes.reduce((c, n) => c - n.penalty, source);
  return Math.round(Math.max(FINDINGS_CONFIG.confidenceFloor, penalised) * 100) / 100;
}

function timeframeOf(value: string | undefined): FindingEvidence["timeframe"] {
  switch (value) {
    case WorkflowTimeframe.TODAY:
      return "today";
    case WorkflowTimeframe.THIS_WEEK:
      return "this_week";
    case WorkflowTimeframe.SOON:
      return "soon";
    case WorkflowTimeframe.ONGOING:
      return "ongoing";
    default:
      return null;
  }
}

function fromConstraint(sources: FindingSources, constraint: Constraint): Finding {
  assertClinic(sources, constraint.id, clinicOf(constraint.id));
  const kind = CONSTRAINT_KIND[constraint.category];
  const driving = drivingDiagnosis(constraint, sources.diagnoses);
  const workflow = sources.workflows.find((w) => w.constraintId === constraint.id);
  const plan = sources.actionPlans.find((p) => p.constraintId === constraint.id && p.actions.length > 0);

  const notes: DataQualityNote[] = [];
  if (driving === null) {
    notes.push({ note: "No contributing diagnosis was found for this constraint.", penalty: FINDINGS_CONFIG.penalties.noContributingDiagnosis });
  } else {
    if (driving.persistence === "insufficient_history") {
      notes.push({ note: "Too little history to say whether it is new or lasting.", penalty: FINDINGS_CONFIG.penalties.insufficientHistory });
    }
    if (driving.persistenceDetail?.cappedByUnknown) {
      notes.push({ note: "Some recent days could not be measured, so its history is incomplete.", penalty: FINDINGS_CONFIG.penalties.unmeasuredDays });
    }
  }
  // A constraint with no diagnosis still has a severity someone decided; its
  // confidence starts from the middle rather than from nothing.
  const sourceConfidence = driving?.confidence ?? 0.5;

  // The trajectories of the metrics this constraint is about. Attached here —
  // never emitted as a second finding — so one issue stays one finding. A
  // confident weekly trajectory describes direction better than the day-level
  // persistence classification, so it supplies the trend; a thin one does not.
  const related = orderTrajectories(
    (sources.trajectories ?? []).filter((t) => t.category === constraint.category && SURFACED_STATES.has(t.state)),
  );
  const lead = related[0];
  const trend =
    lead !== undefined && lead.confidence >= FINDINGS_CONFIG.moderateConfidence ? trendOfTrajectory(lead) : trendOf(driving);

  return {
    id: `finding.${kind}:${constraint.id}`,
    kind,
    polarity: "negative",
    source: { producer: "constraint", id: constraint.id },
    clinicId: sources.clinicId,
    date: sources.date,
    title: constraint.name,
    resource: CONSTRAINT_RESOURCE[constraint.category],
    category: constraint.category,
    constraintId: constraint.id,
    evidence: {
      severity: constraint.severity,
      opportunityPriority: null,
      impact: measureFromValue(sources.valueAtStake.get(constraint.id)?.[0]),
      scope: [],
      expiresAt: null,
      timeframe: timeframeOf(workflow?.timeframe),
      persistence: driving?.persistence ?? null,
      consecutiveDays: driving?.persistenceDetail?.consecutiveDays ?? null,
      trend,
      confidence: applyPenalties(sourceConfidence, notes),
      sourceConfidence,
      dataQuality: notes,
      actionable: plan !== undefined,
      primaryActionId: plan?.primaryActionId ?? null,
      trajectories: related,
      lifecycle: lead?.lifecycle ?? null,
      rootCauses: [],
    },
  };
}

function fromOpportunity(sources: FindingSources, opportunity: Opportunity): Finding {
  assertClinic(sources, opportunity.id, opportunity.clinicId);
  const linked = opportunity.constraintId === null ? undefined : sources.constraints.find((c) => c.id === opportunity.constraintId);
  const patients = opportunity.entities.filter((e) => e.type === "patient").length;
  const minutes = opportunity.surplus.measured.find((q) => q.unit === "minutes");
  const scope: FindingMeasure[] = [];
  if (patients > 0) scope.push({ value: patients, unit: "patients", label: "patients affected" });
  if (minutes !== undefined) scope.push({ value: minutes.value, unit: "minutes", label: minutes.label });
  if (opportunity.measuredValue.unit === "appointments") {
    scope.push({ value: opportunity.measuredValue.value, unit: "appointments", label: opportunity.measuredValue.label });
  }

  const notes: DataQualityNote[] = [];
  if (opportunity.demand.lowerBound || opportunity.surplus.lowerBound) {
    // Already priced into the engine's confidence; recorded, not charged twice.
    notes.push({ note: "Part of the population could not be read, so its figures are lower bounds.", penalty: 0 });
  }
  const impact =
    opportunity.impact?.amount ??
    (opportunity.measuredValue.unit === "currency" ? opportunity.measuredValue : null);

  return {
    id: `finding.${FindingKind.OPPORTUNITY}:${opportunity.id}`,
    kind: FindingKind.OPPORTUNITY,
    polarity: "opportunity",
    source: { producer: "opportunity", id: opportunity.id },
    clinicId: sources.clinicId,
    date: sources.date,
    title: opportunity.title,
    resource: OPPORTUNITY_RESOURCE[opportunity.type],
    category: linked?.category ?? null,
    constraintId: linked?.id ?? null,
    evidence: {
      severity: null,
      opportunityPriority: opportunity.priority,
      impact: impact === null ? null : { value: impact.value, unit: impact.unit, label: impact.label },
      scope,
      expiresAt: opportunity.window.expiresAt,
      timeframe: timeframeOf(opportunity.actionPlan.timeframe),
      persistence: null,
      consecutiveDays: null,
      trend: "unknown",
      confidence: applyPenalties(opportunity.confidence, notes),
      sourceConfidence: opportunity.confidence,
      dataQuality: notes,
      actionable: opportunity.actionPlan.actions.length > 0,
      primaryActionId: opportunity.actionPlan.primaryActionId,
      trajectories: [],
      lifecycle: null,
      rootCauses: [],
    },
  };
}

function fromAchievement(sources: FindingSources, achievement: Achievement): Finding {
  assertClinic(sources, achievement.id, clinicOf(achievement.id));
  const notes: DataQualityNote[] = achievement.sustained
    ? []
    : [{ note: "Seen on a single day so far, not yet sustained.", penalty: FINDINGS_CONFIG.penalties.singleDay }];
  return {
    id: `finding.${FindingKind.WIN}:${achievement.id}`,
    kind: FindingKind.WIN,
    polarity: "positive",
    source: { producer: "achievement", id: achievement.id },
    clinicId: sources.clinicId,
    date: sources.date,
    title: `Better than usual: ${achievement.metricKey}`,
    resource: FindingResource.METRIC,
    category: null,
    constraintId: null,
    evidence: {
      severity: null,
      opportunityPriority: null,
      impact: null,
      scope: [],
      expiresAt: null,
      timeframe: null,
      persistence: null,
      consecutiveDays: achievement.consecutiveDays,
      trend: "improving",
      confidence: applyPenalties(achievement.confidence, notes),
      sourceConfidence: achievement.confidence,
      dataQuality: notes,
      actionable: false,
      primaryActionId: null,
      trajectories: [],
      lifecycle: null,
      rootCauses: [],
    },
  };
}

/**
 * An outcome becomes a win only when a measurable movement in the helpful
 * direction was observed after the action. It is still an observation in
 * sequence, never a claim that the action produced it.
 */
function fromOutcome(sources: FindingSources, outcome: Outcome): Finding | null {
  if (outcome.attribution !== "observed_after" || outcome.metric === undefined || !outcome.metric.improved) {
    return null;
  }
  assertClinic(sources, outcome.id, clinicOf(outcome.constraintId));
  return {
    id: `finding.${FindingKind.WIN}:${outcome.id}`,
    kind: FindingKind.WIN,
    polarity: "positive",
    source: { producer: "outcome", id: outcome.id },
    clinicId: sources.clinicId,
    date: sources.date,
    title: `Observed after a completed action: ${outcome.metric.key}`,
    resource: FindingResource.METRIC,
    category: outcome.category,
    constraintId: outcome.constraintId,
    evidence: {
      severity: null,
      opportunityPriority: null,
      impact: null,
      scope: outcome.targets && outcome.targets.verifiable
        ? [{ value: outcome.targets.confirmed, unit: "patients", label: "targeted patients showing the intended result" }]
        : [],
      expiresAt: null,
      timeframe: null,
      persistence: null,
      consecutiveDays: null,
      trend: "improving",
      // The rung is observed_after: the sequence is measured, nothing more. The
      // confidence says the reading was complete, not that the action worked.
      confidence: FINDINGS_CONFIG.highConfidence,
      sourceConfidence: FINDINGS_CONFIG.highConfidence,
      dataQuality: [],
      actionable: false,
      primaryActionId: null,
      trajectories: [],
      lifecycle: null,
      rootCauses: [],
    },
  };
}

/**
 * Early-warning findings for trajectories no constraint already represents.
 *
 * Grouped by constraint category (or by metric, for one with no category), so
 * the cancellation and no-show rates moving together are one warning about
 * attrition rather than two competing ones. A category that already has a
 * constraint gets nothing here: the constraint carries the trajectory instead.
 */
function fromTrajectories(sources: FindingSources): Finding[] {
  const constrained = new Set<string>(sources.constraints.map((c) => c.category));
  const groups = new Map<string, MetricTrajectory[]>();
  for (const t of sources.trajectories ?? []) {
    if (t.clinicId !== sources.clinicId) {
      throw new FindingIntegrityError(`Trajectory ${t.id} belongs to clinic ${t.clinicId}, not ${sources.clinicId}.`);
    }
    if (!SURFACED_STATES.has(t.state)) continue;
    if (t.category !== null && constrained.has(t.category)) continue;
    const group = t.category ?? t.metricKey;
    groups.set(group, [...(groups.get(group) ?? []), t]);
  }

  return [...groups.entries()].map(([group, members]) => {
    const ordered = orderTrajectories(members);
    const lead = ordered[0];
    const sourceId = `trajectory.${group}:${sources.clinicId}:${sources.date}`;
    const notes: DataQualityNote[] =
      lead.conflict === null
        ? []
        : [{ note: `The trajectory's readings disagree (${lead.conflict.replace(/_/g, " ")}); already reflected in its confidence.`, penalty: 0 }];
    return {
      id: `finding.${FindingKind.EARLY_WARNING}:${sourceId}`,
      kind: FindingKind.EARLY_WARNING,
      polarity: "negative",
      source: { producer: "trajectory", id: sourceId },
      clinicId: sources.clinicId,
      date: sources.date,
      title: `${lead.label}: ${STATE_TITLE[lead.state] ?? lead.state}`,
      resource: lead.category === null ? FindingResource.METRIC : CONSTRAINT_RESOURCE[lead.category],
      category: lead.category,
      constraintId: null,
      evidence: {
        severity: trajectorySeverity(lead),
        opportunityPriority: null,
        impact: null,
        scope: [],
        expiresAt: null,
        timeframe: null,
        persistence: null,
        consecutiveDays: lead.daysWorseThanNormal > 0 ? lead.daysWorseThanNormal : null,
        trend: trendOfTrajectory(lead),
        confidence: lead.confidence,
        sourceConfidence: lead.confidence,
        dataQuality: notes,
        // No action plan exists for a trajectory on its own; it says so rather
        // than borrowing one written for a different finding.
        actionable: false,
        primaryActionId: null,
        trajectories: ordered,
        lifecycle: lead.lifecycle,
        rootCauses: [],
      },
    } satisfies Finding;
  });
}

/** Every producer's output as Findings, in a stable order. */
export function normalizeFindings(sources: FindingSources): readonly Finding[] {
  for (const t of sources.trajectories ?? []) {
    if (t.clinicId !== sources.clinicId) {
      throw new FindingIntegrityError(`Trajectory ${t.id} belongs to clinic ${t.clinicId}, not ${sources.clinicId}.`);
    }
  }
  const findings: Finding[] = [
    ...sources.constraints.map((c) => fromConstraint(sources, c)),
    ...fromTrajectories(sources),
    ...sources.opportunities.map((o) => fromOpportunity(sources, o)),
    ...sources.achievements.map((a) => fromAchievement(sources, a)),
    ...(sources.outcomes ?? []).map((o) => fromOutcome(sources, o)).filter((f): f is Finding => f !== null),
  ];
  return attachRootCauses(sources, findings).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Root causes travel on the finding they explain. An analysis for another clinic,
 * or for a finding this run did not produce, is refused rather than dropped or
 * turned into a finding of its own.
 */
function attachRootCauses(sources: FindingSources, findings: Finding[]): Finding[] {
  const analyses = sources.rootCauses ?? [];
  if (analyses.length === 0) return findings;
  const ids = new Set(findings.map((f) => f.id));
  const byParent = new Map<string, RootCauseAnalysis[]>();
  for (const analysis of analyses) {
    if (analysis.clinicId !== sources.clinicId) {
      throw new FindingIntegrityError(`Root cause ${analysis.id} belongs to clinic ${analysis.clinicId}, not ${sources.clinicId}.`);
    }
    if (!ids.has(analysis.parentFindingId)) {
      throw new FindingIntegrityError(`Root cause ${analysis.id} names finding ${analysis.parentFindingId}, which this run did not produce.`);
    }
    byParent.set(analysis.parentFindingId, [...(byParent.get(analysis.parentFindingId) ?? []), analysis]);
  }
  return findings.map((f) => {
    const attached = byParent.get(f.id);
    if (attached === undefined) return f;
    const ordered = [...attached].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { ...f, evidence: { ...f.evidence, rootCauses: ordered } };
  });
}
