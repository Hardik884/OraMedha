/**
 * Business Brain — Achievement Engine
 *
 * The positive half of the same evidence. A measured improvement against this
 * clinic's own recorded normal, or nothing.
 *
 * ## Five gates, and each one exists because of a specific failure
 *
 * 1. **Measurable on both sides.** Today's value and a judgeable baseline. A
 *    metric that only started being measured this month has not improved; it has
 *    arrived. A `thin` baseline is explicitly not enough — see `isJudgeable`.
 *    Nor is a thin SAMPLE: a rate over five appointments a week is moved further
 *    by one person's flat tyre than by anything the clinic did, and no number of
 *    days fixes that.
 *
 * 2. **Beyond normal variation.** The value must be outside this clinic's own
 *    band, not merely better than its median. Half of all days are better than
 *    the median by definition, so a median comparison alone would emit a win
 *    roughly every other day and mean nothing.
 *
 * 3. **Absolute minimum.** A movement below the metric's own floor is discarded
 *    however statistically clean it looks. On a quiet clinic a ₹400 change clears
 *    any band; it is still not worth a line.
 *
 * 4. **Not already good.** Judged on the BASELINE, not on today. If the clinic
 *    was already past the point where the metric matters, an improvement implies
 *    a change that did not meaningfully happen.
 *
 * 5. **Sustained, or labelled.** Two consecutive days outside the band is the
 *    default. A single day is still returned — with `sustained: false` — because
 *    suppressing it would hide a real reading; but it travels marked so the view
 *    can say "first day" rather than implying a trend.
 *
 * ## No causal claim, anywhere
 *
 * This engine never says the clinic caused the improvement, and it has no way to.
 * Nothing records which actions were taken, so every statement here is about a
 * measurement moving, not about anyone's work. The moment that record exists,
 * attribution belongs in an Outcome engine with its own confidence ladder — not
 * smuggled in here as an implication.
 *
 * ## Pure
 *
 * Baselines in, achievements out. No clock, no I/O, no randomness; `now` and
 * `date` are supplied by the caller like every other engine in this module.
 */

import type { Achievement, ClinicDimension } from "../../domain";
import {
  BaselineDirection,
  BaselineWithholdReason,
  hasEnoughHistory,
  hasEnoughSampleToday,
  isImprovement,
  type BaselineWithholding,
  type MetricBaseline,
} from "../baseline";
import { ACHIEVEMENT_SPECS, type AchievementSpec } from "./achievement-catalog";

/** Why a candidate did not become an achievement. One entry per gate. */
export type AchievementRejection =
  | "no_baseline"
  | "baseline_too_thin"
  /**
   * The metric is a rate and too few events sit behind it — today's, or the
   * history's. Separate from `baseline_too_thin` because the remedy is
   * different and neither one is the clinic's fault: more days will fix a thin
   * baseline, and only more appointments will fix a thin sample.
   */
  | "sample_too_small"
  | "not_measured_today"
  | "inside_normal_range"
  | "wrong_direction"
  | "below_minimum_delta"
  | "already_good";

/**
 * One considered metric and what happened to it. The engine's own trace.
 *
 * The trace is not debug output. A clinic with no wins is the COMMON case, and
 * the reason each metric did not qualify is the only honest thing there is to
 * say to it — "nothing outside your usual range" is a measurement, and silence
 * is indistinguishable from the check never having run. So a decision carries
 * the reading it was made on, not only a sentence about it, and the view layer
 * writes the English (`lib/business-brain/wins-view.ts`).
 */
export interface AchievementDecision {
  readonly metricKey: string;
  readonly emitted: boolean;
  readonly rejection?: AchievementRejection;
  /** Plain statement of the arithmetic, for the decision trace. */
  readonly reasoning: string;
  readonly dimension: ClinicDimension;
  /** Which direction of movement is an improvement for this metric. */
  readonly direction: BaselineDirection;
  /** Smallest movement worth reporting, in the metric's own unit. */
  readonly minimumDelta: number;
  /**
   * The baseline the decision was made against, when there was one.
   *
   * Absent only for `no_baseline` and the withheld cases — the two situations
   * where there is genuinely nothing to state.
   */
  readonly baseline?: MetricBaseline;
}

export interface AchievementConfig {
  /**
   * Consecutive days outside the band, today included, before an improvement is
   * called sustained.
   */
  readonly sustainedDays: number;
  /**
   * Most achievements to return.
   *
   * Three. A hard cap rather than a soft preference: the risk positive
   * intelligence carries is not that the wins are false, it is that a page
   * showing six of them buries the one problem that needed attention. The cap is
   * the design.
   */
  readonly maximum: number;
}

