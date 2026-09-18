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
 * ## Like days, where the clinic has enough of them
 *
 * A band across all weekdays calls every Saturday unusual and every Tuesday
 * normal, at a clinic that opens four hours on Saturday and nine on Tuesday.
 * That is not a finding about the clinic; it is the calendar.
 *
 * So a metric that describes ONE DAY (`MetricSpan.DAY`) is compared against the
 * same weekday, once the clinic has enough of them — six, the same bar every
 * other judgement here uses. Below that it falls back to all days rather than
 * judging against three Saturdays, and `basis` says which happened.
 *
 * A 30-day trailing rate is not split: a window ending on a Saturday contains
 * the same weekdays as one ending on a Tuesday, so splitting would shrink the
 * sample and buy nothing.
 *
 * ## Time of year, when a clinic has a year
 *
 * The same argument holds for seasons — a quiet fortnight in a monsoon is not a
 * failing clinic — but it needs a year of history to make, and it is the honest
 * statement of what is missing: with ten weeks of recorded days, nothing about
 * December can be compared with anything. The rule is implemented and DORMANT:
 * it applies only once the history spans {@link BaselineConfig.seasonalHistoryDays},
 * and `BaselineResult.seasonality` states plainly that it did not.
 *
 * Nothing here extrapolates a season from a short history. A band that cannot be
 * built is not built.
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
import {
  boundsFor,
  clampToBounds,
  rateBasisFor,
  spanFor,
  MetricSpan,
} from "../metrics/metric-bounds";

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
 * Which days a band was built from.
 *
 * Reported rather than assumed, because "your usual" means something different
 * in each case and the sentence a clinic reads has to say which: all your
 * recorded days, or your last nine Tuesdays.
 */
export const BaselineBasis = {
  /** Every measured day in the history. */
  ALL_DAYS: "all_days",
  /** Only days falling on the same weekday as the day being judged. */
  SAME_WEEKDAY: "same_weekday",
  /** Only days near the same point in the year, across the history. */
  SAME_TIME_OF_YEAR: "same_time_of_year",
  /** Both: the same weekday, near the same point in the year. */
  SAME_WEEKDAY_IN_SEASON: "same_weekday_in_season",
} as const;

export type BaselineBasis = (typeof BaselineBasis)[keyof typeof BaselineBasis];

/** Whether time of year could be taken into account, and why not when it could not. */
export interface SeasonalityStatement {
  readonly measurable: boolean;
  /** Days between the oldest and newest history day supplied, inclusive. */
  readonly historyDays: number;
  /** Days of history the rule needs. */
  readonly requiredDays: number;
  /** Plain statement of what was and was not possible. */
  readonly reason: string;
}

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
  /** Which days those were — see {@link BaselineBasis}. */
  readonly basis: BaselineBasis;
  /**
   * The weekday the band is specific to, 0 = Sunday, or null when it is not
   * weekday-specific. A number rather than a name: this engine holds no locale.
   */
  readonly weekday: number | null;
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
  /**
   * Same-weekday days needed before a one-day metric is judged against its own
   * weekday rather than against every day.
   *
   * The same six {@link adequateObservations} uses, and for the same reason:
   * below it a band exists but must not be presented as this clinic's normal.
   * Judging a Saturday against three Saturdays would trade one wrong comparison
   * for another.
   */
  readonly weekdayObservations: number;
  /**
   * Days the history must SPAN before time of year can be taken into account.
   *
   * Just under a year. Below it there is no earlier same-season period to
   * compare against, and nothing in a ten-week history says anything about
   * December.
   */
  readonly seasonalHistoryDays: number;
  /** Days either side of the same point in the year that count as the same season. */
  readonly seasonWindowDays: number;
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
  weekdayObservations: 6,
  // 330 days. A clinic with less than that has no earlier same-season period,
  // and the rule stays dormant rather than inventing one.
  seasonalHistoryDays: 330,
  // Three weeks either side. Wide enough to gather comparable days, narrow
  // enough that a monsoon fortnight is not averaged with a dry one.
  seasonWindowDays: 21,
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
  /** Whether time of year could be taken into account at all, and why not. */
  readonly seasonality: SeasonalityStatement;
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

