/**
 * Business Brain — Trajectory Engine
 *
 * How each tracked metric has been moving over the history the run already
 * holds. Pure: history and today's metrics in, trajectories out. No reads, no
 * clock, no model, no randomness — `date` is the only notion of "now".
 *
 * ## The three readings
 *
 * 1. POSITION against a REFERENCE range built by the Baseline Engine from the
 *    EARLIER part of the window only (everything older than `recentDays`). A band
 *    built from the whole window would slowly absorb a lasting problem into
 *    "normal" — after three bad weeks out of five, the median IS the bad level —
 *    and a persistent deterioration could never be seen as one.
 *
 * 2. DIRECTION from WEEKLY MEDIANS. Daily values are noisy and many tracked
 *    metrics are 30-day rolling rates, so the engine compares weeks, and only a
 *    change of at least the metric's `minimumStep` counts. "Worsened for 4
 *    consecutive weeks" means four consecutive week-over-week steps, each material.
 *    A week with too few measured days is unmeasured, and an unmeasured week
 *    breaks a run rather than being bridged.
 *
 * 3. PERSISTENCE in measured days: how long the current run on the bad side has
 *    lasted, and — once back inside — how long it has stayed there.
 *
 * ## The state rules, in order
 *
 *   insufficient_data   no adequate reference, today unmeasured, fewer than
 *                       `minMeasuredWeeks` measured weeks, or coverage below
 *                       `minCoverage`
 *
 *   today worse than normal:
 *     run < persistentDays   worsening if ≥ worseningStepsOutside weekly steps,
 *                            else NEW (a single bad day is never a warning)
 *     run ≥ persistentDays   worsening if ≥ worseningStepsOutside steps,
 *                            improving if ≥ improvingSteps good steps,
 *                            else PERSISTENT
 *
 *   today not worse than normal:
 *     just left an episode of ≥ persistentDays
 *                            RESOLVED once back ≥ resolvedDays, else RECOVERING
 *     otherwise              WORSENING if ≥ worseningStepsWithin steps — flagged
 *                            as a conflict, because the direction and the
 *                            position disagree — else STABLE
 *
 * ## Lifecycle, without storing anything
 *
 * The engine re-classifies the same metric as of each of the previous
 * `lifecycleLookbackDays` days against the same reference, and reads off when
 * the current state began and what it was before. A warning whose state has not
 * changed for `quietAfterDays` is `unchanged`: still true, and not news.
 *
 * ## What it never does
 *
 * Extrapolate. The slope is reported as evidence of how weekly medians have
 * moved; nothing multiplies it forward. And it never names a cause.
 */

import {
  TrajectoryState,
  type Metric,
  type MetricTrajectory,
  type MetricUnit,
  type TrajectoryLifecycle,
  type TrajectoryReference,
  type TrajectoryWeek,
} from "../../domain";
import { addDays, daysBetween } from "../../utils";
import { BaselineQuality, DEFAULT_BASELINE_CONFIG, deriveBaselines } from "../baseline";
import { median } from "../metrics/support/windows";
import { METRIC_DESCRIPTORS, type MetricKey } from "../metrics/metric-ids";
import { TRAJECTORY_CATALOG, type TrajectorySpec } from "./trajectory-catalog";

export interface TrajectoryConfig {
  /** Days examined, today included. Five weeks. */
  readonly windowDays: number;
  /** Most-recent days kept OUT of the reference range. */
  readonly recentDays: number;
  /** A week needs this many measured days to have a median. */
  readonly minObservationsPerWeek: number;
  /** Fewer measured weeks than this and the trajectory is insufficient. */
  readonly minMeasuredWeeks: number;
  /** Fewer measured days than this share of the window and it is insufficient. */
  readonly minCoverage: number;
  /** Measured days on the bad side before a run is persistent rather than new. */
  readonly persistentDays: number;
  /** Measured days back inside before an episode counts as resolved. */
  readonly resolvedDays: number;
  /** Consecutive bad weekly steps that make a worse-than-normal metric worsening. */
  readonly worseningStepsOutside: number;
  /** ...and a metric still inside its normal range. Stricter, because nothing is wrong yet. */
  readonly worseningStepsWithin: number;
  /** Consecutive good weekly steps that make a worse-than-normal metric improving. */
  readonly improvingSteps: number;
  /** Measured weeks needed before a slope is reported. */
  readonly slopeMinWeeks: number;
  readonly lifecycleLookbackDays: number;
  /** A warning unchanged this long is not resurfaced as news. */
  readonly quietAfterDays: number;
  readonly confidenceFloor: number;
  readonly penalties: {
    readonly lowCoverage: number;
    readonly missingWeeks: number;
    readonly worseningWithinNormal: number;
    readonly slopeDisagrees: number;
  };
}

