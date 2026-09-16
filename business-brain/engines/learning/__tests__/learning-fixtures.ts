/**
 * Literal action histories for the attribution, resolution and learning specs.
 *
 * A UTC clinic, today Monday 2026-09-14. The overdue-recall reading runs
 * 19, 20, 21, 19, 20, 21 … every day — median 20, a normal variation of ±4 once
 * the baseline's floor is applied — and daily appointments run 9, 10, 11 …
 * around 10. A scenario bends exactly the readings it is about.
 */

import { EvidenceSource, EvidenceTiming } from "../../../provenance/evidence-quality";
import { MetricProvenance } from "../../../provenance/metric-provenance";
import {
  CompletionSource,
  type ActionCompletionRecord,
  type Finding,
  type Outcome,
} from "../../../domain";
import type { CompletionConfirmationFact, FindingSnapshotFact, MetricReadingDay, SnapshotFinding } from "../../../ledger";
import { MetricKey, buildMetric } from "../../metrics/metric-ids";
import { addDays } from "../../../utils";
import { deriveOutcomes, type OutcomeHistoryInput } from "../../outcome";

export const CLINIC = "clinic_a";
export const OTHER = "clinic_b";
export const DATE = "2026-09-14";
export const NOW = "2026-09-14T20:00:00.000Z";
export const OVERDUE = MetricKey.FOLLOWUPS_OVERDUE;
export const APPOINTMENTS = MetricKey.APPOINTMENTS_TOTAL_TODAY;

const dayNumber = (date: string) => Math.round(Date.parse(`${date}T00:00:00.000Z`) / 86_400_000);

export type Series = (date: string) => number | null;

export const noisy = (centre: number): Series => (date) => centre + ((dayNumber(date) % 3) - 1);

/**
 * Stored readings for every date from..to, each key from its series (null = not
 * stored). Measured at the time unless a provenance is given: the ladder's upper
 * rungs rest only on point-in-time readings, and a test of something else should
 * not fail on that.
 */
export function readings(
  from: string,
  to: string,
  series: Readonly<Record<string, Series>>,
  provenance: string = MetricProvenance.OBSERVED_AT_TIME,
): MetricReadingDay[] {
  const out: MetricReadingDay[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const values: Record<string, number> = {};
    const provenanceByKey: Record<string, string> = {};
    for (const [key, s] of Object.entries(series)) {
      const v = s(d);
      if (v !== null) {
        values[key] = v;
        provenanceByKey[key] = provenance;
      }
    }
    out.push({ date: d, values, provenance: provenanceByKey });
  }
  return out;
}

/** The overdue reading: noisy around 20, except on the given dates. */
export function overdue(overrides: Readonly<Record<string, number | null>> = {}): Series {
  return (date) => (date in overrides ? overrides[date] : noisy(20)(date));
}

export function completion(
  id: string,
  date: string,
  over: Partial<ActionCompletionRecord> & { targets?: number } = {},
): ActionCompletionRecord {
  const { targets = 8, ...rest } = over;
  return {
    id,
    category: "retention",
    constraintId: `constraint.retention:${CLINIC}:${date}`,
    completedAt: `${date}T10:00:00.000Z`,
    source: CompletionSource.DECLARED,
    targetPatientIds: Array.from({ length: targets }, (_, i) => `p_${id}_${i}`),
    metricKey: OVERDUE,
    metricValueAtCompletion: 20,
    ...rest,
  };
}

/**
 * What followed a completion. Results default to records of the event itself,
 * read as known at the time; pass `source` / `timing` to test anything weaker.
 */
export function confirmation(
  completionId: string,
  resolvable: number,
  delays: number[],
  verifiable = true,
  evidence: { source?: EvidenceSource; timing?: EvidenceTiming } = {},
): CompletionConfirmationFact {
  return {
    completionId,
    targeted: resolvable,
    resolvable,
    verifiable,
    delaysDays: delays,
    results: delays.map((delayDays) => ({ delayDays, source: evidence.source ?? EvidenceSource.OBJECTIVELY_OBSERVED })),
    timing: evidence.timing ?? EvidenceTiming.POINT_IN_TIME,
  };
}

