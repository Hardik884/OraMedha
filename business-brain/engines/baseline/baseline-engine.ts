/**
 * Business Brain — Baseline Engine
 *
 * What is NORMAL for this clinic, per metric, from its own measured history.
 *
 * ## Why this exists as its own engine
 *
 * Two kinds of judgement were already in the system and neither answers this
 * question. `signal-thresholds.ts` holds GLOBAL limits — industry benchmarks like
 * a 10% cancellation rate — and `calibration.ts` sizes four of them from the
 * clinic's own 30-day facts. Both produce a single number to compare against.
 * Neither can say whether today is unusual FOR THIS CLINIC, because neither
 * knows the spread.
 *
 * A baseline is a band, not a limit. It answers "is this inside the range this
 * clinic normally runs at", which is the question behind every positive finding,
 * every anomaly, and every honest statement of a trend.
 *
 * ## Median and MAD, never mean and standard deviation
 *
 * Deliberate, and the reason is the shape of dental data rather than statistical
 * fashion. One implant outweighs a month of cleanings; one Saturday closure
 * halves a week's utilization. A mean absorbs those and moves; a standard
 * deviation absorbs them and widens, so the band grows exactly when an outlier
 * appears and the clinic stops being told anything. The median and the median
 * absolute deviation are unmoved by a minority of extreme days, which is the
 * whole property required here.
 *
 * ## This engine reports a BAND. It does not run a test
 *
 * There is no p-value here, no z-score, and no conversion of MAD into sigma. A
 * value outside the band is outside the band — a factual statement about this
 * clinic's own recorded range. Calling that "significant" would claim a
 * probability the sample size cannot support, which is the same discipline the
 * Signal Engine applies when it calls confidence "data completeness" rather than
 * "probability of being right".
 *
 * ## Global benchmarks stay separate, on purpose
 *
 * Nothing here replaces a threshold. A clinic whose normal no-show rate is 35%
 * has a baseline of 35% and a serious problem, and a system that reported only
 * the clinic-relative reading would tell it everything is fine forever. Callers
 * are expected to state both — see `docs`-level guidance in the audit and the
 * absolute floors kept in `signal-thresholds.ts`.
 *
 * ## Pure
 *
 * History and current metrics in, baselines out. No clock, no I/O, no randomness.
 */

import type { Confidence } from "../../types";
import type { Metric } from "../../domain";
// Reused rather than redefined. A second median in the module is a second place
// for the definition to drift, and this one is already the engine's.
import { median } from "../metrics/support/windows";

/**
 * How much history stands behind a baseline.
 *
 * The distinction that matters is between `thin` and `adequate`: below the
 * adequate mark a baseline exists but must not be presented as this clinic's
 * established normal, and no positive finding may rest on it.
 */
export const BaselineQuality = {
  /** Too few observations to describe a range at all. No baseline is produced. */
  NONE: "none",
  /** A range exists but is provisional. Report the raw change, not a judgement. */
  THIN: "thin",
  /** Enough observations to treat the band as this clinic's normal. */
  ADEQUATE: "adequate",
  /** A month or more of observations. */
  STRONG: "strong",
} as const;

export type BaselineQuality = (typeof BaselineQuality)[keyof typeof BaselineQuality];

/** Which direction of movement is an improvement for a metric. */
export const BaselineDirection = {
  /** Lower is better — cancellation rate, waiting time, overdue recalls. */
  LOWER_IS_BETTER: "lower_is_better",
  /** Higher is better — utilization, collection rate. */
  HIGHER_IS_BETTER: "higher_is_better",
} as const;

export type BaselineDirection =
  (typeof BaselineDirection)[keyof typeof BaselineDirection];

/** Which side of the normal band a value falls on. */
export type BandPosition = "above" | "below" | "inside";