export const DEFAULT_ACHIEVEMENT_CONFIG: AchievementConfig = {
  sustainedDays: 2,
  maximum: 3,
};

export interface AchievementResult {
  /** Emitted achievements, best-evidenced first, capped at the configured maximum. */
  readonly achievements: readonly Achievement[];
  /**
   * Every catalogued metric considered, with the outcome. Mirrors the Signal
   * Engine's trace: a reader can see that a metric was checked and found not to
   * qualify, which is a different statement from it never having been looked at.
   */
  readonly decisions: readonly AchievementDecision[];
}

/**
 * The part of a decision that comes from the catalogue rather than from the day.
 *
 * Spread into every decision so the trace carries the same context whichever
 * gate ended it — and so adding a field cannot be forgotten at one of nine call
 * sites.
 */
function context(spec: AchievementSpec, baseline?: MetricBaseline) {
  return {
    metricKey: spec.metricKey,
    dimension: spec.dimension,
    direction: spec.direction,
    minimumDelta: spec.minimumDelta,
    ...(baseline === undefined ? {} : { baseline }),
  };
}

/** Was the clinic already past the point where this metric is worth improving? */
function alreadyGood(baseline: number, spec: AchievementSpec): boolean {
  return spec.direction === BaselineDirection.LOWER_IS_BETTER
    ? baseline <= spec.alreadyGoodAt
    : baseline >= spec.alreadyGoodAt;
}

/**
 * How far past the band edge the value sits, as a multiple of the band's own
 * half-width.
 *
 * Used only to ORDER achievements against each other, never reported as a
 * figure: it is a ratio between a clinic's own metrics in different units, which
 * is meaningful for ranking and meaningless as a number on a page.
 */
function excursion(baseline: MetricBaseline): number {
  const halfWidth = Math.abs(baseline.upper - baseline.median);
  if (halfWidth <= 0 || baseline.current === null) return 0;
  const edge = baseline.position === "below" ? baseline.lower : baseline.upper;
  return Math.abs(baseline.current - edge) / halfWidth;
}

/**
 * Find the day's measured improvements.
 *
 * Every catalogued metric is considered and the outcome recorded, so a clinic
 * with no wins produces an empty list plus seven stated reasons — never silence
 * that could be mistaken for the check not running.
 */
/**
 * What to say about a catalogued metric that got no baseline at all.
 *
 * Without the withholding this is one sentence for two different situations:
 * a metric nobody has ever measured, and a metric measured faithfully every day
 * at a clinic too small for the rate to mean anything. The second is not a gap
 * in the records and should never be reported as one.
 */
function describeMissingBaseline(withheld: BaselineWithholding | undefined): {
  readonly rejection: AchievementRejection;
  readonly reasoning: string;
} {
  if (withheld === undefined) {
    return {
      rejection: "no_baseline",
      reasoning: "No history for this metric, so there is no normal range to compare against.",
    };
  }
  if (withheld.reason === BaselineWithholdReason.SAMPLE_TOO_SMALL) {
    return {
      rejection: "sample_too_small",
      reasoning: `Measured on ${withheld.daysSeen} day(s), but only ${withheld.daysUsable} of them had at least ${withheld.minimumSample ?? 0} ${withheld.sampleNoun ?? "events"} behind the rate — too few for a normal range to mean anything.`,
    };
  }
  return {
    rejection: "no_baseline",
    reasoning: `Measured on ${withheld.daysSeen} day(s), too few for a normal range.`,
  };
}

