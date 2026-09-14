/**
 * Business Brain — Findings: one deterministic prioritiser
 *
 * ## How the order is decided
 *
 * Findings are compared FACTOR BY FACTOR in a fixed order, and the first factor
 * that differs decides. There are no weights and no score. That is what lets
 * every placement be stated as one measured difference:
 *
 *   1. stakes           severity, or the Opportunity Engine's priority — lowered
 *                       one level when confidence is low
 *   2. urgency          time left to act: within 24h, 72h, 7 days, or none
 *   3. trend            worsening before steady before improving
 *   4. impact           the recorded amount — only between findings in the same unit
 *   5. affected patients
 *   6. persistence      consecutive days it has held
 *   7. located          a root-cause analysis located where it is concentrated
 *   8. confidence       more complete evidence first
 *   9. identifier       a stable tie-break, stated as such
 *
 * Stakes come first so an opportunity never outranks a more serious problem just
 * by having a deadline; urgency comes second so, between equally serious
 * findings, the one that will be gone first is dealt with first.
 *
 * ## The guarantees
 *
 * - Positive findings are never ranked: they go to `wins`, so good news can never
 *   push a problem off the top of the list.
 * - Low confidence lowers a finding one stakes level; it cannot sink to zero,
 *   because insufficient data only ever LOWERS confidence (see the normaliser).
 * - One event, one finding: collapsed clusters are led by their best-ranked member.
 * - Nothing here ranks patients. Affected-patient COUNTS are compared; people are not.
 * - No causal language: explanations state measurements and comparisons only.
 *
 * Pure. `now` injected.
 */

import {
  FindingKind,
  type Finding,
  type FindingMeasure,
  type OpportunityAssessment,
  type PrioritizedFindings,
  type RankFactors,
  type RankedFinding,
} from "../../domain";
import { buildClusters, COLLAPSE_REASON, collapseEdges } from "./collapse";
import { FINDINGS_CONFIG } from "./findings-config";
import { FindingIntegrityError, normalizeFindings, type FindingSources } from "./normalize";

const HOUR = 3_600_000;
const STAKES_RANK: Readonly<Record<string, number>> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const STAKES_WORD = ["informational", "low", "medium", "high", "critical"];
const KIND_WORD: Readonly<Record<string, string>> = {
  problem: "Problem",
  operational_risk: "Operational risk",
  early_warning: "Early warning",
  opportunity: "Opportunity",
  win: "Win",
};

export interface PrioritizeInput {
  readonly sources: FindingSources;
  readonly now: string;
  /** Opportunity types that could not be measured this run. */
  readonly opportunityAssessments?: readonly OpportunityAssessment[];
}

/** Normalise every producer's output, collapse shared events, and order what needs doing. */
export function prioritizeFindings(input: PrioritizeInput): PrioritizedFindings {
  const findings = normalizeFindings(input.sources);
  return rankFindings(findings, input);
}

