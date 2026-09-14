/**
 * Business Brain — Outcome Engine: what became of the finding
 *
 * Completing an action is a statement about the action. Whether the problem it
 * answered went away is a separate question, read from what the clinic was shown
 * on the days after — never assumed from the completion.
 *
 * ## The days it reads
 *
 * Only RECORDED days: a finding snapshot for a day the dashboard was opened, and
 * today's run. A day nobody recorded is unknown, so it neither extends nor breaks
 * a run of clear days.
 *
 * ## The statuses, in the order they are decided
 *
 *   insufficient_evidence        no recorded day since the completion, or clear
 *                                too briefly to call it resolved
 *   resolved                     not flagged on the last 3+ consecutive recorded days
 *   improving                    still flagged, but less severely than on the day of
 *                                the completion, or its metric is recovering today
 *   outcome_observed_unresolved  still flagged, though the action's intended result
 *                                was observed
 *   still_active                 still flagged, with neither
 *
 * Pure.
 */

import {
  ResolutionStatus,
  TrajectoryState,
  type Finding,
  type FindingResolution,
  type Outcome,
} from "../../domain";
import type { FindingSnapshotFact } from "../../ledger";
import { CONSTRAINT_KIND } from "../findings/normalize";

export interface ResolutionInput {
  /** Today's business date. */
  readonly date: string;
  /** Today's findings, or null when this run has none to offer. */
  readonly today: readonly Finding[] | null;
  readonly snapshots: readonly FindingSnapshotFact[];
  readonly config?: { readonly clearDaysToResolve?: number };
}

const SEVERITY_RANK: Readonly<Record<string, number>> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

interface Day {
  readonly date: string;
  readonly flagged: boolean;
  readonly severity: number | null;
  readonly recovering: boolean;
}

function dayFromSnapshot(snapshot: FindingSnapshotFact, category: string): Day {
  const matching = snapshot.findings.filter((f) => f.category === category && f.polarity === "negative");
  return {
    date: snapshot.date,
    flagged: matching.length > 0,
    severity: matching.length === 0 ? null : Math.max(...matching.map((f) => SEVERITY_RANK[f.severity ?? ""] ?? 0)),
    recovering: false,
  };
}

function dayFromFindings(date: string, findings: readonly Finding[], category: string): Day {
  const matching = findings.filter((f) => f.category === category && f.polarity === "negative");
  return {
    date,
    flagged: matching.length > 0,
    severity: matching.length === 0 ? null : Math.max(...matching.map((f) => SEVERITY_RANK[f.evidence.severity ?? ""] ?? 0)),
    recovering: matching.some((f) => {
      const state = f.evidence.trajectories[0]?.state;
      return state === TrajectoryState.IMPROVING || state === TrajectoryState.RECOVERING;
    }),
  };
}

/** Whether what the action set out to do was observed, at any rung. */
function positive(outcome: Outcome): boolean {
  if ((outcome.evidence?.targets?.confirmedWithinWindow ?? 0) > 0) return true;
  if (outcome.targets?.verifiable && outcome.targets.confirmed > 0) return true;
  return outcome.metric?.improved === true;
}

export function resolveOutcome(outcome: Outcome, completionDate: string, input: ResolutionInput): FindingResolution {
  const clearDaysToResolve = input.config?.clearDaysToResolve ?? 3;
  const kind = (CONSTRAINT_KIND as Readonly<Record<string, string>>)[outcome.category] ?? "problem";
  const parentFindingId = `finding.${kind}:${outcome.constraintId}`;

  const byDate = new Map<string, Day>();
  let atCompletion: number | null = null;
  for (const snapshot of [...input.snapshots].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    if (snapshot.date <= completionDate) {
      // The latest recorded day up to the completion: its severity, or null when
      // the category was not flagged then.
      atCompletion = dayFromSnapshot(snapshot, outcome.category).severity;
      continue;
    }
    if (snapshot.date <= input.date) byDate.set(snapshot.date, dayFromSnapshot(snapshot, outcome.category));
  }
  if (input.today !== null && input.date > completionDate) {
    byDate.set(input.date, dayFromFindings(input.date, input.today, outcome.category));
  }
  const days = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const flaggedDays = days.filter((d) => d.flagged);
  const lastFlaggedOn = flaggedDays.length === 0 ? null : flaggedDays[flaggedDays.length - 1].date;

  let consecutiveClearDays = 0;
  for (let i = days.length - 1; i >= 0 && !days[i].flagged; i -= 1) consecutiveClearDays += 1;

  const base = { parentFindingId, observedDays: days.length, lastFlaggedOn, consecutiveClearDays };
  if (days.length === 0) {
    return {
      ...base,
      status: ResolutionStatus.INSUFFICIENT_EVIDENCE,
      statement: "No day has been recorded since the action was completed, so whether the problem is still there cannot be said.",
    };
  }
  const latest = days[days.length - 1];
  if (!latest.flagged) {
    return consecutiveClearDays >= clearDaysToResolve
      ? {
          ...base,
          status: ResolutionStatus.RESOLVED,
          statement: `Not flagged on the last ${consecutiveClearDays} recorded days${lastFlaggedOn === null ? " since the action was completed" : `, last flagged on ${lastFlaggedOn}`}.`,
        }
      : {
          ...base,
          status: ResolutionStatus.INSUFFICIENT_EVIDENCE,
          statement: `Not flagged on the last ${consecutiveClearDays} recorded day(s); ${clearDaysToResolve} in a row are needed before calling it resolved.`,
        };
  }
  const lessSevere = atCompletion !== null && latest.severity !== null && latest.severity < atCompletion;
  if (lessSevere || latest.recovering) {
    return {
      ...base,
      status: ResolutionStatus.IMPROVING,
      statement: lessSevere
        ? `Still flagged on ${latest.date}, but less severely than on the day the action was completed.`
        : `Still flagged on ${latest.date}, with its measurement recovering.`,
    };
  }
  if (positive(outcome)) {
    return {
      ...base,
      status: ResolutionStatus.OUTCOME_OBSERVED_UNRESOLVED,
      statement: `The action's intended result was observed, and the problem was still flagged on ${latest.date}.`,
    };
  }
  return {
    ...base,
    status: ResolutionStatus.STILL_ACTIVE,
    statement: `Still flagged on ${latest.date}, with no sign of improvement in the recorded days since.`,
  };
}
