/**
 * Business Brain — Learning Engine
 *
 * What this clinic's own history of actions shows: which actions keep being
 * followed by their intended result, which keep being followed by nothing, which
 * are recommended and not taken up, which problems never clear, how long results
 * take, and which episodes end sooner when someone acts.
 *
 * ## It learns from outcomes; it never re-derives them
 *
 * Attribution evidence and resolution come from the Outcome Engine, which read
 * them at fixed horizons. This engine counts across those outcomes and across the
 * findings the clinic was actually shown on recorded days. It adds no measurement
 * of its own, so it cannot disagree with the outcomes it summarises.
 *
 * ## A learning is exposed only when its threshold holds
 *
 * Every candidate produces an assessment — detected, not detected, or
 * insufficient evidence with the reason — and only a detected one becomes a
 * Learning. Thresholds are in `learning-config.ts`.
 *
 * ## It changes nothing
 *
 * Proposals are inert records a person may review. No threshold, diagnosis rule,
 * ranking factor or action is read from or written by this engine.
 *
 * ## One clinic
 *
 * Every input must belong to `clinicId`; anything else stops the engine. Nothing
 * is pooled across clinics and no benchmark is formed.
 *
 * Pure: no database, no clock, no model.
 */

import {
  FindingKind,
  LearningKind,
  OutcomeAttribution,
  ProposalKind,
  type ClinicLearning,
  type Finding,
  type Learning,
  type LearningAssessment,
  type LearningLevel,
  type LearningProposal,
  type Outcome,
} from "../../domain";
import type { DismissalFact, FindingSnapshotFact } from "../../ledger";
import { addDays, daysBetween } from "../../utils";
import { median } from "../metrics/support/windows";
import { episodesOf } from "./episodes";
import { localDate } from "../outcome/attribution";
import { OUTCOME_SPECS, OUTCOME_SPEC_BY_CATEGORY } from "../outcome/outcome-catalog";
import {
  ACTION_LABEL,
  DEFAULT_LEARNING_CONFIG,
  IMPROVEMENT_PHRASE,
  OPPORTUNITY_LABEL,
  PROBLEM_LABEL,
  RESULT_NOUN,
  type LearningConfig,
} from "./learning-config";

export interface LearningInput {
  readonly clinicId: string;
  readonly date: string;
  readonly timezone: string;
  /** Outcomes assessed WITH history, so each carries its windowed evidence. */
  readonly outcomes: readonly Outcome[];
  readonly snapshots: readonly FindingSnapshotFact[];
  readonly dismissals: readonly DismissalFact[];
  /** Today's findings, or null when the caller has none. */
  readonly today: readonly Finding[] | null;
  /** History kinds withheld or cut short in the read. */
  readonly gaps: readonly string[];
  readonly config?: Partial<LearningConfig>;
}

export class LearningIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LearningIntegrityError";
  }
}

const LIMITATION_ASSOCIATION =
  "An association in this clinic's own records, not proof of the action's effect: there is no comparison group.";
const LIMITATION_RECORDED_DAYS =
  "Counts only days on which the briefing was recorded; days nobody opened it are unknown, not clear.";

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const lowerFirst = (s: string) => (s.length === 0 ? s : s[0].toLowerCase() + s.slice(1));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function mergeConfig(partial: Partial<LearningConfig> | undefined): LearningConfig {
  const d = DEFAULT_LEARNING_CONFIG;
  return {
    ...d,
    ...(partial ?? {}),
    repeated: { ...d.repeated, ...(partial?.repeated ?? {}) },
    noChange: { ...d.noChange, ...(partial?.noChange ?? {}) },
    ignored: { ...d.ignored, ...(partial?.ignored ?? {}) },
    recurring: { ...d.recurring, ...(partial?.recurring ?? {}) },
    timeToOutcome: { ...d.timeToOutcome, ...(partial?.timeToOutcome ?? {}) },
    faster: { ...d.faster, ...(partial?.faster ?? {}) },
    opportunity: { ...d.opportunity, ...(partial?.opportunity ?? {}) },
  };
}

/** The `<clinic>` segment of `constraint.<category>:<clinic>:<date>`. */
function clinicOfConstraint(id: string): string | null {
  const parts = id.split(":");
  return parts.length >= 3 ? parts[1] : null;
}