export const DEFAULT_TRAJECTORY_CONFIG: TrajectoryConfig = {
  windowDays: 35,
  recentDays: 14,
  minObservationsPerWeek: 3,
  minMeasuredWeeks: 3,
  minCoverage: 0.5,
  // A full week on the bad side. One bad day, or a bad weekend, is not a trend.
  persistentDays: 7,
  resolvedDays: 7,
  worseningStepsOutside: 2,
  worseningStepsWithin: 3,
  improvingSteps: 2,
  slopeMinWeeks: 4,
  lifecycleLookbackDays: 14,
  quietAfterDays: 7,
  confidenceFloor: 0.05,
  penalties: {
    lowCoverage: 0.1,
    missingWeeks: 0.1,
    worseningWithinNormal: 0.2,
    slopeDisagrees: 0.1,
  },
};

export class TrajectoryIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrajectoryIntegrityError";
  }
}

export interface TrajectoryInput {
  readonly clinicId: string;
  readonly date: string;
  readonly current: readonly Metric[];
  /** Measured days before `date`. Missing days are simply absent. */
  readonly history: readonly { readonly date: string; readonly metrics: readonly Metric[] }[];
  readonly catalog?: readonly TrajectorySpec[];
  readonly config?: Partial<TrajectoryConfig>;
}

export interface TrajectoryResult {
  readonly trajectories: readonly MetricTrajectory[];
  readonly byKey: ReadonlyMap<string, MetricTrajectory>;
}

const WARNING_RANK: Readonly<Record<TrajectoryState, number>> = {
  insufficient_data: 0,
  new: 0,
  stable: 0,
  resolved: 0,
  recovering: 0,
  improving: 1,
  persistent: 2,
  worsening: 3,
};

const isWarning = (s: TrajectoryState) => WARNING_RANK[s] > 0;

function keyOf(metric: Metric): string {
  return metric.id.slice(0, metric.id.indexOf(":"));
}

function clinicOf(metric: Metric): string | null {
  const parts = metric.id.split(":");
  return parts.length >= 3 ? parts[1] : null;
}

/** Trajectories for every catalogued metric, insufficient ones included. */
export function deriveTrajectories(input: TrajectoryInput): TrajectoryResult {
  const config: TrajectoryConfig = {
    ...DEFAULT_TRAJECTORY_CONFIG,
    ...(input.config ?? {}),
    penalties: { ...DEFAULT_TRAJECTORY_CONFIG.penalties, ...(input.config?.penalties ?? {}) },
  };
  const catalog = input.catalog ?? TRAJECTORY_CATALOG;

  const assertClinic = (metric: Metric) => {
    if (clinicOf(metric) !== input.clinicId) {
      throw new TrajectoryIntegrityError(
        `Metric ${metric.id} does not belong to clinic ${input.clinicId}. A trajectory may never mix tenants.`,
      );
    }
  };

  // Deduplicate history by date (last supplied wins, as the Baseline Engine does)
  // and never let a day at or after `date` pose as history.
  const days = new Map<string, readonly Metric[]>();
  for (const day of input.history) {
    if (day.date >= input.date) continue;
    day.metrics.forEach(assertClinic);
    days.set(day.date, day.metrics);
  }
  input.current.forEach(assertClinic);

  const trajectories = catalog.map((spec) => trajectoryFor(spec, input, days, config));
  return { trajectories, byKey: new Map(trajectories.map((t) => [t.metricKey, t])) };
}

// ── one metric ──────────────────────────────────────────────────────────────

interface Evaluation {
  readonly state: TrajectoryState;
  readonly insufficientReason: string | null;
  readonly current: number | null;
  readonly weeks: readonly TrajectoryWeek[];
  readonly measuredWeeks: number;
  readonly worseSteps: number;
  readonly betterSteps: number;
  readonly badRun: number;
  readonly normalRun: number;
  readonly priorBadRun: number;
  readonly observations: number;
  readonly coverage: number;
  readonly firstDetectedDate: string | null;
}