/** Exposed for tests: rank already-normalised findings. */
export function rankFindings(findings: readonly Finding[], input: PrioritizeInput): PrioritizedFindings {
  const { clinicId, date } = input.sources;
  for (const finding of findings) {
    if (finding.clinicId !== clinicId) {
      throw new FindingIntegrityError(`Finding ${finding.id} belongs to clinic ${finding.clinicId}, not ${clinicId}.`);
    }
  }

  const now = Date.parse(input.now);
  const factors = new Map(findings.map((f) => [f.id, factorsOf(f, now)]));
  const compare = (a: Finding, b: Finding) => decide(a, b, factors, now);

  // One event, one finding: the best-ranked member leads its cluster.
  const clusters = buildClusters(findings, collapseEdges(findings, input.sources));
  const leads: Finding[] = [];
  const collapsed: { finding: Finding; lead: Finding; reason: string }[] = [];
  for (const cluster of clusters) {
    const ordered = [...cluster.members].sort((a, b) => compare(a, b).order);
    leads.push(ordered[0]);
    for (const member of ordered.slice(1)) {
      const rule = cluster.ruleFor.get(member.id);
      collapsed.push({ finding: member, lead: ordered[0], reason: rule ? COLLAPSE_REASON[rule] : "it describes the same event" });
    }
  }

  const wins: RankedFinding[] = [];
  const noAction: RankedFinding[] = [];
  const actionable: Finding[] = [];
  for (const finding of leads) {
    const f = factors.get(finding.id) as RankFactors;
    if (finding.polarity === "positive") {
      wins.push(ranked(finding, "win", null, f, `Win: ${facts(finding, f, now)}.`, null, null, null));
      continue;
    }
    const reason = noActionReason(finding, f, now);
    if (reason !== null) {
      noAction.push(ranked(finding, "no_action", null, f, `No action needed — ${reason}. ${capitalise(facts(finding, f, now))}.`, null, null, null));
      continue;
    }
    actionable.push(finding);
  }

  // The same unchanged warning is not resurfaced on every run. A trajectory-only
  // warning whose state has held for the quiet period stays visible as supporting
  // evidence and returns to the ranked list the day it changes. Constraints are
  // never quieted this way: they carry their own snooze.
  const quiet = actionable.filter(isQuietWarning);
  actionable.splice(0, actionable.length, ...actionable.filter((f) => !isQuietWarning(f)));

  actionable.sort((a, b) => compare(a, b).order);
  const order = actionable.map((finding, index) => {
    const f = factors.get(finding.id) as RankFactors;
    const below = actionable[index + 1];
    const role = index === 0 ? "top" : index <= FINDINGS_CONFIG.nextCount ? "next" : "supporting";
    const prefix =
      role === "supporting"
        ? `Ranked ${ordinal(index + 1)}, below the first ${FINDINGS_CONFIG.nextCount + 1}`
        : `Ranked ${ordinal(index + 1)}`;
    return ranked(
      finding,
      role,
      index + 1,
      f,
      `${prefix}: ${facts(finding, f, now)}.${trajectoryNote(finding)}${rootCauseNote(finding)}${memoryNote(finding)}`,
      below === undefined ? null : `Above “${below.title}” because ${compare(finding, below).statement}.`,
      null,
      null,
    );
  });

  const supportingCollapsed = collapsed
    .sort((x, y) => compare(x.lead, y.lead).order || compare(x.finding, y.finding).order)
    .map(({ finding, lead, reason }) => {
      const f = factors.get(finding.id) as RankFactors;
      const explanation = `Supports “${lead.title}”: ${reason}. ${capitalise(facts(finding, f, now))}.${trajectoryNote(finding)}${rootCauseNote(finding)}${memoryNote(finding)}`;
      return ranked(finding, finding.polarity === "positive" ? "win" : "supporting", null, f, explanation, null, lead.id, reason);
    });

  const quieted = quiet
    .sort((a, b) => compare(a, b).order)
    .map((finding) => {
      const f = factors.get(finding.id) as RankFactors;
      const since = finding.evidence.lifecycle?.since ?? "earlier";
      return ranked(
        finding,
        "supporting",
        null,
        f,
        `Unchanged since ${since}, so not raised again until it changes: ${facts(finding, f, now)}.${trajectoryNote(finding)}${rootCauseNote(finding)}${memoryNote(finding)}`,
        null,
        null,
        null,
      );
    });

  wins.sort((a, b) => compare(a.finding, b.finding).order);
  noAction.sort((a, b) => compare(a.finding, b.finding).order);

  return {
    clinicId,
    date,
    generatedAt: input.now,
    top: order[0] ?? null,
    next: order.filter((r) => r.role === "next"),
    supporting: [
      ...supportingCollapsed.filter((r) => r.role === "supporting"),
      ...order.filter((r) => r.role === "supporting"),
      ...quieted,
    ],
    wins: [...wins, ...supportingCollapsed.filter((r) => r.role === "win")],
    noActionRequired: noAction,
    unmeasured: (input.opportunityAssessments ?? [])
      .filter((a) => a.outcome === "insufficient_data")
      .map((a) => ({ source: `opportunity.${a.type}`, reason: a.reason })),
  };
}