/** One metric's normal range, and where today sits in it. */
export interface MetricBaseline {
  /** The metric key, e.g. "scheduling.no_show_rate_30d". */
  readonly key: string;
  /**
   * Today's value, or null when the metric was not measured today.
   *
   * Null is a first-class answer: a baseline for a metric the clinic could not
   * measure today is still worth having (a caller may compare a different day
   * against it), and reporting 0 would be a measurement nobody took.
   */
  readonly current: number | null;
  /** The clinic's typical value — the median of the observed history. */
  readonly median: number;
  /** Median absolute deviation of the history, before flooring. */
  readonly mad: number;
  /**
   * The deviation the band was actually built from.
   *
   * Differs from {@link mad} when the raw MAD was floored — see
   * {@link DEFAULT_BASELINE_CONFIG}. Recorded separately so a reader can see
   * that the band was widened and by how much, rather than wondering why a
   * band is wider than the numbers suggest.
   */
  readonly deviation: number;
  /** Lower edge of the normal band. */
  readonly lower: number;
  /** Upper edge of the normal band. */
  readonly upper: number;
  /** `current - median`, or null when today was not measured. */
  readonly delta: number | null;
  /** Delta as a share of the median (%), or null when undefined or unmeasured. */
  readonly deltaPercent: number | null;
  /** How many days of history the band rests on. */
  readonly observations: number;
  readonly quality: BaselineQuality;
  /** Where today sits, or null when today was not measured. */
  readonly position: BandPosition | null;
  /**
   * Consecutive most-recent observations (today included) that sit outside the
   * band on the SAME side as today. 0 when today is inside the band or absent.
   *
   * This is what lets a caller distinguish a one-day excursion from a settled
   * shift without re-deriving the series.
   */
  readonly consecutiveOutside: number;
  /** Data completeness, from the quality band. Never a probability. */
  readonly confidence: Confidence;
}

export interface BaselineConfig {
  /** Below this many observations no baseline is produced at all. */
  readonly minimumObservations: number;
  /** At or above this, the baseline is `adequate`. */
  readonly adequateObservations: number;
  /** At or above this, the baseline is `strong`. */
  readonly strongObservations: number;
  /**
   * Half-width of the band, in floored MADs.
   *
   * 2 is a deliberately loose band. The cost of a band that is too tight is a
   * clinic told every ordinary Tuesday is unusual, which is the alert-fatigue
   * failure the whole module is built to avoid; the cost of one slightly too
   * wide is a real change reported a day later.
   */
  readonly bandMads: number;
  /**
   * Floor applied to the MAD as a share of the median.
   *
   * A MAD of zero is common and dangerous. Small integer metrics — overdue
   * follow-ups, patients waiting — frequently read identically for days, which
   * collapses the band to a single point and makes the next patient an anomaly.
   * Flooring relative to the median keeps the band proportionate at any scale.
   */
  readonly relativeDeviationFloor: number;
  /**
   * Absolute floor for the MAD, for metrics whose median is at or near zero,
   * where a relative floor also collapses.
   */
  readonly absoluteDeviationFloor: number;
  /** Confidence reported per quality band. Data completeness, not probability. */
  readonly confidenceByQuality: Readonly<Record<BaselineQuality, number>>;
}

export const DEFAULT_BASELINE_CONFIG: BaselineConfig = {
  // Three: the fewest observations from which a median and a spread mean
  // anything at all. Reported as `thin`, never as this clinic's normal.
  minimumObservations: 3,
  // Six, matching the small-data rule the audit set: below six comparable
  // periods, report the raw change and say the baseline is too thin.
  adequateObservations: 6,
  // Fourteen. Two weeks of daily measurement, enough that a single unusual week
  // cannot define the band.
  strongObservations: 14,
  bandMads: 2,
  relativeDeviationFloor: 0.1,
  absoluteDeviationFloor: 0.5,
  confidenceByQuality: {
    [BaselineQuality.NONE]: 0,
    [BaselineQuality.THIN]: 0.4,
    [BaselineQuality.ADEQUATE]: 0.7,
    [BaselineQuality.STRONG]: 0.95,
  },
};

/**
 * One day of measured history.
 *
 * Declared structurally rather than importing `MetricsOnlyDay` from the
 * Diagnosis Engine: this engine has no business depending on that one, and the
 * shape is two fields. Anything carrying a date and its metrics satisfies it.
 */
export interface BaselineHistoryDay {
  /** Business date, "YYYY-MM-DD". */
  readonly date: string;
  readonly metrics: readonly Metric[];
}

export interface BaselineResult {
  /** One entry per metric with enough history, sorted by key. */
  readonly baselines: readonly MetricBaseline[];
  /** Lookup by metric key. */
  readonly byKey: ReadonlyMap<string, MetricBaseline>;
  /** Keys seen in history but withheld for too few observations. */
  readonly withheldKeys: readonly string[];
}

/** Metric ids are `<key>:<clinicId>:<date>`; the key never contains a colon. */
function keyOf(metric: Metric): string {
  const colon = metric.id.indexOf(":");
  return colon === -1 ? metric.id : metric.id.slice(0, colon);
}

/**
 * Median absolute deviation: the median of the distances from the median.
 *
 * Returned RAW, including zero. Flooring is a separate, recorded step so the
 * caller can see both the measured spread and the band actually used.
 *
 * New here because the module had no measure of spread at all — only a median.
 */
