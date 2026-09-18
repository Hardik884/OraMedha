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
 * ## A band never runs past the ends of the scale
 *
 * Bands are clamped into the metric's own domain (`metric-bounds.ts`). The
 * clinic's normal no-show range read "-0.1% to 66.7%" before this: the lower
 * edge described a negative share of the appointment book, which is not a low
 * reading but an impossible one, and a reader who sees one impossible number
 * stops believing the other.
 *
 * Clamping is cosmetic on its own, though — it tidies the symptom. The rule
 * below is the fix.
 *
 * ## A rate is not judged without enough behind it
 *
 * A rate arrives with its denominator already divided away, so 1-of-3 and
 * 30-of-90 are the same 33%. Days whose denominator was too small to carry a
 * rate are EXCLUDED from the series rather than averaged into it, because it is
 * exactly those days' swings that widened the band until it meant nothing. When
 * today's own denominator is too small, the baseline still exists and is still
 * reported — with `sample.sufficientToday` false, which `isJudgeable` refuses.
 *
 * "Too few appointments to judge" is the honest reading of a five-appointment
 * week, and it is a different statement from "normal".
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
// What a metric's values can be, and what its rate was divided by. Both belong
// to the metric rather than to this engine — see `metric-bounds.ts`.
import { boundsFor, clampToBounds, rateBasisFor } from "../metrics/metric-bounds";

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

/**
 * The denominator behind a rate, as this baseline actually found it.
 *
 * Present only for metrics that are rates over a countable denominator; null
 * everywhere else, which is most metrics. A count has no denominator to be thin.
 */
export interface BaselineSample {
  /** The metric key holding the denominator, e.g. "scheduling.appointments_30d". */
  readonly key: string;
  /** What that denominator counts, for a sentence a clinic reads. */
  readonly noun: string;
  /** Events needed behind the rate before a band may be judged against it. */
  readonly minimum: number;
  /** Today's denominator, or null when it was not measured today. */
  readonly current: number | null;
  /** Typical denominator across the days the band was built from. */
  readonly median: number;
  /**
   * Whether TODAY's reading has enough behind it to be judged against the band.
   *
   * False is not a failure of the band — the band may be perfectly solid. It
   * says this particular day's rate cannot be distinguished from the movement
   * one appointment would produce.
   */
  readonly sufficientToday: boolean;
  /** History days dropped for too small a denominator. */
  readonly daysExcluded: number;
}

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
  /**
   * The denominator rule this metric is judged under, or null when it is not a
   * rate over a countable denominator.
   */
  readonly sample: BaselineSample | null;
  /**
   * Whether either edge of the band was clamped into the metric's own domain.
   *
   * Reported rather than done quietly: a clamped edge means the arithmetic ran
   * past the end of the scale, which is worth a reader knowing.
   */
  readonly clamped: boolean;
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

/** Why a metric seen in history got no baseline. */
export const BaselineWithholdReason = {
  /** Fewer days than {@link BaselineConfig.minimumObservations}. */
  TOO_FEW_OBSERVATIONS: "too_few_observations",
  /**
   * Days existed, but too few of them carried a denominator large enough for
   * the rate to mean anything. A distinct answer from "no history": the clinic
   * has been measured, it is simply too small for this metric to be judged.
   */
  SAMPLE_TOO_SMALL: "sample_too_small",
} as const;

export type BaselineWithholdReason =
  (typeof BaselineWithholdReason)[keyof typeof BaselineWithholdReason];

/** One metric seen in history that got no band, and why. */
export interface BaselineWithholding {
  readonly key: string;
  readonly reason: BaselineWithholdReason;
  /** Days the history carried a value for this metric. */
  readonly daysSeen: number;
  /** Days that survived the denominator rule — what the band would have used. */
  readonly daysUsable: number;
  /** The denominator rule, when this metric has one. */
  readonly minimumSample?: number;
  /** What that denominator counts. */
  readonly sampleNoun?: string;
  /** Typical denominator across the days seen, when any were measured. */
  readonly medianSample?: number;
}

export interface BaselineResult {
  /** One entry per metric with enough history, sorted by key. */
  readonly baselines: readonly MetricBaseline[];
  /** Lookup by metric key. */
  readonly byKey: ReadonlyMap<string, MetricBaseline>;
  /** Keys seen in history but withheld, sorted. */
  readonly withheldKeys: readonly string[];
  /** The same withholdings with their reasons, so a caller can say which. */
  readonly withheld: readonly BaselineWithholding[];
  /** Lookup by metric key. */
  readonly withheldByKey: ReadonlyMap<string, BaselineWithholding>;
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
  /** key -> the denominator behind each kept value, same order. */
  const sampleSeries = new Map<string, number[]>();
  /** key -> days seen at all, including those the denominator rule dropped. */
  const daysSeen = new Map<string, number>();

