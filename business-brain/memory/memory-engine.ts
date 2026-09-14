/**
 * Business Brain — Clinic Memory engine
 *
 * Derives what one clinic's stored history shows about how it behaves, and checks
 * every pattern against the most recent evidence before calling it active.
 *
 * ## Inputs are already-stored evidence
 *
 *   metric_history     daily readings    → normal ranges, level shifts, weekday patterns
 *   finding_snapshots  what was shown    → recurring problems, opportunities, root causes
 *   outcomes           windowed evidence → what the Learning Engine exposes about actions
 *   clinic_decisions   human choices     → rejected memories; accepted/rejected proposals
 *
 * Nothing here reads a database or a clock, calls a model, or stores anything.
 * The same evidence always derives the same memory, digest included.
 *
 * ## Revalidation, never expiry
 *
 * Each type is re-checked against its most recent evidence on every build — the
 * last 28 days of readings, the last six occurrences of a weekday, the clinic's
 * own interval between recurrences, the last five closed outcomes of an action,
 * or the last 28 recorded briefings. A pattern weakens when that evidence supports
 * it only partly, goes stale when it no longer does or cannot be checked, and is
 * superseded when a newer pattern about the same subject replaces it.
 *
 * ## No positive memory from missing evidence
 *
 * A withheld or truncated kind produces no entry that rests on it. Learnings carry
 * their own evidence standards and gaps; this engine only admits what they expose.
 */

import {
  LearningKind,
  type ClinicDecisionFact,
  type ClinicLearning,
  type ClinicMemory,
  type ClinicMemoryEntry,
  type Learning,
  type MemoryEvidenceRef,
  type MemoryStatus,
  type MemoryStatusReason,
  type MemoryType,
  type Outcome,
  type ResolvedDecision,
} from "../domain";
import type { DismissalFact, FindingSnapshotFact, MetricReadingDay } from "../ledger";
import { addDays, daysBetween } from "../utils";
import { deriveBaselines, type MetricBaseline } from "../engines/baseline";
import { deriveLearning } from "../engines/learning/learning-engine";
import { episodesOf, type Episode } from "../engines/learning/episodes";
import { buildMetric, type MetricKey } from "../engines/metrics/metric-ids";
import { median } from "../engines/metrics/support/windows";
import { localDate } from "../engines/outcome/attribution";
import { OUTCOME_SPECS } from "../engines/outcome/outcome-catalog";
import {
  DEFAULT_MEMORY_CONFIG,
  MEMORY_DERIVATION_VERSION,
  RANGE_METRIC_KEYS,
  WEEKDAY_METRIC_KEYS,
  type MemoryConfig,
} from "./memory-config";

export interface ClinicMemoryInput {
  readonly clinicId: string;
  /** The last completed business day the evidence runs to. */
  readonly date: string;
  readonly timezone: string;
  readonly metricDays: readonly MetricReadingDay[];
  readonly snapshots: readonly FindingSnapshotFact[];
  /** Outcomes assessed with windowed evidence. */
  readonly outcomes: readonly Outcome[];
  readonly dismissals: readonly DismissalFact[];
  readonly decisions: readonly ClinicDecisionFact[];
  /** History kinds withheld or truncated in the read. */
  readonly gaps: readonly string[];
  readonly config?: Partial<MemoryConfig>;
}

export class MemoryIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryIntegrityError";
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function mergeConfig(p: Partial<MemoryConfig> | undefined): MemoryConfig {
  const d = DEFAULT_MEMORY_CONFIG;
  return {
    ...d,
    ...(p ?? {}),
    normalRange: { ...d.normalRange, ...(p?.normalRange ?? {}) },
    historicalChange: { ...d.historicalChange, ...(p?.historicalChange ?? {}) },
    weekday: { ...d.weekday, ...(p?.weekday ?? {}) },
    recurring: { ...d.recurring, ...(p?.recurring ?? {}) },
    rootCause: { ...d.rootCause, ...(p?.rootCause ?? {}) },
    actions: { ...d.actions, ...(p?.actions ?? {}) },
    confidence: { ...d.confidence, ...(p?.confidence ?? {}) },
  };
}

function clinicOfConstraint(id: string): string | null {
  const parts = id.split(":");
  return parts.length >= 3 ? parts[1] : null;
}

/** FNV-1a over a string, as 8 hex digits. Deterministic and dependency-free. */
export function digestOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function memoryId(type: MemoryType, key: string, qualifier: string | null, clinicId: string): string {
  return `memory.${type}:${key}${qualifier === null ? "" : `:${qualifier}`}:${clinicId}`;
}