interface Detection {
  readonly assessment: LearningAssessment;
  readonly learning: Learning | null;
}

export function deriveLearning(input: LearningInput): ClinicLearning {
  const config = mergeConfig(input.config);
  const from = addDays(input.date, -(config.windowDays - 1));

  for (const outcome of input.outcomes) {
    if (clinicOfConstraint(outcome.constraintId) !== input.clinicId) {
      throw new LearningIntegrityError(`Outcome ${outcome.id} belongs to another clinic than ${input.clinicId}.`);
    }
  }
  for (const s of input.snapshots) {
    if (s.clinicId !== input.clinicId) throw new LearningIntegrityError(`Snapshot for ${s.date} belongs to clinic ${s.clinicId}.`);
  }
  for (const d of input.dismissals) {
    if (d.clinicId !== input.clinicId) throw new LearningIntegrityError(`Dismissal belongs to clinic ${d.clinicId}.`);
  }
  for (const f of input.today ?? []) {
    if (f.clinicId !== input.clinicId) throw new LearningIntegrityError(`Finding ${f.id} belongs to clinic ${f.clinicId}.`);
  }

  const ctx = new Context(input, config, from);
  const detections: Detection[] = [];
  for (const spec of OUTCOME_SPECS) {
    detections.push(repeatedImprovement(ctx, spec.category));
    detections.push(noMeasurableChange(ctx, spec.category));
    detections.push(timeToOutcome(ctx, spec.category));
    detections.push(frequentlyIgnored(ctx, spec.category));
    detections.push(recurringUnresolved(ctx, spec.category));
    detections.push(fasterResolution(ctx, spec.category));
  }
  for (const type of ctx.opportunityTypes()) detections.push(opportunityNotActed(ctx, type));

  const learnings = detections
    .map((d) => d.learning)
    .filter((l): l is Learning => l !== null)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const assessments = detections
    .map((d) => d.assessment)
    .sort((a, b) => (a.kind === b.kind ? (a.subject < b.subject ? -1 : 1) : a.kind < b.kind ? -1 : 1));

  return {
    clinicId: input.clinicId,
    date: input.date,
    window: { from, to: input.date },
    learnings,
    assessments,
    proposals: learnings.flatMap((l) => proposalFor(l)).sort((a, b) => (a.id < b.id ? -1 : 1)),
    coverage: {
      completions: ctx.outcomes.length,
      closedOutcomes: ctx.outcomes.filter((o) => o.evidence?.window === "closed").length,
      recordedDays: ctx.recordedDays().length,
      gaps: [...new Set(input.gaps)].sort(),
    },
  };
}

// ── shared reading ────────────────────────────────────────────────────────────

interface RecordedDay {
  readonly date: string;
  readonly findings: readonly {
    readonly findingId: string;
    readonly kind: string;
    readonly polarity: string;
    readonly category: string | null;
    readonly role: string;
    readonly actionable: boolean;
    readonly suppressed: boolean;
  }[];
}

class Context {
  readonly outcomes: readonly Outcome[];
  private readonly days: readonly RecordedDay[];

  constructor(
    readonly input: LearningInput,
    readonly config: LearningConfig,
    readonly from: string,
  ) {
    this.outcomes = input.outcomes
      .filter((o) => {
        const d = localDate(o.completedAt, input.timezone);
        return d >= from && d <= input.date;
      })
      .sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt) || (a.id < b.id ? -1 : 1));

    const byDate = new Map<string, RecordedDay>();
    for (const s of input.snapshots) {
      if (s.date < from || s.date > input.date) continue;
      byDate.set(s.date, { date: s.date, findings: s.findings });
    }
    if (input.today !== null) {
      byDate.set(input.date, {
        date: input.date,
        findings: input.today.map((f) => ({
          findingId: f.id,
          kind: f.kind,
          polarity: f.polarity,
          category: f.category,
          role: "unranked",
          actionable: f.evidence.actionable,
          // Suppression is a page decision; today's snapshot, when recorded, carries it.
          suppressed: byDate.get(input.date)?.findings.find((s) => s.findingId === f.id)?.suppressed ?? false,
        })),
      });
    }
    this.days = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  has(gap: string): boolean {
    return this.input.gaps.includes(gap);
  }

  recordedDays(): readonly RecordedDay[] {
    return this.days;
  }

  of(category: string): readonly Outcome[] {
    return this.outcomes.filter((o) => o.category === category);
  }

  completionDates(category: string): readonly string[] {
    return this.of(category).map((o) => localDate(o.completedAt, this.input.timezone));
  }

  /** A snooze covering this category at some moment on `date`. */
  snoozed(category: string, date: string): boolean {
    return this.input.dismissals.some(
      (d) => d.category === category && localDate(d.dismissedAt, this.input.timezone) <= date && localDate(d.expiresAt, this.input.timezone) >= date,
    );
  }

  opportunityTypes(): readonly string[] {
    const types = new Set<string>();
    for (const day of this.days) {
      for (const f of day.findings) if (f.kind === FindingKind.OPPORTUNITY) types.add(opportunityTypeOf(f.findingId));
    }
    return [...types].sort();
  }
}