// ── factors ─────────────────────────────────────────────────────────────────

function factorsOf(finding: Finding, now: number): RankFactors {
  const e = finding.evidence;
  const stakes =
    e.severity !== null
      ? (STAKES_RANK[e.severity] ?? 0)
      : e.opportunityPriority !== null
        ? (STAKES_RANK[e.opportunityPriority] ?? 0)
        : 0;
  const confidenceBand =
    e.confidence >= FINDINGS_CONFIG.highConfidence ? "high" : e.confidence >= FINDINGS_CONFIG.moderateConfidence ? "moderate" : "low";
  return {
    stakes,
    confidenceBand,
    effectiveStakes: Math.max(0, stakes - (confidenceBand === "low" ? 1 : 0)),
    urgency: urgencyOf(finding, now),
    trend: e.trend === "worsening" ? 2 : e.trend === "improving" ? 0 : 1,
    consecutiveDays: e.consecutiveDays ?? 0,
    affectedPatients: e.scope.find((m) => m.unit === "patients")?.value ?? null,
    located: e.rootCauses.some((r) => r.outcome === "explained" && r.confidence >= FINDINGS_CONFIG.moderateConfidence) ? 1 : 0,
  };
}

function hoursLeft(finding: Finding, now: number): number | null {
  return finding.evidence.expiresAt === null ? null : (Date.parse(finding.evidence.expiresAt) - now) / HOUR;
}

function urgencyOf(finding: Finding, now: number): number {
  const hours = hoursLeft(finding, now);
  const byDeadline =
    hours === null
      ? 0
      : hours <= FINDINGS_CONFIG.urgentWithinHours
        ? 3
        : hours <= FINDINGS_CONFIG.soonWithinHours
          ? 2
          : hours <= FINDINGS_CONFIG.thisWeekWithinHours
            ? 1
            : 0;
  const byTimeframe = finding.evidence.timeframe === "today" ? 3 : finding.evidence.timeframe === "this_week" ? 1 : 0;
  return Math.max(byDeadline, byTimeframe);
}

function isQuietWarning(finding: Finding): boolean {
  return finding.source.producer === "trajectory" && finding.evidence.lifecycle?.status === "unchanged";
}

/** The lead trajectory's own sentence, appended to an explanation. */
function trajectoryNote(finding: Finding): string {
  const lead = finding.evidence.trajectories[0];
  return lead === undefined ? "" : ` ${lead.statement}`;
}

/**
 * Each root-cause analysis's own sentence — including "insufficient evidence to
 * explain", which is as much a finding about the data as an explanation is.
 */
function rootCauseNote(finding: Finding): string {
  return finding.evidence.rootCauses.map((r) => ` ${r.statement}`).join("");
}

/**
 * What this clinic's memory adds, rendered from the numbers on the finding. Never
 * a ranking input: the order is decided before this is written.
 */
function memoryNote(finding: Finding): string {
  const m = finding.evidence.memory;
  if (m === undefined) return "";
  const parts: string[] = [];
  if (m.normalRange !== null && m.normalRange.direction !== null) {
    parts.push(
      ` At ${fmt1(m.normalRange.current)}, ${lower(m.normalRange.label)} is ${m.normalRange.direction} this clinic's usual range of ${fmt1(m.normalRange.lower)}–${fmt1(m.normalRange.upper)}.`,
    );
  }
  if (m.recurrence !== null) {
    const months = Math.round(m.recurrence.windowDays / 30.4);
    const resolution = m.recurrence.typicalResolutionDays === null ? "" : `, each typically clearing after about ${fmt1(m.recurrence.typicalResolutionDays)} days`;
    parts.push(` At this clinic it has been flagged in ${m.recurrence.episodes} separate episodes over the last ${months} months${resolution}.`);
  }
  return parts.join("");
}

