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

import type { Achievement } from "../../domain";
import {
  BaselineDirection,
  isImprovement,
  isJudgeable,
  type MetricBaseline,
} from "../baseline";
import { ACHIEVEMENT_SPECS, type AchievementSpec } from "./achievement-catalog";

/** Why a candidate did not become an achievement. One entry per gate. */
export type AchievementRejection =
  | "no_baseline"
  | "baseline_too_thin"
  | "not_measured_today"
  | "inside_normal_range"
  | "wrong_direction"
  | "below_minimum_delta"
  | "already_good";

/** One considered metric and what happened to it. The engine's own trace. */
export interface AchievementDecision {
  readonly metricKey: string;
  readonly emitted: boolean;
  readonly rejection?: AchievementRejection;
  /** Plain statement of the arithmetic, for the decision trace. */
  readonly reasoning: string;
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
export function deriveAchievements(params: {
  readonly baselines: ReadonlyMap<string, MetricBaseline>;
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
      decisions.push({
        metricKey: spec.metricKey,
        emitted: false,
        rejection: "no_baseline",
        reasoning: "No history for this metric, so there is no normal range to compare against.",
      });
      continue;
    }

    // Gate 1b — and it rests on enough history to judge against.
    if (!isJudgeable(baseline)) {
      decisions.push({
        metricKey: spec.metricKey,
        emitted: false,
        rejection: "baseline_too_thin",
        reasoning: `Baseline rests on ${baseline.observations} day(s) (${baseline.quality}); too few to call a change unusual.`,
      });
      continue;
    }

    // Gate 1c — and today was measured.
    if (baseline.current === null) {
      decisions.push({
        metricKey: spec.metricKey,
        emitted: false,
        rejection: "not_measured_today",
        reasoning: "Not measured on this date, so there is nothing to compare.",
      });
      continue;
    }

    // Gate 2 — outside this clinic's own band, in the improving direction.
    if (baseline.position === "inside") {
      decisions.push({
        metricKey: spec.metricKey,
        emitted: false,
        rejection: "inside_normal_range",
        reasoning: `${baseline.current} is inside this clinic's normal range ${baseline.lower}..${baseline.upper}.`,
      });
      continue;
    }
    if (!isImprovement(baseline, spec.direction)) {
      decisions.push({
        metricKey: spec.metricKey,
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
        metricKey: spec.metricKey,
        emitted: false,
        rejection: "below_minimum_delta",
        reasoning: `Moved ${magnitude} from a median of ${baseline.median}, below the ${spec.minimumDelta} worth reporting for this metric.`,
      });
      continue;
    }

    // Gate 4 — the clinic was not already good at this.
    if (alreadyGood(baseline.median, spec)) {
      decisions.push({
        metricKey: spec.metricKey,
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
        consecutiveDays: baseline.consecutiveOutside,
        sustained,
        confidence: baseline.confidence,
        measuredAt: params.now,
      },
    });
    decisions.push({
      metricKey: spec.metricKey,
      emitted: true,
      reasoning: `${baseline.current} against a normal of ${baseline.median} (range ${baseline.lower}..${baseline.upper}) over ${baseline.observations} day(s), ${baseline.consecutiveOutside} consecutive day(s) outside it.`,
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