function opportunityTypeOf(findingId: string): string {
  const match = /opportunity\.([a-z_]+):/.exec(findingId);
  return match ? match[1] : "unknown";
}

function assessment(kind: LearningKind, subject: string, status: LearningAssessment["status"], reason: string): LearningAssessment {
  return { kind, subject, status, reason };
}

/** Why outcome-based learning cannot run, or null. */
function outcomeGap(ctx: Context): string | null {
  if (ctx.has("action_completion")) return "completed actions were withheld from this read";
  if (ctx.has("action_completion_truncated")) return "the read of completed actions hit its limit, so counts would be partial";
  if (ctx.has("completion_confirmation")) return "what followed each action could not be read in full";
  return null;
}

/** Why exposure-based learning cannot run, or null. */
function snapshotGap(ctx: Context): string | null {
  if (ctx.has("action_completion")) return "completed actions were withheld from this read";
  if (ctx.has("finding_snapshot")) return "the recorded briefings were withheld or cut short";
  // A snooze read cut short could make snoozed days look like ignored ones.
  if (ctx.has("dismissal")) return "the snoozes placed on problems were withheld or cut short";
  return null;
}

function levelConfidence(level: LearningLevel, ctx: Context): number {
  const base = level === "strong_evidence" ? 0.9 : level === "likely_contributed" ? 0.75 : 0.5;
  return round2(Math.max(0.05, base - (ctx.input.gaps.length > 0 ? 0.1 : 0)));
}

function coverageConfidence(recorded: number, ctx: Context): number {
  return round2(Math.min(0.9, 0.4 + 0.5 * Math.min(1, recorded / 30)) - (ctx.input.gaps.length > 0 ? 0.1 : 0));
}

function learningId(kind: LearningKind, subject: string, clinicId: string): string {
  return `learning.${kind}:${subject}:${clinicId}`;
}

// ── outcome-based ─────────────────────────────────────────────────────────────

interface Judged {
  readonly outcome: Outcome;
  readonly positive: boolean;
  readonly noChange: boolean;
}

/** Closed outcomes with at least one measured side, and what each showed. */
function judged(ctx: Context, category: string): readonly Judged[] {
  return ctx.of(category).flatMap((outcome) => {
    const e = outcome.evidence;
    if (e === undefined || e.window !== "closed") return [];
    const targetsMeasured = e.targets !== null && e.targets.verifiable && e.targets.resolvable > 0;
    const metricMeasured =
      e.metric !== null && e.metric.improvement !== null && e.metric.normalVariation !== null && e.metric.baselineDays > 0;
    if (!targetsMeasured && !metricMeasured) return [];
    const confirmed = targetsMeasured && (e.targets?.confirmedWithinWindow ?? 0) > 0;
    const moved = metricMeasured && (e.metric?.improvement as number) > (e.metric?.normalVariation as number);
    return [{ outcome, positive: confirmed || moved, noChange: !confirmed && !moved }];
  });
}