export function deriveAchievements(params: {
  readonly baselines: ReadonlyMap<string, MetricBaseline>;
  /**
   * Metrics the Baseline Engine saw and withheld, with the reason.
   *
   * Optional, and the engine behaves identically without it apart from the
   * wording of a rejection — which is exactly what the decision trace is read
   * for, so the caller should pass it.
   */
  readonly withheld?: ReadonlyMap<string, BaselineWithholding>;
  readonly clinicId: string;
  readonly date: string;
  readonly now: string;
  readonly config?: AchievementConfig;
}): AchievementResult {
  const config = params.config ?? DEFAULT_ACHIEVEMENT_CONFIG;
  const decisions: AchievementDecision[] = [];
  const candidates: { achievement: Achievement; excursion: number }[] = [];

  for (const spec of ACHIEVEMENT_SPECS) {
    const baseline = params.baselines.get(spec.metricKey);

    // Gate 1a — a baseline exists at all.
    if (baseline === undefined) {
      const withheld = params.withheld?.get(spec.metricKey);
      decisions.push({
        ...context(spec),
        emitted: false,
        ...describeMissingBaseline(withheld),
      });
      continue;
    }

    // Gate 1b — and it rests on enough history to judge against.
    if (!hasEnoughHistory(baseline)) {
      decisions.push({
        ...context(spec, baseline),
        emitted: false,
        rejection: "baseline_too_thin",
        reasoning: `Baseline rests on ${baseline.observations} day(s) (${baseline.quality}); too few to call a change unusual.`,
      });
      continue;
    }

    // Gate 1b(ii) — and today's reading has enough events behind it.
    //
    // A rate over a handful of appointments moves further on one person's flat
    // tyre than on anything the clinic changed. The band may be perfectly solid
    // and this day still unjudgeable against it.
    if (!hasEnoughSampleToday(baseline)) {
      const sample = baseline.sample;
      decisions.push({
        ...context(spec, baseline),
        emitted: false,
        rejection: "sample_too_small",
        reasoning:
          sample === null
            ? "Too few events behind today's reading to judge it."
            : sample.current === null
              ? `The ${sample.noun} behind this rate were not measured today, so the rate cannot be judged.`
              : `${sample.current} ${sample.noun} behind this rate, below the ${sample.minimum} it needs before ordinary variation stops moving it further than a real change would.`,
      });
      continue;
    }

    // Gate 1c — and today was measured.
    if (baseline.current === null) {
      decisions.push({
        ...context(spec, baseline),
        emitted: false,
        rejection: "not_measured_today",
        reasoning: "Not measured on this date, so there is nothing to compare.",
      });
      continue;
    }

    // Gate 2 — outside this clinic's own band, in the improving direction.
    if (baseline.position === "inside") {
      decisions.push({
        ...context(spec, baseline),
        emitted: false,
        rejection: "inside_normal_range",
        reasoning: `${baseline.current} is inside this clinic's normal range ${baseline.lower}..${baseline.upper}.`,
      });
      continue;
    }
    if (!isImprovement(baseline, spec.direction)) {
      decisions.push({
        ...context(spec, baseline),
        emitted: false,
        rejection: "wrong_direction",
        reasoning: `${baseline.current} is outside the normal range ${baseline.lower}..${baseline.upper}, but in the direction that is worse for this metric.`,
      });
      continue;
    }

    // Gate 3 — the movement clears the metric's own absolute floor.
    const magnitude = Math.abs(baseline.delta ?? 0);
    if (magnitude < spec.minimumDelta) {
      decisions.push({
        ...context(spec, baseline),
        emitted: false,
        rejection: "below_minimum_delta",
        reasoning: `Moved ${magnitude} from a median of ${baseline.median}, below the ${spec.minimumDelta} worth reporting for this metric.`,
      });
      continue;
    }

    // Gate 4 — the clinic was not already good at this.
    if (alreadyGood(baseline.median, spec)) {
      decisions.push({
        ...context(spec, baseline),
        emitted: false,
        rejection: "already_good",
        reasoning: `This clinic's normal of ${baseline.median} was already at or past ${spec.alreadyGoodAt}, so a further improvement is not a change worth reporting.`,
      });
      continue;
    }

    // Gate 5 — sustained, or emitted and labelled as a single day.
    const sustained = baseline.consecutiveOutside >= config.sustainedDays;
    const bandEdge = baseline.position === "below" ? baseline.lower : baseline.upper;

    candidates.push({
      excursion: excursion(baseline),
      achievement: {
        id: `achievement.${spec.metricKey}:${params.clinicId}:${params.date}`,
        metricKey: spec.metricKey,
        dimension: spec.dimension,
        current: baseline.current,
        baseline: baseline.median,
        delta: baseline.delta ?? 0,
        bandEdge,
        observations: baseline.observations,
        basis: baseline.basis,
        weekday: baseline.weekday,
        consecutiveDays: baseline.consecutiveOutside,
        sustained,
        confidence: baseline.confidence,
        measuredAt: params.now,
      },
    });
    decisions.push({
      ...context(spec, baseline),
      emitted: true,
      reasoning: `${baseline.current} against a normal of ${baseline.median} (range ${baseline.lower}..${baseline.upper}) over ${baseline.observations} comparable day(s) (${baseline.basis}), ${baseline.consecutiveOutside} consecutive one(s) outside it.`,
    });
  }

  // Sustained improvements first, then the largest excursion, then by key so the
  // output is byte-identical across runs over identical data.
  candidates.sort((a, b) => {
    if (a.achievement.sustained !== b.achievement.sustained) {
      return a.achievement.sustained ? -1 : 1;
    }
    if (b.excursion !== a.excursion) return b.excursion - a.excursion;
    return a.achievement.metricKey.localeCompare(b.achievement.metricKey);
  });

  return {
    achievements: candidates.slice(0, config.maximum).map((c) => c.achievement),
    decisions,
  };
}
