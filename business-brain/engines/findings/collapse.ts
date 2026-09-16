/**
 * Business Brain — Findings: collapsing one event into one finding
 *
 * Several producers can describe the same underlying thing. Left alone they
 * would compete for the top of the list — "next week is thin" and "room for four
 * bookings next week" are one fact about one week. So findings joined by an
 * explicit rule collapse into a CLUSTER, the best-ranked member leads, and the
 * rest become its supporting evidence.
 *
 * Only these four rules join findings, each resting on a link a producer already
 * recorded — never on similar wording or a shared category:
 *
 *   same_constraint         an opportunity names the constraint it belongs to
 *   shared_surplus          an opportunity names another it overlaps with
 *   same_unconverted_demand the Diagnosis Engine SETTLED that today's idle chair
 *                           and the unbooked treatment are one story
 *   same_metric             an achievement and an observed action outcome describe
 *                           the same metric improving
 *
 * And one limit, so collapse cannot cascade: a cluster never absorbs a second
 * constraint unless the rule joining them is the Diagnosis Engine's own
 * `same_unconverted_demand`. Without it, a freed slot linked to "appointments
 * lost" and overlapping next week's capacity match would drag two different
 * problems into one card.
 */

import type { Finding } from "../../domain";
import type { FindingSources } from "./normalize";

export const CollapseRule = {
  SAME_CONSTRAINT: "same_constraint",
  SHARED_SURPLUS: "shared_surplus",
  SAME_UNCONVERTED_DEMAND: "same_unconverted_demand",
  SAME_METRIC: "same_metric",
  SAME_TRAJECTORY: "same_trajectory",
} as const;

export type CollapseRule = (typeof CollapseRule)[keyof typeof CollapseRule];

export interface CollapseEdge {
  readonly a: string;
  readonly b: string;
  readonly rule: CollapseRule;
}

export const COLLAPSE_REASON: Readonly<Record<CollapseRule, string>> = {
  same_constraint: "it measures the same finding from the other side",
  shared_surplus: "it draws on the same open chair time",
  same_unconverted_demand: "the idle chair time and the unbooked treatment were settled as one story",
  same_metric: "it describes the same measured improvement",
  same_trajectory: "it is the same resource, seen as a trend over time",
};

/** The edges the recorded links support, in the order they are applied. */
export function collapseEdges(findings: readonly Finding[], sources: FindingSources): readonly CollapseEdge[] {
  const bySource = new Map(findings.map((f) => [f.source.id, f]));
  const edges: CollapseEdge[] = [];

  // The Diagnosis Engine's own merge, first: it is the only rule allowed to join
  // two constraints.
  const settledOneStory = sources.diagnoses.some(
    (d) =>
      d.pattern === "demand_supply_mismatch" &&
      d.hypotheses.some((h) => h.id.endsWith("#h.unconverted_demand") && h.status === "supported"),
  );
  if (settledOneStory) {
    const capacity = findings.find((f) => f.source.producer === "constraint" && f.category === "capacity");
    const acceptance = findings.find((f) => f.source.producer === "constraint" && f.category === "treatment_acceptance");
    if (capacity && acceptance) edges.push({ a: capacity.id, b: acceptance.id, rule: CollapseRule.SAME_UNCONVERTED_DEMAND });
  }

  for (const opportunity of sources.opportunities) {
    const finding = bySource.get(opportunity.id);
    if (finding === undefined) continue;
    if (opportunity.constraintId !== null) {
      const constraint = bySource.get(opportunity.constraintId);
      if (constraint !== undefined) edges.push({ a: constraint.id, b: finding.id, rule: CollapseRule.SAME_CONSTRAINT });
    }
  }

  for (const opportunity of sources.opportunities) {
    const finding = bySource.get(opportunity.id);
    if (finding === undefined) continue;
    for (const other of opportunity.overlapsWith) {
      const peer = bySource.get(other);
      if (peer !== undefined && finding.id < peer.id) {
        edges.push({ a: finding.id, b: peer.id, rule: CollapseRule.SHARED_SURPLUS });
      }
    }
  }

  // An early warning (no constraint fired) and an opportunity about the same
  // resource are one story: the thin week ahead, and the patients who could fill it.
  for (const opportunity of sources.opportunities) {
    if (opportunity.constraintId !== null) continue;
    const finding = bySource.get(opportunity.id);
    const primary = opportunity.relatedCategories[0];
    const warning = findings.find((f) => f.source.producer === "trajectory" && f.category === primary);
    if (finding !== undefined && warning !== undefined) {
      edges.push({ a: warning.id, b: finding.id, rule: CollapseRule.SAME_TRAJECTORY });
    }
  }

  for (const achievement of sources.achievements) {
    const win = bySource.get(achievement.id);
    if (win === undefined) continue;
    for (const outcome of sources.outcomes ?? []) {
      const observed = bySource.get(outcome.id);
      if (observed !== undefined && outcome.metric?.key === achievement.metricKey) {
        edges.push({ a: win.id, b: observed.id, rule: CollapseRule.SAME_METRIC });
      }
    }
  }

  return edges;
}

export interface Cluster {
  readonly members: readonly Finding[];
  /** For each non-lead member, the rule that brought it in. */
  readonly ruleFor: ReadonlyMap<string, CollapseRule>;
}

/** Union the findings along the edges, honouring the one-constraint limit. */
export function buildClusters(findings: readonly Finding[], edges: readonly CollapseEdge[]): readonly Cluster[] {
  const parent = new Map(findings.map((f) => [f.id, f.id]));
  const constraintsOf = new Map(
    findings.map((f) => [f.id, new Set(f.source.producer === "constraint" ? [f.id] : [])]),
  );
  const ruleFor = new Map<string, CollapseRule>();
  const byId = new Map(findings.map((f) => [f.id, f]));

  const root = (id: string): string => {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    return r;
  };

  for (const edge of edges) {
    if (!byId.has(edge.a) || !byId.has(edge.b)) continue;
    const ra = root(edge.a);
    const rb = root(edge.b);
    if (ra === rb) continue;
    const ca = constraintsOf.get(ra) as Set<string>;
    const cb = constraintsOf.get(rb) as Set<string>;
    const wouldJoinConstraints = ca.size > 0 && cb.size > 0;
    if (wouldJoinConstraints && edge.rule !== CollapseRule.SAME_UNCONVERTED_DEMAND) continue;
    parent.set(rb, ra);
    constraintsOf.set(ra, new Set([...ca, ...cb]));
    if (!ruleFor.has(edge.b)) ruleFor.set(edge.b, edge.rule);
    if (!ruleFor.has(edge.a)) ruleFor.set(edge.a, edge.rule);
  }

  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const r = root(finding.id);
    groups.set(r, [...(groups.get(r) ?? []), finding]);
  }
  return [...groups.values()].map((members) => ({ members, ruleFor }));
}