function repeatedImprovement(ctx: Context, category: string): Detection {
  const kind = LearningKind.REPEATED_IMPROVEMENT;
  const gap = outcomeGap(ctx);
  if (gap !== null) return { assessment: assessment(kind, category, "insufficient_evidence", gap), learning: null };
  const cfg = ctx.config.repeated;
  const all = judged(ctx, category);
  if (all.length < cfg.minClosedOutcomes) {
    return {
      assessment: assessment(kind, category, "insufficient_evidence", `${all.length} closed, measurable outcome(s); ${cfg.minClosedOutcomes} are needed`),
      learning: null,
    };
  }
  const positives = all.filter((j) => j.positive);
  const share = positives.length / all.length;
  if (share < cfg.minPositiveShare) {
    return {
      assessment: assessment(kind, category, "not_detected", `${positives.length} of ${all.length} were followed by the intended result; ${Math.round(cfg.minPositiveShare * 100)}% are needed`),
      learning: null,
    };
  }
  const strong = all.filter((j) => j.outcome.attribution === OutcomeAttribution.STRONG_EVIDENCE);
  const likely = all.filter(
    (j) => j.outcome.attribution === OutcomeAttribution.LIKELY_CONTRIBUTED || j.outcome.attribution === OutcomeAttribution.STRONG_EVIDENCE,
  );
  const level: LearningLevel =
    strong.length > 0
      ? "strong_evidence"
      : likely.length >= cfg.minLikely && likely.length / all.length >= cfg.minLikelyShare
        ? "likely_contributed"
        : "observed";
  const action = ACTION_LABEL[category] ?? category;
  const results = all.reduce((sum, j) => sum + (j.outcome.evidence?.targets?.confirmedWithinWindow ?? 0), 0);
  const weeks = new Set(likely.map((j) => weekOf(localDate(j.outcome.completedAt, ctx.input.timezone)))).size;
  const dates = all.map((j) => localDate(j.outcome.completedAt, ctx.input.timezone));
  const improvement = IMPROVEMENT_PHRASE[category] ?? "its intended result";
  const noun = RESULT_NOUN[category];

  const statement =
    level === "strong_evidence"
      ? `${action} has repeatedly been associated with ${improvement} at this clinic: ${likely.length} of ${all.length} completed actions across ${weeks} separate weeks met the evidence standard.`
      : level === "likely_contributed"
        ? `${action} has been associated with ${improvement} at this clinic: ${likely.length} of ${all.length} completed actions met the likely-contributed evidence standard.`
        : noun !== undefined && results > 0
          ? `${action} was followed by ${results} ${noun} from ${all.length} completed actions.`
          : `${action} was followed by ${improvement} beyond its normal range after ${positives.length} of ${all.length} completed actions.`;

  const learning: Learning = {
    id: learningId(kind, category, ctx.input.clinicId),
    clinicId: ctx.input.clinicId,
    kind,
    subject: category,
    level,
    statement,
    evidence: [
      `${positives.length} of ${all.length} closed outcomes were followed by the intended result within their windows.`,
      `${likely.length} met the likely-contributed standard${strong.length > 0 ? `, ${strong.length} of them with repetition strong enough for strong evidence` : ""}.`,
      ...(noun !== undefined ? [`${results} ${noun} were recorded within the windows.`] : []),
    ],
    counts: { outcomes: all.length, followedByResult: positives.length, results, likelyContributed: likely.length, strongEvidence: strong.length },
    firstObserved: dates[0],
    lastObserved: dates[dates.length - 1],
    confidence: levelConfidence(level, ctx),
    limitations: [LIMITATION_ASSOCIATION, "Only this clinic's completions are counted; nothing is compared with other clinics."],
  };
  return { assessment: assessment(kind, category, "detected", `detected at the ${level.replace(/_/g, " ")} level`), learning };
}

function noMeasurableChange(ctx: Context, category: string): Detection {
  const kind = LearningKind.NO_MEASURABLE_CHANGE;
  const gap = outcomeGap(ctx);
  if (gap !== null) return { assessment: assessment(kind, category, "insufficient_evidence", gap), learning: null };
  const cfg = ctx.config.noChange;
  const all = judged(ctx, category);
  if (all.length < cfg.minClosedOutcomes) {
    return {
      assessment: assessment(kind, category, "insufficient_evidence", `${all.length} closed, measurable outcome(s); ${cfg.minClosedOutcomes} are needed`),
      learning: null,
    };
  }
  const none = all.filter((j) => j.noChange);
  if (none.length / all.length < cfg.minNoChangeShare) {
    return {
      assessment: assessment(kind, category, "not_detected", `${none.length} of ${all.length} were followed by no measurable change`),
      learning: null,
    };
  }
  const action = ACTION_LABEL[category] ?? category;
  const dates = all.map((j) => localDate(j.outcome.completedAt, ctx.input.timezone));
  return {
    assessment: assessment(kind, category, "detected", `${none.length} of ${all.length} followed by no measurable change`),
    learning: {
      id: learningId(kind, category, ctx.input.clinicId),
      clinicId: ctx.input.clinicId,
      kind,
      subject: category,
      level: "observed",
      statement: `${action} was marked done ${plural(all.length, "time")}, and ${none.length} of those were followed by no measurable change in the records within the following weeks.`,
      evidence: [
        `No targeted patient showed the intended result, and the measurement stayed within its normal variation, after ${none.length} of ${all.length} closed outcomes.`,
      ],
      counts: { outcomes: all.length, noMeasurableChange: none.length },
      firstObserved: dates[0],
      lastObserved: dates[dates.length - 1],
      confidence: levelConfidence("observed", ctx),
      limitations: [
        "No measured change is not proof that the action does nothing: a result can land outside the window, or in something the records do not hold.",
      ],
    },
  };
}