export function medianAbsoluteDeviation(
  values: readonly number[],
  centre?: number,
): number {
  if (values.length === 0) return 0;
  const mid = centre ?? median(values);
  return median(values.map((v) => Math.abs(v - mid)));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function qualityFor(observations: number, config: BaselineConfig): BaselineQuality {
  if (observations < config.minimumObservations) return BaselineQuality.NONE;
  if (observations >= config.strongObservations) return BaselineQuality.STRONG;
  if (observations >= config.adequateObservations) return BaselineQuality.ADEQUATE;
  return BaselineQuality.THIN;
}

/**
 * Derive this clinic's normal range for every metric its history supports.
 *
 * `history` is the measured past, EXCLUDING the day being described; `current`
 * is that day's metrics. Keeping them separate is what stops today from being
 * folded into the band it is being judged against — a self-comparison that would
 * pull the median toward today and understate every change.
 *
 * Days are deduplicated by date, keeping the last entry supplied: a caller
 * re-supplying a day is correcting it, the same rule the persistence window uses.
 */
export function deriveBaselines(params: {
  readonly history: readonly BaselineHistoryDay[];
  readonly current: readonly Metric[];
  readonly config?: BaselineConfig;
}): BaselineResult {
  const config = params.config ?? DEFAULT_BASELINE_CONFIG;

  // Deduplicate and order, so the series a baseline rests on is deterministic
  // regardless of the order the caller loaded its history in.
  const byDate = new Map<string, BaselineHistoryDay>();
  for (const day of params.history) byDate.set(day.date, day);
  const days = [...byDate.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );

  /** key -> values in calendar order, oldest first. */
  const series = new Map<string, number[]>();
  for (const day of days) {
    for (const metric of day.metrics) {
      if (!Number.isFinite(metric.value)) continue;
      const key = keyOf(metric);
      const list = series.get(key);
      if (list) list.push(metric.value);
      else series.set(key, [metric.value]);
    }
  }

  const currentByKey = new Map<string, number>();
  for (const metric of params.current) {
    if (!Number.isFinite(metric.value)) continue;
    currentByKey.set(keyOf(metric), metric.value);
  }

  const baselines: MetricBaseline[] = [];
  const withheldKeys: string[] = [];

  for (const [key, values] of [...series.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const quality = qualityFor(values.length, config);
    if (quality === BaselineQuality.NONE) {
      withheldKeys.push(key);
      continue;
    }

    const mid = median(values);
    const rawMad = medianAbsoluteDeviation(values, mid);
    const deviation = Math.max(
      rawMad,
      Math.abs(mid) * config.relativeDeviationFloor,
      config.absoluteDeviationFloor,
    );
    const halfWidth = deviation * config.bandMads;
    const lower = round2(mid - halfWidth);
    const upper = round2(mid + halfWidth);

    const current = currentByKey.has(key) ? (currentByKey.get(key) as number) : null;
    const position: BandPosition | null =
      current === null ? null : current > upper ? "above" : current < lower ? "below" : "inside";

    // Consecutive run ending today on the same side. Walks the history backwards
    // from the most recent day; stops at the first day that is not on that side.
    let consecutiveOutside = 0;
    if (position === "above" || position === "below") {
      consecutiveOutside = 1;
      for (let i = values.length - 1; i >= 0; i -= 1) {
        const onSameSide = position === "above" ? values[i] > upper : values[i] < lower;
        if (!onSameSide) break;
        consecutiveOutside += 1;
      }
    }

    baselines.push({
      key,
      current,
      median: round2(mid),
      mad: round2(rawMad),
      deviation: round2(deviation),
      lower,
      upper,
      delta: current === null ? null : round2(current - mid),
      deltaPercent:
        current === null || mid === 0 ? null : round2(((current - mid) / Math.abs(mid)) * 100),
      observations: values.length,
      quality,
      position,
      consecutiveOutside,
      confidence: config.confidenceByQuality[quality] as Confidence,
    });
  }

  return {
    baselines,
    byKey: new Map(baselines.map((b) => [b.key, b])),
    withheldKeys: withheldKeys.sort(),
  };
}

/**
 * Whether a baseline is solid enough to judge against, as opposed to merely
 * existing.
 *
 * The one predicate every consumer should use instead of comparing quality
 * strings itself, so "how much history is enough" is decided in one place.
 */
export function isJudgeable(baseline: MetricBaseline): boolean {
  return (
    baseline.quality === BaselineQuality.ADEQUATE ||
    baseline.quality === BaselineQuality.STRONG
  );
}

/** Whether today's position represents movement in the improving direction. */
export function isImprovement(
  baseline: MetricBaseline,
  direction: BaselineDirection,
): boolean {
  if (baseline.position === null || baseline.position === "inside") return false;
  return direction === BaselineDirection.LOWER_IS_BETTER
    ? baseline.position === "below"
    : baseline.position === "above";
}