  for (const day of days) {
    // Each day's own denominators, read before any of its rates, so a rate is
    // always judged against the sample MEASURED ON THE SAME DAY.
    const denominators = new Map<string, number>();
    for (const metric of day.metrics) {
      if (Number.isFinite(metric.value)) denominators.set(keyOf(metric), metric.value);
    }

    for (const metric of day.metrics) {
      if (!Number.isFinite(metric.value)) continue;
      const key = keyOf(metric);
      daysSeen.set(key, (daysSeen.get(key) ?? 0) + 1);

      // A rate whose denominator that day was too small — or was never recorded
      // at all — is dropped from the series. Averaging it in is what produced a
      // "normal" no-show range running from below zero to two thirds of the
      // book. An unrecorded denominator is dropped for the same reason it is
      // never assumed elsewhere in this module: unknown is not a value.
      const basis = rateBasisFor(key);
      if (basis !== undefined) {
        const denominator = denominators.get(basis.denominatorKey);
        if (denominator === undefined || denominator < basis.minimumToJudge) continue;
        const samples = sampleSeries.get(key);
        if (samples) samples.push(denominator);
        else sampleSeries.set(key, [denominator]);
      }

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
  const withheld: BaselineWithholding[] = [];

  // Keys the denominator rule emptied entirely still have to be reportable: a
  // metric measured every day at a clinic too small to judge it is a different
  // answer from one nobody has ever measured, and the decision trace says which.
  const consideredKeys = [...new Set([...series.keys(), ...daysSeen.keys()])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  for (const key of consideredKeys) {
    const values = series.get(key) ?? [];
    const basis = rateBasisFor(key);
    const seen = daysSeen.get(key) ?? 0;
    const quality = qualityFor(values.length, config);
    if (quality === BaselineQuality.NONE) {
      const droppedForSample = basis !== undefined && seen > values.length;
      withheld.push({
        key,
        // Says which of the two questions failed. "You have no history" and "you
        // have history, and too few appointments in it to judge a rate" lead to
        // different sentences and different remedies.
        reason: droppedForSample
          ? BaselineWithholdReason.SAMPLE_TOO_SMALL
          : BaselineWithholdReason.TOO_FEW_OBSERVATIONS,
        daysSeen: seen,
        daysUsable: values.length,
        ...(basis === undefined
          ? {}
          : { minimumSample: basis.minimumToJudge, sampleNoun: basis.noun }),
      });
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
    // Clamped into the metric's own domain. A band edge outside it is not a low
    // or high reading, it is an impossible one.
    const rawLower = round2(mid - halfWidth);
    const rawUpper = round2(mid + halfWidth);
    const lower = round2(clampToBounds(key, rawLower));
    const upper = round2(clampToBounds(key, rawUpper));

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

    // The denominator as this baseline actually found it. `sufficientToday` is
    // the gate `isJudgeable` applies; the rest is evidence for the sentence.
    const sampleValues = sampleSeries.get(key) ?? [];
    const currentSample =
      basis === undefined ? null : (currentByKey.get(basis.denominatorKey) ?? null);
    const sample: BaselineSample | null =
      basis === undefined
        ? null
        : {
            key: basis.denominatorKey,
            noun: basis.noun,
            minimum: basis.minimumToJudge,
            current: currentSample,
            median: sampleValues.length === 0 ? 0 : round2(median(sampleValues)),
            sufficientToday: currentSample !== null && currentSample >= basis.minimumToJudge,
            daysExcluded: Math.max(0, seen - values.length),
          };

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
      sample,
      clamped: lower !== rawLower || upper !== rawUpper,
      quality,
      position,
      consecutiveOutside,
      confidence: config.confidenceByQuality[quality] as Confidence,
    });
  }

  withheld.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    baselines,
    byKey: new Map(baselines.map((b) => [b.key, b])),
    withheldKeys: withheld.map((w) => w.key),
    withheld,
    withheldByKey: new Map(withheld.map((w) => [w.key, w])),
  };
}

/**
 * Whether a baseline is solid enough to judge against, as opposed to merely
 * existing.
 *
 * The one predicate every consumer should use instead of comparing quality
 * strings itself, so "how much history is enough" is decided in one place.
 *
 * TWO questions, not one, and both must pass: enough DAYS behind the band, and
 * enough EVENTS behind today's reading. A clinic can have six months of no-show
 * rates and still not be judgeable on any of them, because five appointments a
 * week cannot express a rate. {@link hasEnoughHistory} and
 * {@link hasEnoughSampleToday} separate the two for a caller that needs to say
 * which failed.
 */
export function isJudgeable(baseline: MetricBaseline): boolean {
  return hasEnoughHistory(baseline) && hasEnoughSampleToday(baseline);
}

/** Enough DAYS behind the band to treat it as this clinic's normal. */
export function hasEnoughHistory(baseline: MetricBaseline): boolean {
  return (
    baseline.quality === BaselineQuality.ADEQUATE ||
    baseline.quality === BaselineQuality.STRONG
  );
}

/**
 * Enough EVENTS behind today's reading for it to be compared against the band.
 *
 * Always true for a metric that is not a rate: a count of overdue recalls has no
 * denominator that could be thin.
 */
export function hasEnoughSampleToday(baseline: MetricBaseline): boolean {
  return baseline.sample === null || baseline.sample.sufficientToday;
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