function timeToOutcome(ctx: Context, category: string): Detection {
  const kind = LearningKind.TIME_TO_OUTCOME;
  const gap = outcomeGap(ctx);
  if (gap !== null) return { assessment: assessment(kind, category, "insufficient_evidence", gap), learning: null };
  const noun = RESULT_NOUN[category];
  if (noun === undefined || OUTCOME_SPEC_BY_CATEGORY.get(category)?.verifies == null) {
    return { assessment: assessment(kind, category, "insufficient_evidence", "the intended result of this action is not recorded, so its timing cannot be read"), learning: null };
  }
  const cfg = ctx.config.timeToOutcome;
  const closed = ctx.of(category).filter((o) => o.evidence?.window === "closed" && o.evidence.targets?.verifiable);
  const delays = closed.flatMap((o) => o.evidence?.targets?.daysToResult ?? []);
  if (closed.length < cfg.minOutcomes || delays.length < cfg.minResults) {
    return {
      assessment: assessment(kind, category, "insufficient_evidence", `${delays.length} recorded result(s) from ${closed.length} closed outcome(s); ${cfg.minResults} results from ${cfg.minOutcomes} outcomes are needed`),
      learning: null,
    };
  }
  const m = round1(median(delays));
  const action = ACTION_LABEL[category] ?? category;
  const dates = closed.map((o) => localDate(o.completedAt, ctx.input.timezone));
  return {
    assessment: assessment(kind, category, "detected", `median ${m} days across ${delays.length} results`),
    learning: {
      id: learningId(kind, category, ctx.input.clinicId),
      clinicId: ctx.input.clinicId,
      kind,
      subject: category,
      level: "observed",
      statement: `After ${lowerFirst(action)}, ${noun} were typically recorded within a median of ${m} days (${delays.length} results across ${closed.length} completed actions).`,
      evidence: [`Shortest ${round1(Math.min(...delays))} days, longest ${round1(Math.max(...delays))} days, within each action's window.`],
      counts: { outcomes: closed.length, results: delays.length },
      firstObserved: dates[0],
      lastObserved: dates[dates.length - 1],
      confidence: levelConfidence("observed", ctx),
      limitations: ["Only results recorded inside each action's window are timed; later ones are not counted."],
    },
  };
}

// ── exposure-based ────────────────────────────────────────────────────────────