/** Midnight UTC of a "YYYY-MM-DD", as milliseconds. Dates only; no timezone maths. */
function dayMillis(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

/** Day of the week for a business date, 0 = Sunday. */
function weekdayOf(date: string): number {
  return new Date(dayMillis(date)).getUTCDay();
}

/**
 * Days between two business dates, whole days, ignoring time entirely.
 *
 * Business dates are calendar labels rather than instants, so this is
 * deliberately not a duration: a DST change must not make two dates 0.96 days
 * apart.
 */
function daysApart(a: string, b: string): number {
  return Math.round(Math.abs(dayMillis(a) - dayMillis(b)) / 86_400_000);
}

/**
 * How far apart two dates are in the YEAR, 0..182.
 *
 * Wraps across the new year, so 28 December and 3 January are six days apart
 * rather than three hundred and fifty nine.
 */
function seasonalDistance(a: string, b: string): number {
  const dayOfYear = (date: string) =>
    Math.round((dayMillis(date) - dayMillis(`${date.slice(0, 4)}-01-01`)) / 86_400_000);
  const diff = Math.abs(dayOfYear(a) - dayOfYear(b));
  return Math.min(diff, 365 - diff);
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
  /**
   * The business date being judged, "YYYY-MM-DD".
   *
   * Optional, and its absence is not a default — it is a narrower answer. Without
   * it there is no weekday to match and no point in the year to sit near, so
   * every band is built from all days and says so (`basis: "all_days"`). A
   * caller that has the date should pass it.
   */
  readonly date?: string;
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

  /** One usable measurement: what it read, when, and what stood behind it. */
  interface Observation {
    readonly date: string;
    readonly value: number;
    readonly sample: number | null;
  }

  /** key -> usable observations in calendar order, oldest first. */
  const series = new Map<string, Observation[]>();
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
      let sample: number | null = null;
      if (basis !== undefined) {
        const denominator = denominators.get(basis.denominatorKey);
        if (denominator === undefined || denominator < basis.minimumToJudge) continue;
        sample = denominator;
      }

      const observation: Observation = { date: day.date, value: metric.value, sample };
      const list = series.get(key);
      if (list) list.push(observation);
      else series.set(key, [observation]);
    }
  }

  // Whether time of year can be taken into account AT ALL. One statement per
  // run, because it is a property of the history rather than of any metric.
  const span =
    days.length === 0 ? 0 : daysApart(days[0].date, days[days.length - 1].date) + 1;
  const seasonality: SeasonalityStatement = {
    measurable: params.date !== undefined && span >= config.seasonalHistoryDays,
    historyDays: span,
    requiredDays: config.seasonalHistoryDays,
    reason:
      params.date === undefined
        ? "No date was supplied, so there is no point in the year to compare against."
        : span >= config.seasonalHistoryDays
          ? `History spans ${span} days, enough to compare this time of year against the same weeks before it.`
          : `History spans ${span} days; comparing like for like across a year needs ${config.seasonalHistoryDays}. Nothing here says what this clinic's December looks like.`,
  };

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
    const usable = series.get(key) ?? [];
    const basis = rateBasisFor(key);
    const seen = daysSeen.get(key) ?? 0;

    // Which of this metric's usable days are LIKE the day being judged.
    //
    // Season first, then weekday, because they compose: a Tuesday in October is
    // compared against Tuesdays in October where the history allows it. Each
    // narrowing is taken only when what survives is enough to stand on — the
    // alternative is trading one wrong comparison for a thinner one.
    const selection = selectComparableDays(key, usable);
    const observations = selection.observations;
    const values = observations.map((o) => o.value);
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
    // from the most recent COMPARABLE day; stops at the first that is not on that
    // side. On a weekday band those are consecutive Tuesdays, not consecutive
    // days, which is what `basis` exists to let a reader say correctly.
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
    const sampleValues = observations
      .map((o) => o.sample)
      .filter((v): v is number => v !== null);
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
      basis: selection.basis,
      weekday: selection.weekday,
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
    seasonality,
  };

  /**
   * The days comparable to the one being judged, and what makes them so.
   *
   * Declared inside `deriveBaselines` because it reads the run's own config,
   * date and seasonality statement; it is a step of this function rather than a
   * rule of its own.
   */
  function selectComparableDays(
    key: string,
    usable: readonly Observation[],
  ): {
    readonly observations: readonly Observation[];
    readonly basis: BaselineBasis;
    readonly weekday: number | null;
  } {
    const date = params.date;
    if (date === undefined) {
      return { observations: usable, basis: BaselineBasis.ALL_DAYS, weekday: null };
    }

    // Same time of year, where a year of history exists to define one.
    const inSeason = seasonality.measurable
      ? usable.filter((o) => seasonalDistance(o.date, date) <= config.seasonWindowDays)
      : usable;
    const seasonal =
      seasonality.measurable && inSeason.length >= config.adequateObservations;
    const pool = seasonal ? inSeason : usable;

    // Same weekday, but only for a metric that describes ONE day. A trailing
    // window ending on a Saturday contains the same weekdays as one ending on a
    // Tuesday, so narrowing it would shrink the sample for nothing.
    if (spanFor(key) === MetricSpan.DAY) {
      const weekday = weekdayOf(date);
      const sameWeekday = pool.filter((o) => weekdayOf(o.date) === weekday);
      if (sameWeekday.length >= config.weekdayObservations) {
        return {
          observations: sameWeekday,
          basis: seasonal
            ? BaselineBasis.SAME_WEEKDAY_IN_SEASON
            : BaselineBasis.SAME_WEEKDAY,
          weekday,
        };
      }
    }

    return {
      observations: pool,
      basis: seasonal ? BaselineBasis.SAME_TIME_OF_YEAR : BaselineBasis.ALL_DAYS,
      weekday: null,
    };
  }
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