function noActionReason(finding: Finding, f: RankFactors, now: number): string | null {
  // A trajectory that has returned to normal is watched, not worked. A constraint
  // whose metric is recovering is NOT dismissed this way: its own threshold still fired.
  if (finding.source.producer === "trajectory") {
    const lead = finding.evidence.trajectories[0];
    if (finding.evidence.lifecycle?.status === "resolved") {
      return `it has been back within its normal range for ${lead?.daysBackToNormal ?? 0} measured days`;
    }
    if (finding.evidence.lifecycle?.status === "recovering") {
      return "it is back within its normal range and still recovering, so it is watched rather than ranked";
    }
  }
  const hours = hoursLeft(finding, now);
  if (hours !== null && hours <= 0) return "its window to act has already passed";
  if (f.stakes <= 1 && finding.evidence.trend === "improving") return "the stakes are low and it is already improving";
  if (f.stakes <= 1 && f.confidenceBand === "low") return "the stakes are low and the evidence too thin to act on; it is watched, not ranked";
  if (f.stakes <= 1 && !finding.evidence.actionable) return "the stakes are low and there is nothing prepared to do about it";
  return null;
}

// ── the comparison ──────────────────────────────────────────────────────────

interface Decision {
  /** Negative when `a` ranks first. */
  readonly order: number;
  readonly statement: string;
}

function decide(a: Finding, b: Finding, factors: ReadonlyMap<string, RankFactors>, now: number): Decision {
  const fa = factors.get(a.id) as RankFactors;
  const fb = factors.get(b.id) as RankFactors;

  if (fa.effectiveStakes !== fb.effectiveStakes) {
    const [fHi, fLo] = fa.effectiveStakes > fb.effectiveStakes ? [fa, fb] : [fb, fa];
    const demoted = fLo.effectiveStakes < fLo.stakes ? ` (the other is ${STAKES_WORD[fLo.stakes]} but its evidence is thin, so it counts as ${STAKES_WORD[fLo.effectiveStakes]})` : "";
    return {
      order: fb.effectiveStakes - fa.effectiveStakes,
      statement: `its stakes are higher (${STAKES_WORD[fHi.effectiveStakes]} vs ${STAKES_WORD[fLo.effectiveStakes]})${demoted}`,
    };
  }
  if (fa.urgency !== fb.urgency) {
    const [first, second] = fa.urgency > fb.urgency ? [a, b] : [b, a];
    return {
      order: fb.urgency - fa.urgency,
      statement: `it is more time-sensitive (${urgencyWords(first, now)} vs ${urgencyWords(second, now)})`,
    };
  }
  if (fa.trend !== fb.trend) {
    const words = ["improving", "not worsening", "worsening"];
    return {
      order: fb.trend - fa.trend,
      statement: `it is ${words[Math.max(fa.trend, fb.trend)]} while the other is ${words[Math.min(fa.trend, fb.trend)]}`,
    };
  }
  const ia = a.evidence.impact;
  const ib = b.evidence.impact;
  if (ia !== null && ib !== null && ia.unit === ib.unit && ia.value !== ib.value) {
    return {
      order: ib.value - ia.value,
      statement: `more is at stake (${measureWords(ia.value >= ib.value ? ia : ib)} vs ${measureWords(ia.value >= ib.value ? ib : ia)})`,
    };
  }
  if (fa.affectedPatients !== null && fb.affectedPatients !== null && fa.affectedPatients !== fb.affectedPatients) {
    return {
      order: fb.affectedPatients - fa.affectedPatients,
      statement: `it affects more patients (${Math.max(fa.affectedPatients, fb.affectedPatients)} vs ${Math.min(fa.affectedPatients, fb.affectedPatients)})`,
    };
  }
  if (fa.consecutiveDays !== fb.consecutiveDays) {
    return {
      order: fb.consecutiveDays - fa.consecutiveDays,
      statement: `it has held longer (${Math.max(fa.consecutiveDays, fb.consecutiveDays)} vs ${Math.min(fa.consecutiveDays, fb.consecutiveDays)} days running)`,
    };
  }
  if (fa.located !== fb.located) {
    return {
      order: fb.located - fa.located,
      statement: "the ledger locates where it is concentrated, while the other has no located concentration yet",
    };
  }
  if (a.evidence.confidence !== b.evidence.confidence) {
    return {
      order: b.evidence.confidence - a.evidence.confidence,
      statement: `its evidence is more complete (confidence ${fmt2(Math.max(a.evidence.confidence, b.evidence.confidence))} vs ${fmt2(Math.min(a.evidence.confidence, b.evidence.confidence))})`,
    };
  }
  return {
    order: a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    statement: "every measured factor is equal, so they are ordered by identifier for a stable result",
  };
}