function frequentlyIgnored(ctx: Context, category: string): Detection {
  const kind = LearningKind.FREQUENTLY_IGNORED;
  const gap = snapshotGap(ctx);
  if (gap !== null) return { assessment: assessment(kind, category, "insufficient_evidence", gap), learning: null };
  const cfg = ctx.config.ignored;
  const recorded = ctx.recordedDays().filter((d) => d.date !== ctx.input.date || ctx.input.snapshots.some((s) => s.date === d.date));
  if (recorded.length < cfg.minRecordedDays) {
    return { assessment: assessment(kind, category, "insufficient_evidence", `${recorded.length} recorded briefing day(s); ${cfg.minRecordedDays} are needed`), learning: null };
  }
  const exposure = recorded.filter(
    (d) =>
      !ctx.snoozed(category, d.date) &&
      d.findings.some(
        (f) => f.category === category && f.polarity === "negative" && f.actionable && !f.suppressed && (f.role === "top" || f.role === "next"),
      ),
  );
  if (exposure.length < cfg.minExposureDays) {
    return { assessment: assessment(kind, category, "not_detected", `a top recommendation on ${exposure.length} recorded day(s); ${cfg.minExposureDays} are needed`), learning: null };
  }
  const done = ctx.completionDates(category);
  const acted = exposure.filter((d) => done.some((c) => c >= d.date && c <= addDays(d.date, cfg.actedWithinDays)));
  const ignored = exposure.length - acted.length;
  if (ignored / exposure.length < cfg.minIgnoredShare) {
    return { assessment: assessment(kind, category, "not_detected", `acted on after ${acted.length} of ${exposure.length} recommendations`), learning: null };
  }
  const action = ACTION_LABEL[category] ?? category;
  return {
    assessment: assessment(kind, category, "detected", `not acted on after ${ignored} of ${exposure.length} recommendations`),
    learning: {
      id: learningId(kind, category, ctx.input.clinicId),
      clinicId: ctx.input.clinicId,
      kind,
      subject: category,
      level: "observed",
      statement: `${action} was a top recommendation on ${exposure.length} of ${recorded.length} recorded days, and was marked done within ${cfg.actedWithinDays} days of ${acted.length} of them.`,
      evidence: [
        `Days on which the problem was snoozed are not counted.`,
        `${done.length} completion(s) of this action were recorded in the window.`,
      ],
      counts: { recordedDays: recorded.length, recommendedDays: exposure.length, actedOn: acted.length },
      firstObserved: exposure[0].date,
      lastObserved: exposure[exposure.length - 1].date,
      confidence: coverageConfidence(recorded.length, ctx),
      limitations: [LIMITATION_RECORDED_DAYS, "Work done without pressing Done is not recorded, so some of these days may have been acted on."],
    },
  };
}

function flagDays(ctx: Context, category: string): readonly { date: string; flagged: boolean }[] {
  return ctx.recordedDays().map((d) => ({
    date: d.date,
    flagged: d.findings.some((f) => f.category === category && f.polarity === "negative"),
  }));
}

function recurringUnresolved(ctx: Context, category: string): Detection {
  const kind = LearningKind.RECURRING_UNRESOLVED;
  const gap = snapshotGap(ctx);
  if (gap !== null) return { assessment: assessment(kind, category, "insufficient_evidence", gap), learning: null };
  const cfg = ctx.config.recurring;
  const days = flagDays(ctx, category);
  if (days.length < cfg.minRecordedDays) {
    return { assessment: assessment(kind, category, "insufficient_evidence", `${days.length} recorded day(s); ${cfg.minRecordedDays} are needed`), learning: null };
  }
  const flagged = days.filter((d) => d.flagged);
  const latest = days[days.length - 1];
  const span = flagged.length === 0 ? 0 : daysBetween(flagged[0].date, flagged[flagged.length - 1].date);
  if (flagged.length < cfg.minFlaggedDays || span < cfg.minSpanDays || !latest.flagged) {
    return {
      assessment: assessment(
        kind,
        category,
        "not_detected",
        !latest.flagged ? "not flagged on the latest recorded day" : `flagged on ${flagged.length} recorded day(s) across ${span} days`,
      ),
      learning: null,
    };
  }
  const completions = ctx.of(category);
  const problem = PROBLEM_LABEL[category] ?? category;
  const rootCause = (ctx.input.today ?? [])
    .filter((f) => f.category === category)
    .flatMap((f) => f.evidence.rootCauses)
    .find((r) => r.outcome === "explained");
  const lastResolution = completions[completions.length - 1]?.resolution;
  return {
    assessment: assessment(kind, category, "detected", `flagged on ${flagged.length} of ${days.length} recorded days`),
    learning: {
      id: learningId(kind, category, ctx.input.clinicId),
      clinicId: ctx.input.clinicId,
      kind,
      subject: category,
      level: "observed",
      statement: `${problem} has been flagged on ${flagged.length} of ${days.length} recorded days since ${flagged[0].date} and is still flagged on ${latest.date}${completions.length > 0 ? `, after ${plural(completions.length, "completed action")}` : ", with no action marked done"}.`,
      evidence: [
        ...(lastResolution !== undefined ? [`After the most recent completed action: ${lastResolution.statement}`] : []),
        ...(rootCause !== undefined ? [`Where it is concentrated today: ${rootCause.statement}`] : []),
      ],
      counts: { recordedDays: days.length, flaggedDays: flagged.length, spanDays: span, completions: completions.length },
      firstObserved: flagged[0].date,
      lastObserved: latest.date,
      confidence: coverageConfidence(days.length, ctx),
      limitations: [LIMITATION_RECORDED_DAYS],
    },
  };
}