export function deriveClinicMemory(input: ClinicMemoryInput): ClinicMemory {
  const config = mergeConfig(input.config);
  for (const o of input.outcomes) {
    if (clinicOfConstraint(o.constraintId) !== input.clinicId) throw new MemoryIntegrityError(`Outcome ${o.id} belongs to another clinic.`);
  }
  for (const s of input.snapshots) if (s.clinicId !== input.clinicId) throw new MemoryIntegrityError(`Snapshot ${s.date} belongs to clinic ${s.clinicId}.`);
  for (const d of input.dismissals) if (d.clinicId !== input.clinicId) throw new MemoryIntegrityError(`Dismissal belongs to clinic ${d.clinicId}.`);
  for (const d of input.decisions) if (d.clinicId !== input.clinicId) throw new MemoryIntegrityError(`Decision ${d.id} belongs to clinic ${d.clinicId}.`);

  const from = addDays(input.date, -(config.windowDays - 1));
  const ctx = new Context(input, config, from);

  const entries: ClinicMemoryEntry[] = [];
  if (!ctx.gap("metric_history")) {
    for (const key of RANGE_METRIC_KEYS) {
      entries.push(...historicalChanges(ctx, key));
      entries.push(...normalRange(ctx, key, entries));
    }
    for (const key of WEEKDAY_METRIC_KEYS) for (let w = 0; w < 7; w += 1) entries.push(...weekdayPattern(ctx, key, w));
  }
  if (!ctx.gap("finding_snapshot")) {
    entries.push(...recurring(ctx, "problem"));
    entries.push(...recurring(ctx, "opportunity"));
    entries.push(...recurringRootCauses(ctx));
  }
  const learning = ctx.fullLearning();
  entries.push(...actionMemories(ctx, learning));

  const decisions = resolveDecisions(input.decisions, entries, learning);
  const rejected = new Map(decisions.filter((d) => d.target.type === "memory" && d.decision === "rejected").map((d) => [d.target.id, d]));
  const final = entries
    .map((e) => {
      const r = rejected.get(e.id);
      if (r === undefined) return e;
      return {
        ...e,
        status: "rejected" as const,
        statusReason: { code: "rejected_by_clinic" as const, detail: { decidedAt: r.decidedAt, previousStatus: e.status } },
        evidence: { ...e.evidence, refs: [...e.evidence.refs, { kind: "decision" as const, from: null, to: null, ref: e.id, count: 1 }] },
        confidence: config.confidence.floor,
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    clinicId: input.clinicId,
    builtFor: input.date,
    derivationVersion: MEMORY_DERIVATION_VERSION,
    window: { from, to: input.date },
    entries: final,
    decisions,
    coverage: {
      metricDays: ctx.metricDates().length,
      recordedDays: ctx.days.length,
      outcomes: ctx.outcomes.length,
      gaps: [...new Set(input.gaps)].sort(),
    },
    digest: digestOf(JSON.stringify({ v: MEMORY_DERIVATION_VERSION, entries: final, decisions })),
  };
}

// ── shared ────────────────────────────────────────────────────────────────────

class Context {
  readonly days: readonly FindingSnapshotFact[];
  readonly outcomes: readonly Outcome[];
  private readonly readings = new Map<string, Readonly<Record<string, number>>>();

  constructor(
    readonly input: ClinicMemoryInput,
    readonly config: MemoryConfig,
    readonly from: string,
  ) {
    for (const d of input.metricDays) if (d.date >= from && d.date <= input.date) this.readings.set(d.date, d.values);
    this.days = input.snapshots.filter((s) => s.date >= from && s.date <= input.date).sort((a, b) => (a.date < b.date ? -1 : 1));
    this.outcomes = input.outcomes.filter((o) => {
      const d = localDate(o.completedAt, input.timezone);
      return d >= from && d <= input.date;
    });
  }

  gap(kind: string): boolean {
    return this.input.gaps.includes(kind);
  }

  metricDates(): string[] {
    return [...this.readings.keys()].sort();
  }

  series(key: string, from: string, to: string): { date: string; value: number }[] {
    const out: { date: string; value: number }[] = [];
    for (let d = from < this.from ? this.from : from; d <= to && d <= this.input.date; d = addDays(d, 1)) {
      const v = this.readings.get(d)?.[key];
      if (v !== undefined && Number.isFinite(v)) out.push({ date: d, value: v });
    }
    return out;
  }

  band(key: string, points: readonly { date: string; value: number }[]): MetricBaseline | null {
    const history = points.map((p) => ({
      date: p.date,
      metrics: [buildMetric(key as MetricKey, p.value, this.input.clinicId, p.date, `${p.date}T23:59:59.000Z`)],
    }));
    return deriveBaselines({ history, current: [] }).byKey.get(key) ?? null;
  }

  fullLearning(): ClinicLearning {
    return deriveLearning({
      clinicId: this.input.clinicId,
      date: this.input.date,
      timezone: this.input.timezone,
      outcomes: this.outcomes,
      snapshots: this.days,
      dismissals: this.input.dismissals,
      today: null,
      gaps: this.input.gaps,
      config: { windowDays: this.config.windowDays },
    });
  }

  confidence(base: number, status: MemoryStatus): number {
    const c = this.config.confidence;
    const penalty = status === "weakening" ? c.weakeningPenalty : status === "active" ? 0 : c.stalePenalty;
    return round2(Math.max(c.floor, Math.min(1, base) - penalty));
  }
}

function reason(code: MemoryStatusReason["code"], detail: MemoryStatusReason["detail"] = {}): MemoryStatusReason {
  return { code, detail };
}

function entry(
  ctx: Context,
  e: Omit<ClinicMemoryEntry, "id" | "clinicId" | "confidence"> & { readonly baseConfidence: number },
): ClinicMemoryEntry {
  const { baseConfidence, ...rest } = e;
  return {
    id: memoryId(e.type, e.subject.key, e.subject.qualifier, ctx.input.clinicId),
    clinicId: ctx.input.clinicId,
    ...rest,
    confidence: ctx.confidence(baseConfidence, e.status),
  };
}

const metricRef = (from: string, to: string, count: number): MemoryEvidenceRef => ({ kind: "metric_history", from, to, ref: null, count });
const snapshotRef = (from: string, to: string, count: number): MemoryEvidenceRef => ({ kind: "finding_snapshot", from, to, ref: null, count });

// ── metric memories ───────────────────────────────────────────────────────────

function inside(b: MetricBaseline, v: number): boolean {
  return v >= b.lower && v <= b.upper;
}

/** Sustained level shifts in the window, earliest point of each. */
function changePoints(ctx: Context, key: string): { date: string; before: MetricBaseline; after: { date: string; value: number }[] }[] {
  const cfg = ctx.config.historicalChange;
  const out: { date: string; before: MetricBaseline; after: { date: string; value: number }[] }[] = [];
  let t = addDays(ctx.from, cfg.periodDays);
  const lastStart = addDays(ctx.input.date, -(cfg.periodDays - 1));
  while (t <= lastStart) {
    const beforePts = ctx.series(key, addDays(t, -cfg.periodDays), addDays(t, -1));
    const afterPts = ctx.series(key, t, addDays(t, cfg.periodDays - 1));
    const before = beforePts.length >= cfg.minObservations ? ctx.band(key, beforePts) : null;
    if (before !== null && afterPts.length >= cfg.minObservations) {
      const outside = afterPts.filter((p) => !inside(before, p.value)).length / afterPts.length;
      const afterMedian = median(afterPts.map((p) => p.value));
      // The change point is the first day of the shift itself, not merely a
      // window that happens to contain it.
      if (outside >= cfg.sustainedShare && !inside(before, afterMedian) && !inside(before, afterPts[0].value)) {
        out.push({ date: afterPts[0].date, before, after: afterPts });
        t = addDays(t, cfg.periodDays);
        continue;
      }
    }
    t = addDays(t, 1);
  }
  return out;
}

function historicalChanges(ctx: Context, key: string): ClinicMemoryEntry[] {
  const cfg = ctx.config.historicalChange;
  const recentFrom = addDays(ctx.input.date, -(cfg.periodDays - 1));
  const recent = ctx.series(key, recentFrom, ctx.input.date);
  return changePoints(ctx, key).map((c) => {
    const afterMedian = round2(median(c.after.map((p) => p.value)));
    const stillShifted = recent.length >= cfg.minObservations ? recent.filter((p) => !inside(c.before, p.value)).length / recent.length : null;
    const status: MemoryStatus =
      stillShifted === null ? "stale" : stillShifted >= cfg.sustainedShare ? "active" : stillShifted >= 0.5 ? "weakening" : "stale";
    return entry(ctx, {
      type: "historical_change",
      subject: { kind: "metric", key, qualifier: c.date },
      status,
      statusReason:
        stillShifted === null
          ? reason("not_revalidated", { recentObservations: recent.length })
          : status === "active"
            ? reason("held_in_recent_evidence", { shareOutsidePriorRange: round2(stillShifted) })
            : status === "weakening"
              ? reason("partially_held_in_recent_evidence", { shareOutsidePriorRange: round2(stillShifted) })
              : reason("contradicted_by_recent_evidence", { shareOutsidePriorRange: round2(stillShifted) }),
      facts: {
        changeDate: c.date,
        direction: afterMedian > c.before.median ? "up" : "down",
        beforeMedian: c.before.median,
        beforeLower: c.before.lower,
        beforeUpper: c.before.upper,
        afterMedian,
      },
      evidence: {
        refs: [metricRef(addDays(c.date, -cfg.periodDays), c.after[c.after.length - 1].date, c.before.observations + c.after.length)],
        observationCount: c.before.observations + c.after.length,
        firstObserved: c.date,
        lastObserved: c.after[c.after.length - 1].date,
        supportingPeriod: { from: addDays(c.date, -cfg.periodDays), to: addDays(c.date, cfg.periodDays - 1) },
        coverage: round2((c.before.observations + c.after.length) / (cfg.periodDays * 2)),
      },
      baseConfidence: 0.7,
      revalidation: {
        basis: "recent_28_days",
        window: { from: recentFrom, to: ctx.input.date },
        holds: stillShifted === null ? null : stillShifted >= cfg.sustainedShare,
        requires: { recentObservations: cfg.minObservations },
      },
      supersededBy: null,
    });
  });
}

function normalRange(ctx: Context, key: string, soFar: readonly ClinicMemoryEntry[]): ClinicMemoryEntry[] {
  const cfg = ctx.config.normalRange;
  const date = ctx.input.date;
  const currentId = memoryId("normal_range", key, null, ctx.input.clinicId);
  const recentFrom = addDays(date, -(cfg.periodDays - 1));
  const priorFrom = addDays(date, -(2 * cfg.periodDays - 1));
  const priorTo = addDays(date, -cfg.periodDays);

  const rangeEntry = (
    qualifier: string | null,
    band: MetricBaseline,
    period: { from: string; to: string },
    points: readonly { date: string }[],
    status: MemoryStatus,
    why: MemoryStatusReason,
    holds: boolean | null,
    supersededBy: string | null,
  ) =>
    entry(ctx, {
      type: "normal_range",
      subject: { kind: "metric", key, qualifier },
      status,
      statusReason: why,
      facts: { median: band.median, lower: band.lower, upper: band.upper, deviation: band.deviation, observations: band.observations },
      evidence: {
        refs: [metricRef(period.from, period.to, band.observations)],
        observationCount: band.observations,
        firstObserved: points[0].date,
        lastObserved: points[points.length - 1].date,
        supportingPeriod: period,
        coverage: round2(band.observations / (daysBetween(period.from, period.to) + 1)),
      },
      baseConfidence: band.confidence,
      revalidation: {
        basis: "recent_28_days",
        window: { from: recentFrom, to: date },
        holds,
        requires: { recentObservations: cfg.minObservations },
      },
      supersededBy,
    });

  // A level shift whose new level has been measured long enough replaces the range before it.
  const shift = soFar
    .filter((e) => e.type === "historical_change" && e.subject.key === key && e.status === "active")
    .map((e) => e.subject.qualifier as string)
    .sort()
    .pop();
  if (shift !== undefined) {
    const afterPts = ctx.series(key, shift, date);
    const beforePts = ctx.series(key, addDays(shift, -cfg.periodDays), addDays(shift, -1));
    const after = afterPts.length >= cfg.minObservations ? ctx.band(key, afterPts) : null;
    const before = beforePts.length >= cfg.minObservations ? ctx.band(key, beforePts) : null;
    if (after !== null && before !== null) {
      return [
        rangeEntry(null, after, { from: shift, to: date }, afterPts, "active", reason("held_in_recent_evidence", { sinceChange: shift }), true, null),
        rangeEntry(
          shift,
          before,
          { from: addDays(shift, -cfg.periodDays), to: addDays(shift, -1) },
          beforePts,
          "superseded",
          reason("level_shift", { changeDate: shift }),
          false,
          currentId,
        ),
      ];
    }
  }

  const priorPts = ctx.series(key, priorFrom, priorTo);
  const prior = priorPts.length >= cfg.minObservations ? ctx.band(key, priorPts) : null;
  if (prior === null) return [];
  const recent = ctx.series(key, recentFrom, date);
  const period = { from: priorFrom, to: priorTo };
  if (recent.length < cfg.minRecentObservations) {
    return [rangeEntry(null, prior, period, priorPts, "stale", reason("not_revalidated", { recentObservations: recent.length }), null, null)];
  }
  const share = recent.filter((p) => inside(prior, p.value)).length / recent.length;
  const detail = { shareInside: round2(share), recentObservations: recent.length };
  if (recent.length < cfg.minObservations) {
    return [rangeEntry(null, prior, period, priorPts, "weakening", reason("thin_recent_coverage", detail), null, null)];
  }
  if (share >= cfg.holdShare) return [rangeEntry(null, prior, period, priorPts, "active", reason("held_in_recent_evidence", detail), true, null)];
  if (share >= cfg.weakShare) return [rangeEntry(null, prior, period, priorPts, "weakening", reason("partially_held_in_recent_evidence", detail), false, null)];
  return [rangeEntry(null, prior, period, priorPts, "stale", reason("contradicted_by_recent_evidence", detail), false, null)];
}

function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00.000Z`).getUTCDay();
}

function weekdayPeriod(ctx: Context, key: string, weekday: number, from: string, to: string) {
  const cfg = ctx.config.weekday;
  const all = ctx.series(key, from, to);
  const occ = all.filter((p) => weekdayOf(p.date) === weekday);
  const others = all.filter((p) => weekdayOf(p.date) !== weekday);
  if (occ.length < cfg.minOccurrences || others.length < cfg.minOtherObservations) return { computable: false as const, occ };
  const band = ctx.band(key, others);
  if (band === null) return { computable: false as const, occ };
  const m = median(occ.map((p) => p.value));
  const side: "low" | "high" | null = m < band.lower ? "low" : m > band.upper ? "high" : null;
  const consistency = side === null ? 0 : occ.filter((p) => (side === "low" ? p.value < band.median : p.value > band.median)).length / occ.length;
  // A weekday the clinic is closed reads zero: remembering that is not a pattern.
  const closed = m === 0 && side === "low";
  return { computable: true as const, occ, band, median: m, side, consistency, holds: side !== null && !closed && consistency >= cfg.consistency };
}

function weekdayPattern(ctx: Context, key: string, weekday: number): ClinicMemoryEntry[] {
  const cfg = ctx.config.weekday;
  const date = ctx.input.date;
  const sFrom = addDays(date, -(cfg.supportingDays - 1));
  const oFrom = addDays(sFrom, -cfg.supportingDays);
  const oTo = addDays(sFrom, -1);
  const supporting = weekdayPeriod(ctx, key, weekday, sFrom, date);
  const older = weekdayPeriod(ctx, key, weekday, oFrom, oTo);

  const make = (
    p: Extract<ReturnType<typeof weekdayPeriod>, { computable: true }>,
    period: { from: string; to: string },
    status: MemoryStatus,
    why: MemoryStatusReason,
    holds: boolean | null,
    recentFrom: string | null,
  ) =>
    entry(ctx, {
      type: "weekday_pattern",
      subject: { kind: "metric", key, qualifier: String(weekday) },
      status,
      statusReason: why,
      facts: {
        weekday,
        side: p.side,
        weekdayMedian: round2(p.median),
        otherDaysMedian: p.band.median,
        otherDaysLower: p.band.lower,
        otherDaysUpper: p.band.upper,
        consistency: round2(p.consistency),
        occurrences: p.occ.length,
      },
      evidence: {
        refs: [metricRef(period.from, period.to, p.occ.length + p.band.observations)],
        observationCount: p.occ.length,
        firstObserved: p.occ[0].date,
        lastObserved: p.occ[p.occ.length - 1].date,
        supportingPeriod: period,
        coverage: round2((p.occ.length + p.band.observations) / (daysBetween(period.from, period.to) + 1)),
      },
      baseConfidence: 0.4 + 0.5 * Math.min(1, p.occ.length / 12),
      revalidation: {
        basis: "last_6_weekday_occurrences",
        window: recentFrom === null ? null : { from: recentFrom, to: date },
        holds,
        requires: { weekdayOccurrences: cfg.recentOccurrences },
      },
      supersededBy: null,
    });

  if (supporting.computable && supporting.holds) {
    const recent = supporting.occ.slice(-cfg.recentOccurrences);
    const share =
      recent.filter((p) => (supporting.side === "low" ? p.value < supporting.band.median : p.value > supporting.band.median)).length / recent.length;
    const detail = { recentShare: round2(share), recentOccurrences: recent.length };
    const status: MemoryStatus = share >= cfg.consistency ? "active" : share >= cfg.weakShare ? "weakening" : "stale";
    return [
      make(
        supporting,
        { from: sFrom, to: date },
        status,
        status === "active"
          ? reason("held_in_recent_evidence", detail)
          : status === "weakening"
            ? reason("partially_held_in_recent_evidence", detail)
            : reason("contradicted_by_recent_evidence", detail),
        share >= cfg.consistency,
        recent[0].date,
      ),
    ];
  }
  if (older.computable && older.holds) {
    return [
      make(
        older,
        { from: oFrom, to: oTo },
        "stale",
        supporting.computable
          ? reason("contradicted_by_recent_evidence", { recentConsistency: round2(supporting.consistency) })
          : reason("not_revalidated", { recentOccurrences: supporting.occ.length }),
        supporting.computable ? false : null,
        supporting.occ[0]?.date ?? null,
      ),
    ];
  }
  return [];
}

// ── snapshot memories ─────────────────────────────────────────────────────────

function recurring(ctx: Context, kind: "problem" | "opportunity"): ClinicMemoryEntry[] {
  const cfg = ctx.config.recurring;
  if (ctx.days.length < cfg.minRecordedDays) return [];
  const subjects = new Set<string>();
  for (const day of ctx.days) {
    for (const f of day.findings) {
      if (kind === "problem" && f.polarity === "negative" && f.category !== null) subjects.add(f.category);
      if (kind === "opportunity" && f.kind === "opportunity") subjects.add(opportunityTypeOf(f.findingId));
    }
  }
  const date = ctx.input.date;
  const out: ClinicMemoryEntry[] = [];
  for (const subject of [...subjects].sort()) {
    const days = ctx.days.map((d) => ({
      date: d.date,
      flagged: d.findings.some((f) =>
        kind === "problem" ? f.polarity === "negative" && f.category === subject : f.kind === "opportunity" && opportunityTypeOf(f.findingId) === subject,
      ),
    }));
    const episodes = episodesOf(days);
    if (episodes.length < cfg.minEpisodes) continue;
    const starts = episodes.map((e) => e.start);
    const gaps = starts.slice(1).map((s, i) => daysBetween(starts[i], s));
    const medianGap = median(gaps);
    const closed = episodes.filter((e): e is Episode & { length: number } => e.length !== null).map((e) => e.length);
    const last = episodes[episodes.length - 1];
    const sinceStart = daysBetween(last.start, date);
    const flaggedDays = days.filter((d) => d.flagged).length;

    let status: MemoryStatus;
    let why: MemoryStatusReason;
    if (last.end === null || sinceStart <= medianGap) {
      status = "active";
      why = reason("held_in_recent_evidence", { daysSinceLastStart: sinceStart, medianIntervalDays: round2(medianGap) });
    } else {
      const span = Math.max(1, daysBetween(last.end, date));
      const recorded = ctx.days.filter((d) => d.date > (last.end as string)).length;
      const coverage = recorded / span;
      if (coverage < cfg.minRecentCoverage) {
        status = "stale";
        why = reason("not_revalidated", { recordedDaysSinceLastEpisode: recorded, daysSinceLastEpisode: span });
      } else {
        status = sinceStart <= 2 * medianGap ? "weakening" : "stale";
        why = reason("not_recurred_within_interval", { daysSinceLastStart: sinceStart, medianIntervalDays: round2(medianGap) });
      }
    }
    out.push(
      entry(ctx, {
        type: kind === "problem" ? "recurring_problem" : "recurring_opportunity",
        subject: { kind: kind === "problem" ? "category" : "opportunity", key: subject, qualifier: null },
        status,
        statusReason: why,
        facts: {
          episodes: episodes.length,
          closedEpisodes: closed.length,
          recurrencesAfterResolution: episodes.filter((e, i) => i > 0 && episodes[i - 1].end !== null).length,
          medianIntervalDays: round2(medianGap),
          typicalResolutionDays: closed.length >= 2 ? round2(median(closed)) : null,
          flaggedDays,
          lastEpisodeStart: last.start,
          currentlyFlagged: last.end === null ? 1 : 0,
          windowDays: ctx.config.windowDays,
        },
        evidence: {
          refs: [snapshotRef(ctx.days[0].date, ctx.days[ctx.days.length - 1].date, ctx.days.length)],
          observationCount: flaggedDays,
          firstObserved: episodes[0].start,
          lastObserved: [...days].reverse().find((d) => d.flagged)?.date ?? last.start,
          supportingPeriod: { from: ctx.days[0].date, to: date },
          coverage: round2(ctx.days.length / (daysBetween(ctx.days[0].date, date) + 1)),
        },
        baseConfidence: 0.4 + 0.5 * Math.min(1, ctx.days.length / (daysBetween(ctx.days[0].date, date) + 1)),
        revalidation: {
          basis: "last_recurrence_interval",
          window: { from: last.start, to: date },
          holds: status === "active",
          requires: { recordedDaysShare: cfg.minRecentCoverage },
        },
        supersededBy: null,
      }),
    );
  }
  return out;
}

function opportunityTypeOf(findingId: string): string {
  const match = /opportunity\.([a-z_]+):/.exec(findingId);
  return match ? match[1] : "unknown";
}

function weekOf(date: string): string {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

function recurringRootCauses(ctx: Context): ClinicMemoryEntry[] {
  const cfg = ctx.config.rootCause;
  // question → analysed dates; `${question}.${dimension}|group` → dates observed.
  const analysed = new Map<string, Set<string>>();
  const observed = new Map<string, Set<string>>();
  for (const day of ctx.days) {
    for (const f of day.findings) {
      for (const rc of f.rootCauses ?? []) {
        if (rc.outcome === "insufficient_evidence") continue;
        analysed.set(rc.question, (analysed.get(rc.question) ?? new Set()).add(day.date));
        for (const a of rc.associations) {
          if (a.dimension === "treatment_type") continue;
          const k = `${rc.question}.${a.dimension}|${a.group}`;
          observed.set(k, (observed.get(k) ?? new Set()).add(day.date));
        }
      }
    }
  }
  const date = ctx.input.date;
  const out: ClinicMemoryEntry[] = [];
  for (const [k, dates] of [...observed.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [subjectKey, group] = k.split("|");
    const question = subjectKey.split(".")[0];
    const analysedDates = [...(analysed.get(question) ?? new Set<string>())].sort();
    const seen = [...dates].sort();
    const share = seen.length / Math.max(1, analysedDates.length);
    if (seen.length < cfg.minObservedDays || new Set(seen.map(weekOf)).size < cfg.minWeeks || share < cfg.minShare) continue;

    const recentDays = ctx.days.slice(-cfg.recentRecordedDays).map((d) => d.date);
    const recentAnalysed = analysedDates.filter((d) => recentDays.includes(d));
    const recentSeen = seen.filter((d) => recentDays.includes(d));
    const recentShare = recentAnalysed.length === 0 ? 0 : recentSeen.length / recentAnalysed.length;
    const detail = { recentShare: round2(recentShare), recentAnalysedDays: recentAnalysed.length };
    let status: MemoryStatus;
    let why: MemoryStatusReason;
    if (recentAnalysed.length < cfg.minRecentAnalysedDays) {
      status = "stale";
      why = reason("not_revalidated", detail);
    } else if (recentShare >= cfg.minShare) {
      status = "active";
      why = reason("held_in_recent_evidence", detail);
    } else if (recentShare >= cfg.weakShare) {
      status = "weakening";
      why = reason("partially_held_in_recent_evidence", detail);
    } else {
      status = "stale";
      why = reason("contradicted_by_recent_evidence", detail);
    }
    out.push(
      entry(ctx, {
        type: "recurring_root_cause",
        subject: { kind: "root_cause", key: subjectKey, qualifier: group },
        status,
        statusReason: why,
        facts: { observedDays: seen.length, analysedDays: analysedDates.length, share: round2(share), weeks: new Set(seen.map(weekOf)).size },
        evidence: {
          refs: [snapshotRef(analysedDates[0], analysedDates[analysedDates.length - 1], analysedDates.length)],
          observationCount: seen.length,
          firstObserved: seen[0],
          lastObserved: seen[seen.length - 1],
          supportingPeriod: { from: analysedDates[0], to: date },
          coverage: round2(analysedDates.length / (daysBetween(analysedDates[0], date) + 1)),
        },
        baseConfidence: 0.4 + 0.5 * share,
        revalidation: {
          basis: "last_28_recorded_days",
          window: recentDays.length === 0 ? null : { from: recentDays[0], to: date },
          holds: recentAnalysed.length < cfg.minRecentAnalysedDays ? null : recentShare >= cfg.minShare,
          requires: { analysedDays: cfg.minRecentAnalysedDays },
        },
        supersededBy: null,
      }),
    );
  }
  return out;
}

// ── action memories ───────────────────────────────────────────────────────────

const ACTION_TYPE: Readonly<Record<string, MemoryType>> = {
  [LearningKind.REPEATED_IMPROVEMENT]: "action_effective",
  [LearningKind.NO_MEASURABLE_CHANGE]: "action_no_change",
  [LearningKind.FREQUENTLY_IGNORED]: "action_ignored",
  [LearningKind.TIME_TO_OUTCOME]: "action_time_to_result",
};

const OPPOSITE: Readonly<Record<string, string>> = {
  [LearningKind.REPEATED_IMPROVEMENT]: LearningKind.NO_MEASURABLE_CHANGE,
  [LearningKind.NO_MEASURABLE_CHANGE]: LearningKind.REPEATED_IMPROVEMENT,
};

function actionMemories(ctx: Context, full: ClinicLearning): ClinicMemoryEntry[] {
  const cfg = ctx.config.actions;
  const date = ctx.input.date;
  const tz = ctx.input.timezone;
  // Revalidation evidence: each action's most recent closed outcomes, and the most
  // recent recorded briefings. The same Learning Engine, the same standards.
  const recentOutcomes = OUTCOME_SPECS.flatMap((spec) =>
    ctx.outcomes
      .filter((o) => o.category === spec.category && o.evidence?.window === "closed")
      .sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))
      .slice(-cfg.recentOutcomes),
  );
  const recentDays = ctx.days.slice(-cfg.recentRecordedDays);
  const recent = deriveLearning({
    clinicId: ctx.input.clinicId,
    date,
    timezone: tz,
    outcomes: recentOutcomes,
    snapshots: recentDays,
    dismissals: ctx.input.dismissals,
    today: null,
    gaps: ctx.input.gaps,
    config: { windowDays: ctx.config.windowDays },
  });
  const find = (l: ClinicLearning, kind: string, subject: string) => l.learnings.find((x) => x.kind === kind && x.subject === subject);
  const status = (l: ClinicLearning, kind: string, subject: string) => l.assessments.find((a) => a.kind === kind && a.subject === subject)?.status;

  const out: ClinicMemoryEntry[] = [];
  const emitted = new Set<string>();
  const make = (learning: Learning, status: MemoryStatus, why: MemoryStatusReason, holds: boolean | null, supersededBy: string | null, basis: ClinicMemoryEntry["revalidation"]["basis"]) => {
    const type = ACTION_TYPE[learning.kind];
    const e = entry(ctx, {
      type,
      subject: { kind: "category", key: learning.subject, qualifier: null },
      status,
      statusReason: why,
      facts: { level: learning.level, ...learning.counts },
      evidence: {
        refs: [
          { kind: "learning", from: learning.firstObserved, to: learning.lastObserved, ref: learning.id, count: learning.counts.outcomes ?? learning.counts.recordedDays ?? 0 },
        ],
        observationCount: learning.counts.outcomes ?? learning.counts.recommendedDays ?? learning.counts.results ?? 0,
        firstObserved: learning.firstObserved,
        lastObserved: learning.lastObserved,
        supportingPeriod: { from: learning.firstObserved, to: learning.lastObserved },
        coverage: 1,
      },
      baseConfidence: learning.confidence,
      revalidation: {
        basis,
        window: null,
        holds,
        requires: basis === "last_28_recorded_days" ? { recordedDays: cfg.recentRecordedDays } : { closedOutcomes: cfg.recentOutcomes },
      },
      supersededBy,
    });
    if (!emitted.has(e.id)) {
      emitted.add(e.id);
      out.push(e);
    }
    return e.id;
  };

  for (const spec of OUTCOME_SPECS) {
    const category = spec.category;
    const completionDates = ctx.outcomes
      .filter((o) => o.category === category)
      .map((o) => localDate(o.completedAt, tz))
      .sort();
    const intervals = completionDates.slice(1).map((d, i) => daysBetween(completionDates[i], d));
    const cadence = intervals.length === 0 ? null : median(intervals);
    const sinceLast = completionDates.length === 0 ? null : daysBetween(completionDates[completionDates.length - 1], date);
    const unrepeated = cadence !== null && sinceLast !== null && sinceLast > cfg.staleAfterIntervals * cadence;

    for (const kind of [LearningKind.REPEATED_IMPROVEMENT, LearningKind.NO_MEASURABLE_CHANGE, LearningKind.TIME_TO_OUTCOME]) {
      const fullL = find(full, kind, category);
      const recentL = find(recent, kind, category);
      const oppositeKind = OPPOSITE[kind];
      const recentOpposite = oppositeKind === undefined ? undefined : find(recent, oppositeKind, category);
      if (fullL !== undefined) {
        if (recentL !== undefined) {
          make(recentL.level === fullL.level ? fullL : recentL, "active", reason("held_in_recent_evidence", { recentOutcomes: recentL.counts.outcomes ?? 0 }), true, null, "last_5_closed_outcomes");
        } else if (recentOpposite !== undefined) {
          const newer = make(recentOpposite, "active", reason("held_in_recent_evidence", { recentOutcomes: recentOpposite.counts.outcomes ?? 0 }), true, null, "last_5_closed_outcomes");
          make(fullL, "superseded", reason("replaced_by_newer_pattern", { by: recentOpposite.kind }), false, newer, "last_5_closed_outcomes");
        } else if (unrepeated) {
          make(fullL, "stale", reason("not_revalidated", { daysSinceLastCompletion: sinceLast, typicalIntervalDays: round2(cadence as number) }), null, null, "clinic_completion_cadence");
        } else {
          make(fullL, "weakening", reason("partially_held_in_recent_evidence", { recentAssessment: status(recent, kind, category) ?? "none" }), false, null, "last_5_closed_outcomes");
        }
      } else if (recentL !== undefined && !emitted.has(memoryId(ACTION_TYPE[kind], category, null, ctx.input.clinicId))) {
        // Established only by the most recent outcomes: a newer pattern the longer
        // history has not caught up with yet.
        make(recentL, "active", reason("held_in_recent_evidence", { recentOutcomes: recentL.counts.outcomes ?? 0 }), true, null, "last_5_closed_outcomes");
      }
    }

    const ignored = find(full, LearningKind.FREQUENTLY_IGNORED, category);
    if (ignored !== undefined) {
      const recentStatus = status(recent, LearningKind.FREQUENTLY_IGNORED, category);
      if (recentStatus === "detected") {
        make(ignored, "active", reason("held_in_recent_evidence", { recordedDays: recentDays.length }), true, null, "last_28_recorded_days");
      } else if (recentStatus === "not_detected") {
        make(ignored, "stale", reason("contradicted_by_recent_evidence", { recordedDays: recentDays.length }), false, null, "last_28_recorded_days");
      } else {
        make(ignored, "stale", reason("not_revalidated", { recordedDays: recentDays.length }), null, null, "last_28_recorded_days");
      }
    }
  }
  return out;
}

// ── decisions ─────────────────────────────────────────────────────────────────

/**
 * The decision governing each target: the latest one, unless it was revoked.
 * An accepted decision whose evidence is no longer current is flagged for review,
 * never withdrawn.
 */
export function resolveDecisions(
  decisions: readonly ClinicDecisionFact[],
  entries: readonly ClinicMemoryEntry[],
  learning: ClinicLearning | null,
): ResolvedDecision[] {
  const byTarget = new Map<string, ClinicDecisionFact[]>();
  for (const d of decisions) {
    const k = `${d.target.type}|${d.target.id}`;
    byTarget.set(k, [...(byTarget.get(k) ?? []), d]);
  }
  const proposals = new Set((learning?.proposals ?? []).map((p) => p.id));
  const active = new Map(entries.map((e) => [e.id, e.status]));
  const out: ResolvedDecision[] = [];
  for (const list of byTarget.values()) {
    const ordered = [...list].sort((a, b) => Date.parse(a.decidedAt) - Date.parse(b.decidedAt) || (a.id < b.id ? -1 : 1));
    const latest = ordered[ordered.length - 1];
    if (latest.decision === "revoked") continue;
    const current =
      latest.target.type === "proposal" ? learning === null || proposals.has(latest.target.id) : active.get(latest.target.id) === "active";
    out.push({
      target: latest.target,
      proposalKind: latest.proposalKind,
      subject: latest.subject,
      decision: latest.decision,
      decidedAt: latest.decidedAt,
      basis: latest.basis,
      history: ordered.slice(0, -1).map((d) => ({ decision: d.decision, decidedAt: d.decidedAt })),
      needsReview: latest.decision === "accepted" && !current,
    });
  }
  return out.sort((a, b) => (a.target.id < b.target.id ? -1 : a.target.id > b.target.id ? 1 : 0));
}