// ── words ───────────────────────────────────────────────────────────────────

function facts(finding: Finding, f: RankFactors, now: number): string {
  const e = finding.evidence;
  const parts: string[] = [KIND_WORD[finding.kind] ?? finding.kind];
  if (finding.kind !== FindingKind.WIN) {
    parts.push(
      f.effectiveStakes < f.stakes
        ? `${STAKES_WORD[f.stakes]} stakes, counted as ${STAKES_WORD[f.effectiveStakes]} because the evidence is thin`
        : `${STAKES_WORD[f.stakes]} stakes`,
    );
    parts.push(urgencyWords(finding, now));
  }
  if (e.trend === "worsening") parts.push("worsening");
  if (e.trend === "improving") parts.push("improving");
  if (e.trend === "steady") parts.push("holding steady");
  if ((e.consecutiveDays ?? 0) >= 2) parts.push(`${e.consecutiveDays} days running`);
  for (const m of e.scope) {
    if (m.unit === "patients") parts.push(`affects ${m.value} patient${m.value === 1 ? "" : "s"}`);
    if (m.unit === "minutes") parts.push(`${fmt1(m.value / 60)} hours (${m.label})`);
  }
  if (e.impact !== null) parts.push(measureWords(e.impact));
  parts.push(`${f.confidenceBand} confidence (${fmt2(e.confidence)})`);
  for (const note of e.dataQuality) {
    if (note.penalty > 0) parts.push(`confidence reduced by ${fmt2(note.penalty)}: ${lower(note.note)}`);
  }
  if (!e.actionable && finding.kind !== FindingKind.WIN) parts.push("no prepared action yet");
  return parts.join("; ");
}

function urgencyWords(finding: Finding, now: number): string {
  const hours = hoursLeft(finding, now);
  if (hours !== null && hours > 0) {
    return hours < 24
      ? `expires in ${Math.max(1, Math.round(hours))} hour${Math.round(hours) === 1 ? "" : "s"}`
      : `expires in ${Math.round(hours / 24)} day${Math.round(hours / 24) === 1 ? "" : "s"}`;
  }
  if (finding.evidence.timeframe === "today") return "to act on today";
  if (finding.evidence.timeframe === "this_week") return "to act on this week";
  return "no deadline";
}

function measureWords(m: FindingMeasure): string {
  if (m.unit === "currency") return `₹${Math.round(m.value).toLocaleString("en-IN")} (${m.label})`;
  if (m.unit === "minutes") return `${fmt1(m.value / 60)} hours (${m.label})`;
  return m.unit === "count" ? `${fmt1(m.value)} (${m.label})` : `${fmt1(m.value)} ${m.unit} (${m.label})`;
}

function ranked(
  finding: Finding,
  role: RankedFinding["role"],
  rank: number | null,
  factors: RankFactors,
  explanation: string,
  comparedWithNext: string | null,
  supports: string | null,
  collapseReason: string | null,
): RankedFinding {
  return { finding, role, rank, factors, explanation, comparedWithNext, supports, collapseReason };
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

const fmt1 = (n: number) => String(Math.round(n * 10) / 10);
const fmt2 = (n: number) => n.toFixed(2);
const capitalise = (s: string) => (s.length === 0 ? s : s[0].toUpperCase() + s.slice(1));
const lower = (s: string) => (s.length === 0 ? s : s[0].toLowerCase() + s.slice(1));