function fasterResolution(ctx: Context, category: string): Detection {
  const kind = LearningKind.FASTER_RESOLUTION;
  const gap = snapshotGap(ctx);
  if (gap !== null) return { assessment: assessment(kind, category, "insufficient_evidence", gap), learning: null };
  const cfg = ctx.config.faster;
  const days = flagDays(ctx, category);
  // Closed episodes with a known start only; see `episodes.ts`.
  const episodes = episodesOf(days)
    .filter((e) => e.end !== null && e.length !== null)
    .map((e) => ({ start: e.start, end: e.end as string, length: e.length as number }));
  const done = ctx.completionDates(category);
  const acted = episodes.filter((e) => done.some((c) => c >= e.start && c < e.end)).map((e) => e.length);
  const unacted = episodes.filter((e) => !done.some((c) => c >= e.start && c < e.end)).map((e) => e.length);
  if (acted.length < cfg.minEpisodesEach || unacted.length < cfg.minEpisodesEach) {
    return {
      assessment: assessment(kind, category, "insufficient_evidence", `${acted.length} closed episode(s) with the action and ${unacted.length} without; ${cfg.minEpisodesEach} of each are needed`),
      learning: null,
    };
  }
  const a = median(acted);
  const u = median(unacted);
  if (u - a < cfg.minMedianGapDays || a > u * (1 - cfg.minRelativeGap)) {
    return { assessment: assessment(kind, category, "not_detected", `median ${round1(a)} days with the action against ${round1(u)} without`), learning: null };
  }
  const problem = PROBLEM_LABEL[category] ?? category;
  const action = ACTION_LABEL[category] ?? category;
  return {
    assessment: assessment(kind, category, "detected", `median ${round1(a)} days with the action against ${round1(u)} without`),
    learning: {
      id: learningId(kind, category, ctx.input.clinicId),
      clinicId: ctx.input.clinicId,
      kind,
      subject: category,
      level: "observed",
      statement: `Episodes of ${lowerFirst(problem)} ended after a median of ${round1(a)} days when ${lowerFirst(action)} was marked done, against ${round1(u)} days when it was not (${acted.length} and ${unacted.length} episodes).`,
      evidence: [`Episode lengths with the action: ${[...acted].sort((x, y) => x - y).join(", ")} days; without: ${[...unacted].sort((x, y) => x - y).join(", ")} days.`],
      counts: { actedEpisodes: acted.length, unactedEpisodes: unacted.length },
      firstObserved: episodes[0].start,
      lastObserved: episodes[episodes.length - 1].end,
      confidence: coverageConfidence(days.length, ctx),
      limitations: [
        LIMITATION_ASSOCIATION,
        "Episodes where someone acted may differ from the others in ways the records do not hold, such as how busy the clinic was.",
        LIMITATION_RECORDED_DAYS,
      ],
    },
  };
}