function trajectoryFor(
  spec: TrajectorySpec,
  input: TrajectoryInput,
  days: ReadonlyMap<string, readonly Metric[]>,
  config: TrajectoryConfig,
): MetricTrajectory {
  const series = new Map<string, number>();
  for (const [date, metrics] of days) {
    const metric = metrics.find((m) => keyOf(m) === spec.metricKey);
    if (metric !== undefined && Number.isFinite(metric.value)) series.set(date, metric.value);
  }
  const today = input.current.find((m) => keyOf(m) === spec.metricKey);
  if (today !== undefined && Number.isFinite(today.value)) series.set(input.date, today.value);

  const reference = referenceFor(spec, input, days, config);
  const evaluate = (asOf: string) => evaluateAt(series, asOf, spec, reference, config);
  const now = evaluate(input.date);
  const lifecycle = lifecycleFor(now, evaluate, input.date, config);

  const slope = now.state === TrajectoryState.INSUFFICIENT_DATA ? null : theilSen(now.weeks, config);
  const worseSign = spec.worseWhen === "higher" ? 1 : -1;
  let conflict: MetricTrajectory["conflict"] = null;
  if (now.state === TrajectoryState.WORSENING && reference !== null && now.current !== null && !isWorse(now.current, spec, reference)) {
    conflict = "worsening_within_normal_range";
  } else if (
    slope !== null &&
    ((now.state === TrajectoryState.WORSENING && slope * worseSign <= 0) ||
      (now.state === TrajectoryState.IMPROVING && slope * worseSign >= 0))
  ) {
    conflict = "slope_disagrees_with_weekly_direction";
  }

  const { confidence, basis } = confidenceFor(now, reference, conflict, config);
  const unit = (METRIC_DESCRIPTORS[spec.metricKey as MetricKey]?.unit ?? "count") as MetricUnit;
  const position =
    now.current === null || reference === null
      ? null
      : isWorse(now.current, spec, reference)
        ? "worse_than_normal"
        : isBetter(now.current, spec, reference)
          ? "better_than_normal"
          : "within_normal";

  const trajectory: MetricTrajectory = {
    id: `trajectory.${spec.metricKey}:${input.clinicId}:${input.date}`,
    clinicId: input.clinicId,
    date: input.date,
    metricKey: spec.metricKey,
    label: spec.label,
    unit,
    worseWhen: spec.worseWhen,
    category: spec.category,
    state: now.state,
    lifecycle,
    statement: "",
    insufficientReason: now.insufficientReason,
    current: now.current,
    reference,
    deviation: now.current === null || reference === null ? null : round2(now.current - reference.median),
    position,
    weeks: now.weeks,
    consecutiveWorseningWeeks: now.worseSteps,
    consecutiveImprovingWeeks: now.betterSteps,
    slopePerWeek: slope === null ? null : round2(slope),
    daysWorseThanNormal: now.badRun,
    daysBackToNormal: now.normalRun,
    priorDaysWorseThanNormal: now.priorBadRun,
    observations: now.observations,
    windowDays: config.windowDays,
    coverage: round2(now.coverage),
    firstDetectedDate: now.firstDetectedDate,
    lastChangedDate: now.state === TrajectoryState.INSUFFICIENT_DATA ? null : lifecycle.since,
    conflict,
    confidence,
    confidenceBasis: basis,
  };
  return { ...trajectory, statement: statementFor(trajectory) };
}