/** A recall completion on `date` that meets every likely-contributed requirement. */
export function goodRecall(id: string, date: string) {
  return {
    completion: completion(id, date),
    confirmation: confirmation(id, 8, [1, 2, 2, 3, 4, 5, 6]),
    // Twelve on the horizon day: an improvement of 8 against a variation of 4.
    overrides: { [addDays(date, 14)]: 12 } as Record<string, number>,
  };
}

export function history(
  confirmations: readonly CompletionConfirmationFact[],
  days: readonly MetricReadingDay[],
  over: Partial<OutcomeHistoryInput> = {},
): OutcomeHistoryInput {
  return {
    clinicId: CLINIC,
    timezone: "UTC",
    metricDays: days,
    confirmations: new Map(confirmations.map((c) => [c.completionId, c])),
    ...over,
  };
}

export function assess(
  completions: readonly ActionCompletionRecord[],
  hist: OutcomeHistoryInput | undefined,
  now = NOW,
  today: Partial<Record<string, number>> = { [OVERDUE]: 18 },
): readonly Outcome[] {
  return deriveOutcomes({
    completions,
    verifications: new Map(),
    metrics: Object.entries(today).map(([k, v]) => buildMetric(k as MetricKey, v as number, CLINIC, DATE, NOW)),
    now,
    history: hist,
  }).outcomes;
}

/** Recall completions on each date, all good, over one continuous timeline. */
export function goodRecalls(dates: readonly string[], from = "2026-03-01", to = "2026-09-13") {
  const items = dates.map((d, i) => goodRecall(`c${i}`, d));
  const overrides = Object.assign({}, ...items.map((i) => i.overrides)) as Record<string, number>;
  return {
    completions: items.map((i) => i.completion),
    hist: history(
      items.map((i) => i.confirmation),
      readings(from, to, { [OVERDUE]: overdue(overrides), [APPOINTMENTS]: noisy(10) }),
    ),
  };
}

export function snapshotFinding(category: string | null, over: Partial<SnapshotFinding> = {}): SnapshotFinding {
  return {
    findingId: `finding.problem:constraint.${category}:${CLINIC}:x`,
    kind: "problem",
    polarity: "negative",
    category,
    role: "top",
    rank: 1,
    severity: "high",
    actionable: true,
    suppressed: false,
    ...over,
  };
}

export function snapshot(date: string, findings: SnapshotFinding[], clinicId = CLINIC): FindingSnapshotFact {
  return { clinicId, date, findings };
}

/** One snapshot per date from..to, each built by `build`. */
export function snapshots(from: string, to: string, build: (date: string, index: number) => SnapshotFinding[]): FindingSnapshotFact[] {
  const out: FindingSnapshotFact[] = [];
  let i = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(snapshot(d, build(d, i++)));
  return out;
}

export function todayFinding(category: string, over: Partial<Finding> = {}, evidence: Partial<Finding["evidence"]> = {}): Finding {
  return {
    id: `finding.problem:constraint.${category}:${CLINIC}:${DATE}`,
    kind: "problem",
    polarity: "negative",
    source: { producer: "constraint", id: `constraint.${category}:${CLINIC}:${DATE}` },
    clinicId: CLINIC,
    date: DATE,
    title: category,
    resource: "recall",
    category,
    constraintId: `constraint.${category}:${CLINIC}:${DATE}`,
    ...over,
    evidence: {
      severity: "high",
      opportunityPriority: null,
      impact: null,
      scope: [],
      expiresAt: null,
      timeframe: "this_week",
      persistence: null,
      consecutiveDays: null,
      trend: "unknown",
      confidence: 0.8,
      sourceConfidence: 0.8,
      dataQuality: [],
      actionable: true,
      primaryActionId: null,
      trajectories: [],
      lifecycle: null,
      rootCauses: [],
      ...evidence,
    },
  };
}

/** Every sentence an outcome or learning shows a reader. */
export const CAUSAL = /\bcaus(e|ed|es|ing)\b|\bbecause\b|\bdue to\b|\bled to\b|\bleads? to\b|\bresult(ed|s)? in\b|\bthanks to\b|\bproduced\b/i;