function opportunityNotActed(ctx: Context, type: string): Detection {
  const kind = LearningKind.OPPORTUNITY_NOT_ACTED;
  const gap = snapshotGap(ctx);
  if (gap !== null) return { assessment: assessment(kind, type, "insufficient_evidence", gap), learning: null };
  const cfg = ctx.config.opportunity;
  const recorded = ctx.recordedDays().filter((d) => d.date !== ctx.input.date || ctx.input.snapshots.some((s) => s.date === d.date));
  if (recorded.length < cfg.minRecordedDays) {
    return { assessment: assessment(kind, type, "insufficient_evidence", `${recorded.length} recorded briefing day(s); ${cfg.minRecordedDays} are needed`), learning: null };
  }
  const exposure = recorded.flatMap((d) => {
    const f = d.findings.find((x) => x.kind === FindingKind.OPPORTUNITY && opportunityTypeOf(x.findingId) === type && x.role !== "no_action");
    return f === undefined ? [] : [{ date: d.date, category: f.category }];
  });
  if (exposure.length < cfg.minExposureDays) {
    return { assessment: assessment(kind, type, "not_detected", `shown on ${exposure.length} recorded day(s); ${cfg.minExposureDays} are needed`), learning: null };
  }
  const linked = exposure.filter((e) => e.category !== null);
  if (linked.length === 0) {
    return {
      assessment: assessment(kind, type, "insufficient_evidence", "the opportunity was never linked to a problem, and no action can be recorded against it on its own"),
      learning: null,
    };
  }
  const acted = linked.filter((e) =>
    ctx.completionDates(e.category as string).some((c) => c >= e.date && c <= addDays(e.date, cfg.actedWithinDays)),
  );
  if (acted.length > 0) {
    return { assessment: assessment(kind, type, "not_detected", `a related action was marked done after ${acted.length} of ${linked.length} showings`), learning: null };
  }
  const label = OPPORTUNITY_LABEL[type] ?? type.replace(/_/g, " ");
  return {
    assessment: assessment(kind, type, "detected", `shown on ${exposure.length} recorded days with no related action`),
    learning: {
      id: learningId(kind, type, ctx.input.clinicId),
      clinicId: ctx.input.clinicId,
      kind,
      subject: type,
      level: "observed",
      statement: `The ${label} opportunity was shown on ${exposure.length} of ${recorded.length} recorded days, and no related action was marked done within ${cfg.actedWithinDays} days of any of them.`,
      evidence: [`${linked.length} of those showings were linked to a problem an action could be recorded against.`],
      counts: { recordedDays: recorded.length, shownDays: exposure.length, linkedDays: linked.length },
      firstObserved: exposure[0].date,
      lastObserved: exposure[exposure.length - 1].date,
      confidence: coverageConfidence(recorded.length, ctx),
      limitations: [LIMITATION_RECORDED_DAYS, "Work done without pressing Done is not recorded."],
    },
  };
}

// ── proposals ─────────────────────────────────────────────────────────────────

function proposalFor(learning: Learning): LearningProposal[] {
  const action = ACTION_LABEL[learning.subject] ?? learning.subject;
  const problem = PROBLEM_LABEL[learning.subject] ?? learning.subject;
  const make = (kind: ProposalKind, statement: string): LearningProposal => ({
    id: `proposal.${kind}:${learning.id}`,
    clinicId: learning.clinicId,
    kind,
    learningId: learning.id,
    subject: learning.subject,
    statement,
    status: "proposed",
    requiresHumanAcceptance: true,
    appliedAutomatically: false,
  });
  switch (learning.kind) {
    case LearningKind.REPEATED_IMPROVEMENT:
      return learning.level === "observed"
        ? []
        : [make(ProposalKind.ACTION_PREFERENCE, `For review: keep "${lowerFirst(action)}" as a first response when ${lowerFirst(problem)} is flagged. ${learning.statement}`)];
    case LearningKind.FASTER_RESOLUTION:
      return [make(ProposalKind.ACTION_PREFERENCE, `For review: consider acting on ${lowerFirst(problem)} earlier in an episode. ${learning.statement}`)];
    case LearningKind.NO_MEASURABLE_CHANGE:
      return [make(ProposalKind.CONFIDENCE_ADJUSTMENT, `For review: show less certainty that "${lowerFirst(action)}" changes anything measurable at this clinic, or change how it is carried out. ${learning.statement}`)];
    case LearningKind.FREQUENTLY_IGNORED:
      return [make(ProposalKind.THRESHOLD_ADJUSTMENT, `For review: check whether the level at which ${lowerFirst(problem)} is flagged suits this clinic. ${learning.statement}`)];
    case LearningKind.RECURRING_UNRESOLVED:
      return [make(ProposalKind.WORKFLOW_IMPROVEMENT, `For review: look again at how ${lowerFirst(problem)} is handled. ${learning.statement}`)];
    case LearningKind.OPPORTUNITY_NOT_ACTED:
      return [make(ProposalKind.WORKFLOW_IMPROVEMENT, `For review: decide whether this opportunity is worth a step in the daily routine, or should be shown less. ${learning.statement}`)];
    default:
      return [];
  }
}

function weekOf(date: string): string {
  const dow = new Date(`${date}T12:00:00.000Z`).getUTCDay();
  return addDays(date, -((dow + 6) % 7));
}