/** The earlier normal range, from days older than the recent window. */
function referenceFor(
  spec: TrajectorySpec,
  input: TrajectoryInput,
  days: ReadonlyMap<string, readonly Metric[]>,
  config: TrajectoryConfig,
): TrajectoryReference | null {
  const windowStart = addDays(input.date, -(config.windowDays - 1));
  const lastReferenceDay = addDays(input.date, -config.recentDays);
  const referenceDays = [...days.entries()]
    .filter(([date]) => date >= windowStart && date <= lastReferenceDay)
    .map(([date, metrics]) => ({ date, metrics: metrics.filter((m) => keyOf(m) === spec.metricKey) }))
    .filter((d) => d.metrics.length > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (referenceDays.length === 0) return null;

  const baseline = deriveBaselines({ history: referenceDays, current: [] }).byKey.get(spec.metricKey);
  if (baseline === undefined || baseline.quality === BaselineQuality.NONE) return null;
  return {
    from: referenceDays[0].date,
    to: referenceDays[referenceDays.length - 1].date,
    median: baseline.median,
    lower: baseline.lower,
    upper: baseline.upper,
    observations: baseline.observations,
    quality: baseline.quality as TrajectoryReference["quality"],
  };
}

function isWorse(value: number, spec: TrajectorySpec, reference: TrajectoryReference): boolean {
  return spec.worseWhen === "higher" ? value > reference.upper : value < reference.lower;
}

function isBetter(value: number, spec: TrajectorySpec, reference: TrajectoryReference): boolean {
  return spec.worseWhen === "higher" ? value < reference.lower : value > reference.upper;
}

function evaluateAt(
  series: ReadonlyMap<string, number>,
  asOf: string,
  spec: TrajectorySpec,
  reference: TrajectoryReference | null,
  config: TrajectoryConfig,
): Evaluation {
  const windowStart = addDays(asOf, -(config.windowDays - 1));
  const measured: string[] = [];
  for (let d = windowStart; d <= asOf; d = addDays(d, 1)) if (series.has(d)) measured.push(d);
  const current = series.get(asOf) ?? null;

  const weekCount = Math.floor(config.windowDays / 7);
  const weeks: TrajectoryWeek[] = [];
  for (let k = weekCount - 1; k >= 0; k -= 1) {
    const endsOn = addDays(asOf, -7 * k);
    const startsOn = addDays(endsOn, -6);
    const values = measured.filter((d) => d >= startsOn && d <= endsOn).map((d) => series.get(d) as number);
    weeks.push({
      endsOn,
      value: values.length >= config.minObservationsPerWeek ? round2(median(values)) : null,
      observations: values.length,
    });
  }
  const measuredWeeks = weeks.filter((w) => w.value !== null).length;

  const stepRun = (bad: boolean) => {
    let run = 0;
    for (let i = weeks.length - 1; i > 0; i -= 1) {
      const a = weeks[i - 1].value;
      const b = weeks[i].value;
      if (a === null || b === null) break;
      const diff = b - a;
      const worse = spec.worseWhen === "higher" ? diff >= spec.minimumStep : diff <= -spec.minimumStep;
      const better = spec.worseWhen === "higher" ? diff <= -spec.minimumStep : diff >= spec.minimumStep;
      if (bad ? worse : better) run += 1;
      else break;
    }
    return run;
  };
  const worseSteps = stepRun(true);
  const betterSteps = stepRun(false);
  const observations = measured.length;
  const coverage = observations / config.windowDays;

  const base = {
    current,
    weeks,
    measuredWeeks,
    worseSteps,
    betterSteps,
    observations,
    coverage,
  };
  const insufficient = (reason: string): Evaluation => ({
    ...base,
    state: TrajectoryState.INSUFFICIENT_DATA,
    insufficientReason: reason,
    badRun: 0,
    normalRun: 0,
    priorBadRun: 0,
    firstDetectedDate: null,
  });

  if (reference === null || reference.quality === "thin") {
    return insufficient(
      `fewer than ${DEFAULT_BASELINE_CONFIG.adequateObservations} measured days older than the last ${config.recentDays} to define this clinic's normal range`,
    );
  }
  if (current === null) return insufficient("it was not measured today");
  if (measuredWeeks < config.minMeasuredWeeks) {
    return insufficient(
      `only ${measuredWeeks} of ${weekCount} weeks had at least ${config.minObservationsPerWeek} measured days`,
    );
  }
  if (coverage < config.minCoverage) {
    return insufficient(`only ${observations} of the last ${config.windowDays} days were measured`);
  }

  const descending = [...measured].reverse();
  const worse = (d: string) => isWorse(series.get(d) as number, spec, reference);
  let badRun = 0;
  for (const d of descending) {
    if (worse(d)) badRun += 1;
    else break;
  }
  let normalRun = 0;
  for (const d of descending) {
    if (!worse(d)) normalRun += 1;
    else break;
  }
  let priorBadRun = 0;
  for (const d of descending.slice(normalRun)) {
    if (worse(d)) priorBadRun += 1;
    else break;
  }
  const lastWorse = descending.find(worse);
  let firstDetectedDate: string | null = null;
  if (lastWorse !== undefined) {
    for (const d of descending.slice(descending.indexOf(lastWorse))) {
      if (worse(d)) firstDetectedDate = d;
      else break;
    }
  }

  const done = (state: TrajectoryState): Evaluation => ({
    ...base,
    state,
    insufficientReason: null,
    badRun,
    normalRun: badRun > 0 ? 0 : normalRun,
    priorBadRun: badRun > 0 ? 0 : priorBadRun,
    firstDetectedDate,
  });

  if (badRun > 0) {
    if (worseSteps >= config.worseningStepsOutside) return done(TrajectoryState.WORSENING);
    if (badRun < config.persistentDays) return done(TrajectoryState.NEW);
    if (betterSteps >= config.improvingSteps) return done(TrajectoryState.IMPROVING);
    return done(TrajectoryState.PERSISTENT);
  }
  if (priorBadRun >= config.persistentDays) {
    return done(normalRun >= config.resolvedDays ? TrajectoryState.RESOLVED : TrajectoryState.RECOVERING);
  }
  if (worseSteps >= config.worseningStepsWithin) return done(TrajectoryState.WORSENING);
  return done(TrajectoryState.STABLE);
}

function lifecycleFor(
  now: Evaluation,
  evaluate: (asOf: string) => Evaluation,
  date: string,
  config: TrajectoryConfig,
): TrajectoryLifecycle {
  const state = now.state;
  if (state === TrajectoryState.INSUFFICIENT_DATA) {
    return { status: "not_a_warning", since: null, unchangedDays: null, previousState: null };
  }
  let since = date;
  let previousState: TrajectoryState | null = null;
  for (let back = 1; back <= config.lifecycleLookbackDays; back += 1) {
    const day = addDays(date, -back);
    const earlier = evaluate(day).state;
    // An unmeasurable day is a gap, not a change: look past it.
    if (earlier === TrajectoryState.INSUFFICIENT_DATA) continue;
    if (earlier !== state) {
      previousState = earlier;
      break;
    }
    since = day;
  }
  const unchangedDays = daysBetween(since, date);

  if (state === TrajectoryState.RESOLVED) return { status: "resolved", since, unchangedDays, previousState };
  if (state === TrajectoryState.RECOVERING) return { status: "recovering", since, unchangedDays, previousState };
  if (!isWarning(state)) return { status: "not_a_warning", since, unchangedDays, previousState };
  if (unchangedDays >= config.quietAfterDays) {
    // Still worsening, week on week, is not the same warning seen again: the
    // latest weekly step is itself a material deterioration.
    return state === TrajectoryState.WORSENING && now.worseSteps >= 1
      ? { status: "worsening_further", since, unchangedDays, previousState }
      : { status: "unchanged", since, unchangedDays, previousState };
  }
  if (previousState !== null && isWarning(previousState)) {
    if (WARNING_RANK[state] > WARNING_RANK[previousState]) return { status: "escalated", since, unchangedDays, previousState };
    if (WARNING_RANK[state] < WARNING_RANK[previousState]) return { status: "eased", since, unchangedDays, previousState };
  }
  return { status: "new_warning", since, unchangedDays, previousState };
}

/** Median of pairwise slopes across measured weeks — robust to one odd week. */
function theilSen(weeks: readonly TrajectoryWeek[], config: TrajectoryConfig): number | null {
  const points = weeks.map((w, i) => ({ i, v: w.value })).filter((p): p is { i: number; v: number } => p.v !== null);
  if (points.length < config.slopeMinWeeks) return null;
  const slopes: number[] = [];
  for (let a = 0; a < points.length; a += 1) {
    for (let b = a + 1; b < points.length; b += 1) {
      slopes.push((points[b].v - points[a].v) / (points[b].i - points[a].i));
    }
  }
  return median(slopes);
}

function confidenceFor(
  e: Evaluation,
  reference: TrajectoryReference | null,
  conflict: MetricTrajectory["conflict"],
  config: TrajectoryConfig,
): { confidence: number; basis: string[] } {
  if (e.state === TrajectoryState.INSUFFICIENT_DATA || reference === null) {
    return { confidence: config.confidenceFloor, basis: [`Insufficient: ${e.insufficientReason ?? "no reference range"}.`] };
  }
  const basis = [
    `Normal range from ${reference.observations} earlier measured days (${reference.quality}).`,
    `${e.observations} of ${config.windowDays} days measured; ${e.measuredWeeks} of ${e.weeks.length} weeks.`,
  ];
  let confidence = DEFAULT_BASELINE_CONFIG.confidenceByQuality[reference.quality];
  if (e.coverage < 0.8) {
    confidence -= config.penalties.lowCoverage;
    basis.push(`Confidence reduced by ${config.penalties.lowCoverage}: fewer than 80% of days were measured.`);
  }
  if (e.measuredWeeks < e.weeks.length) {
    confidence -= config.penalties.missingWeeks;
    basis.push(`Confidence reduced by ${config.penalties.missingWeeks}: not every week had enough measured days.`);
  }
  if (conflict === "worsening_within_normal_range") {
    confidence -= config.penalties.worseningWithinNormal;
    basis.push(`Confidence reduced by ${config.penalties.worseningWithinNormal}: the direction is worsening but the value is still within the normal range.`);
  }
  if (conflict === "slope_disagrees_with_weekly_direction") {
    confidence -= config.penalties.slopeDisagrees;
    basis.push(`Confidence reduced by ${config.penalties.slopeDisagrees}: the overall slope disagrees with the recent weekly steps.`);
  }
  return { confidence: round2(Math.max(config.confidenceFloor, confidence)), basis };
}

// ── words ───────────────────────────────────────────────────────────────────

function statementFor(t: MetricTrajectory): string {
  const side = t.worseWhen === "higher" ? "above" : "below";
  const range = t.reference ? `usual ${fmt(t.reference.lower, t.unit)}–${fmt(t.reference.upper, t.unit)}` : "";
  const now = t.current === null ? "" : fmt(t.current, t.unit);
  const weeks = (n: number) => `${n} consecutive week${n === 1 ? "" : "s"}`;

  switch (t.state) {
    case TrajectoryState.INSUFFICIENT_DATA:
      return `Not enough history to judge how ${lower(t.label)} is changing: ${t.insufficientReason}.`;
    case TrajectoryState.NEW:
      return `${t.label} moved ${side} your normal range recently (${now}; ${range}). ${duration(t.daysWorseThanNormal, true)} is not yet a trend.`;
    case TrajectoryState.WORSENING:
      return t.conflict === "worsening_within_normal_range"
        ? `${t.label} has worsened for ${weeks(t.consecutiveWorseningWeeks)} but has not yet moved beyond your normal range (${now}; ${range}).`
        : `${t.label} is ${side} your normal range (${now}; ${range}) and has worsened for ${weeks(t.consecutiveWorseningWeeks)}.`;
    case TrajectoryState.PERSISTENT:
      return `${t.label} has been ${side} your normal range for ${duration(t.daysWorseThanNormal)} (${now}; ${range}), without a sustained change in either direction.`;
    case TrajectoryState.IMPROVING:
      return `${t.label} has been ${side} your normal range for ${duration(t.daysWorseThanNormal)} but has improved for ${weeks(t.consecutiveImprovingWeeks)} (${now}; ${range}).`;
    case TrajectoryState.RECOVERING:
      return `${t.label} is back within your normal range for ${duration(t.daysBackToNormal)}, after ${duration(t.priorDaysWorseThanNormal)} ${side} it (${now}; ${range}).`;
    case TrajectoryState.RESOLVED:
      return `${t.label} has been back within your normal range for ${duration(t.daysBackToNormal)} (${now}; ${range}).`;
    default:
      return `${t.label} is within your normal range with no sustained change (${now}; ${range}).`;
  }
}

/** Measured days as a clinic would say them; weeks from a fortnight up. */
function duration(days: number, capital = false): string {
  const text =
    days >= 14 ? `${Math.floor(days / 7)} weeks` : `${days} measured day${days === 1 ? "" : "s"}`;
  return capital ? text[0].toUpperCase() + text.slice(1) : text;
}

function fmt(value: number, unit: MetricUnit): string {
  const one = Math.round(value * 10) / 10;
  switch (unit) {
    case "percentage":
      return `${one}%`;
    case "minutes":
      return `${Math.round(value)} min`;
    case "days":
      return `${one} days`;
    case "currency":
      return `₹${Math.round(value).toLocaleString("en-IN")}`;
    default:
      return `${one}`;
  }
}

const lower = (s: string) => (s.length === 0 ? s : s[0].toLowerCase() + s.slice(1));
const round2 = (n: number) => Math.round(n * 100) / 100;
