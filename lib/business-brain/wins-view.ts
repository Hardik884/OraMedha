/**
 * lib/business-brain/wins-view.ts
 *
 * The projection behind the Wins strip.
 *
 * Same split as `briefing-view.ts`, for the same reason: the Achievement Engine
 * states measurements — which metric, what it reads now, what this clinic's
 * normal is, how long it has held — and this file writes the sentences a dentist
 * reads. Copy in the engine would put product wording behind a determinism
 * guarantee it does not need, and measurements in the view would put arithmetic
 * somewhere untested.
 *
 * ## What this file may and may not say
 *
 * It may say what moved, what it moved against, by how much, and for how long.
 *
 * It may NOT say the clinic caused it. Nothing in OraMedha records which actions
 * were taken, so "your team's work paid off" would be an invention — and the
 * moment that record exists, the claim belongs in an attribution model with its
 * own confidence ladder rather than smuggled in here as an implication.
 *
 * It may not congratulate. Every string below states a measurement; none of them
 * is praise, because praise is the thing a dentist stops reading first.
 */

import type { Achievement, ClinicDimension, Outcome } from "@/business-brain";
// The baseline and achievement engines are not on the module's public barrel —
// the same direct import `clinic-health.ts` uses for the same reason.
import {
  BaselineDirection,
  BaselineQuality,
  DEFAULT_BASELINE_CONFIG,
} from "@/business-brain/engines/baseline";
import type { AchievementDecision } from "@/business-brain/engines/achievement";
import { outcomeContextFor } from "./outcomes-view";

/** One label/value pair in the expanded evidence list. */
export interface WinEvidence {
  readonly label: string;
  readonly value: string;
}

/**
 * One win, ready to render.
 *
 * `headline` is everything the collapsed card shows; `explanation` and `evidence`
 * are behind the disclosure. The split is the point — the strip has to stay
 * scannable, and a win that needs reading to be understood is a win that gets
 * skipped.
 */
export interface WinView {
  readonly id: string;
  /** What improved, in three or four words. */
  readonly title: string;
  /** The figure and the duration, one line, collapsed state. */
  readonly headline: string;
  /** Why this counts as a measured improvement. Shown only when expanded. */
  readonly explanation: string;
  /** The numbers behind it, in plain words. Shown only when expanded. */
  readonly evidence: readonly WinEvidence[];
  /**
   * What the clinic did that sits alongside this improvement, when anything does.
   *
   * Null is the normal case. Present only when a completed action tracked the
   * SAME metric this win is about, inside the window the win describes, and its
   * targets could be confirmed — and even then it states two facts side by side
   * rather than joining them. Nothing in OraMedha can show that the action
   * produced the improvement, and the sentence says so.
   */
  readonly whatHappenedAfter: string | null;
}

/** Which metric each win is about, in the clinic's words rather than the key. */
const TITLE: Readonly<Record<string, string>> = {
  "scheduling.no_show_rate_30d": "Fewer no-shows",
  "scheduling.cancellation_rate_30d": "Fewer cancellations",
  "capacity.chair_utilization_30d": "Better use of chair time",
  "revenue.production_paid_rate_30d": "More of your work paid for",
  "followups.overdue": "Smaller overdue recall list",
  "queue.average_waiting_time": "Shorter waits for patients",
  "treatment.accepted_pending_scheduling": "More planned treatment booked in",
};

/** How each metric's value reads aloud. */
const UNIT: Readonly<Record<string, "percent" | "minutes" | "patients">> = {
  "scheduling.no_show_rate_30d": "percent",
  "scheduling.cancellation_rate_30d": "percent",
  "capacity.chair_utilization_30d": "percent",
  "revenue.production_paid_rate_30d": "percent",
  "followups.overdue": "patients",
  "queue.average_waiting_time": "minutes",
  "treatment.accepted_pending_scheduling": "patients",
};

/** The dimension name a clinic would recognise, for the evidence list. */
const DIMENSION_LABEL: Readonly<Record<ClinicDimension, string>> = {
  schedule_health: "Schedule health",
  attendance: "Attendance",
  patient_flow: "Patient flow",
  financial_health: "Financial health",
  treatment_pipeline: "Treatment pipeline",
  retention_recall: "Retention & recall",
};

function formatValue(metricKey: string, value: number): string {
  switch (UNIT[metricKey]) {
    case "percent":
      return `${Math.round(value)}%`;
    case "minutes":
      return `${Math.round(value)} min`;
    case "patients": {
      const n = Math.round(value);
      return `${n} patient${n === 1 ? "" : "s"}`;
    }
    default:
      return String(Math.round(value));
  }
}

/** Weekday names, for a baseline built from one weekday's own history. */
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/**
 * Whether this win's normal range is specific to one weekday.
 *
 * It changes what every duration below MEANS: on a weekday baseline,
 * `consecutiveDays` counts Tuesdays, so three of them is three weeks. Saying
 * "3 days running" there would be false.
 */
function weekdayName(achievement: Achievement): string | null {
  const weekdayBasis =
    achievement.basis === "same_weekday" || achievement.basis === "same_weekday_in_season";
  if (!weekdayBasis || achievement.weekday === null || achievement.weekday === undefined) {
    return null;
  }
  return WEEKDAYS[achievement.weekday] ?? null;
}

/** "2nd week running" is wrong for a daily measurement; these are days. */
function durationPhrase(achievement: Achievement): string {
  const weekday = weekdayName(achievement);
  if (achievement.consecutiveDays <= 1) {
    return weekday === null
      ? "first day outside your usual range"
      : `first ${weekday} outside your usual range`;
  }
  return weekday === null
    ? `${achievement.consecutiveDays} days running`
    : `${achievement.consecutiveDays} ${weekday}s running`;
}

/**
 * Whether the metric reads better going down.
 *
 * Derived from the achievement itself rather than re-declared: an improvement
 * whose current value is below its baseline is a lower-is-better metric. Reading
 * it off the data keeps this file from holding a second copy of the catalogue's
 * direction, which could then disagree with it.
 */
function lowerIsBetter(achievement: Achievement): boolean {
  return achievement.current < achievement.baseline;
}

/**
 * Project the engine's achievements into the strip's cards.
 *
 * A pure function of the achievements, so it is testable without a session and
 * cannot reach for data the engine did not verify.
 */
export function buildWins(
  achievements: readonly Achievement[],
  /**
   * Assessed outcomes, so a win can show what the clinic did alongside it.
   *
   * Optional: without them every win renders exactly as before, which is the
   * correct behaviour for a clinic that has completed nothing.
   */
  outcomes: readonly Outcome[] = [],
  now?: string,
): readonly WinView[] {
  const at = now ?? new Date().toISOString();
  return achievements.map((a) => {
    const direction = lowerIsBetter(a) ? "Down" : "Up";
    const current = formatValue(a.metricKey, a.current);
    const baseline = formatValue(a.metricKey, a.baseline);

    return {
      id: a.id,
      title: TITLE[a.metricKey] ?? "Improved",
      // Everything the collapsed card needs: the figure, what it is measured
      // against, and how long it has held.
      headline: `${direction} to ${current} from your usual ${baseline} · ${durationPhrase(a)}`,
      explanation: explain(a, current, baseline),
      evidence: [
        { label: "Now", value: current },
        { label: "Your usual", value: baseline },
        {
          label: "Outside your usual range for",
          value: comparableCount(a, a.consecutiveDays, { consecutive: true }),
        },
        {
          // "Your usual" is only meaningful with the days it was taken from. A
          // Saturday judged against Saturdays and one judged against every day
          // are different claims about the same number.
          label: "Measured against",
          value: `${comparableCount(a, a.observations)} of your own records`,
        },
        { label: "Part of", value: DIMENSION_LABEL[a.dimension] },
      ],
      // Scoped to the days this improvement has actually held, so an action from
      // three weeks ago is never placed beside a win that started yesterday.
      whatHappenedAfter: outcomeContextFor(
        a.metricKey,
        Math.max(a.consecutiveDays, 1),
        outcomes,
        at,
      ),
    };
  });
}

/**
 * Why this counts, in two sentences.
 *
 * The sustained and single-day cases get genuinely different wording rather than
 * a hedge: a first day outside the range is a real reading and a weak one, and
 * saying so is what stops the strip from implying a trend the data does not show
 * yet.
 */
/**
 * "9 days" or "9 Tuesdays" — the unit the baseline actually counted.
 *
 * One helper for both durations, so the collapsed line and the evidence list
 * cannot describe the same baseline differently.
 */
function comparableCount(
  achievement: Achievement,
  count: number,
  options: { consecutive?: boolean } = {},
): string {
  const weekday = weekdayName(achievement);
  const noun = weekday === null ? "day" : weekday;
  const plural = count === 1 ? noun : `${noun}s`;
  return options.consecutive && count > 1 ? `${count} consecutive ${plural}` : `${count} ${plural}`;
}

function explain(achievement: Achievement, current: string, baseline: string): string {
  const better = lowerIsBetter(achievement) ? "below" : "above";
  const weekday = weekdayName(achievement);
  // Where the range is weekday-specific, say so: it is the answer to "but
  // Saturdays are always quiet", and a dentist who does not see it stated will
  // rightly assume the comparison was unfair.
  const against =
    weekday === null
      ? "your own records, not a general benchmark"
      : `your own ${weekday}s, not against your other days and not a general benchmark`;

  if (!achievement.sustained) {
    const opening =
      weekday === null
        ? "Today is the first day this has been"
        : `This is the first ${weekday} this has been`;
    return (
      `${opening} ${better} your clinic's usual range, ` +
      `and the move from ${baseline} to ${current} is larger than this clinic's ` +
      `normal variation. One reading is not yet a trend — if it holds, ` +
      `it will be reported as one. The comparison is against ${against}.`
    );
  }

  return (
    `This has stayed ${better} your clinic's usual range for ` +
    `${comparableCount(achievement, achievement.consecutiveDays)} running, and the move from ${baseline} to ` +
    `${current} is larger than this clinic's normal variation. ` +
    `The comparison is against ${against}.`
  );
}

// ── When there are no wins, which is most days ───────────────────────────────

/**
 * One metric that did not qualify, said out loud.
 *
 * The strip used to render nothing at all when no metric cleared every gate, on
 * the reasoning that an empty box is filler. That was right about the box and
 * wrong about the silence: seven metrics were checked, each for a stated reason,
 * and a dentist who sees nothing cannot tell "we looked and today is ordinary"
 * from "this feature does not work". The test clinic sat in that state for
 * months.
 *
 * Nothing here is a win, and none of it is phrased as one.
 */
export interface NearMissView {
  readonly id: string;
  /** What the metric is, in the clinic's words. */
  readonly title: string;
  /** Where it stands, one line. */
  readonly line: string;
  /**
   * What would have to be true for this to appear as a win — or why it never
   * will. Stated so the absence is falsifiable rather than mysterious.
   */
  readonly whatWouldShowIt: string;
}

/** The whole "nothing to report" state, ready to render. */
export interface WinsEmptyView {
  /** One line: what was checked and what it found. */
  readonly headline: string;
  /**
   * How far the clinic is from having a normal range at all, when that is what
   * is missing. Null once the records are there — an established clinic with an
   * ordinary day is not "still learning".
   */
  readonly learning: string | null;
  /** At most three readings, closest to qualifying first. */
  readonly nearMisses: readonly NearMissView[];
}

/** Rejections that mean "not measurable yet", as opposed to "measured, ordinary". */
const NOT_YET_MEASURABLE: ReadonlySet<string> = new Set([
  "no_baseline",
  "baseline_too_thin",
  "not_measured_today",
  "sample_too_small",
]);

/**
 * How close a reading sits to the edge it would have to clear, as a share of the
 * band's own half-width. 0 means it is at the edge.
 *
 * A ratio, so metrics in different units can be ordered against each other —
 * used for RANKING only and never shown, exactly as the achievement engine's own
 * excursion is.
 */
function distanceToEdge(decision: AchievementDecision): number {
  const b = decision.baseline;
  if (b === undefined || b.current === null) return Number.POSITIVE_INFINITY;
  const halfWidth = Math.abs(b.upper - b.median);
  if (halfWidth <= 0) return Number.POSITIVE_INFINITY;
  const edge = decision.direction === BaselineDirection.LOWER_IS_BETTER ? b.lower : b.upper;
  return Math.abs(b.current - edge) / halfWidth;
}

/** "your usual 3.2%–6.8%", in the metric's own unit. */
function rangePhrase(decision: AchievementDecision): string {
  const b = decision.baseline;
  if (b === undefined) return "your usual range";
  return `${formatValue(decision.metricKey, b.lower)}–${formatValue(decision.metricKey, b.upper)}`;
}

/**
 * What the strip says when no metric cleared every gate.
 *
 * Pure, and built from the Achievement Engine's own decision trace rather than
 * from a second pass over the data — so what is said here cannot disagree with
 * what the engine decided.
 */
export function buildWinsEmptyState(
  decisions: readonly AchievementDecision[],
): WinsEmptyView | null {
  if (decisions.length === 0) return null;
  if (decisions.some((d) => d.emitted)) return null;

  const measurable = decisions.filter(
    (d) => d.rejection !== undefined && !NOT_YET_MEASURABLE.has(d.rejection),
  );

  // How much history the best-served metric has. The learning line is about the
  // clinic's records, not about one metric, so it reports the furthest along.
  const observations = decisions
    .map((d) => d.baseline?.observations ?? 0)
    .reduce((a, b) => Math.max(a, b), 0);
  const needed = DEFAULT_BASELINE_CONFIG.adequateObservations;
  const strong = DEFAULT_BASELINE_CONFIG.strongObservations;
  const anyJudgeable = decisions.some(
    (d) =>
      d.baseline !== undefined &&
      (d.baseline.quality === BaselineQuality.ADEQUATE ||
        d.baseline.quality === BaselineQuality.STRONG),
  );

  // A rate this clinic books too few appointments to judge is NOT the same
  // situation as a clinic that is too new, and waiting will not fix it. Saying
  // "still learning" there would be advice the clinic can follow for a year
  // without effect.
  const tooSmall = decisions.filter((d) => d.rejection === "sample_too_small");
  const smallestSample = tooSmall
    .map((d) => d.baseline?.sample?.minimum)
    .filter((v): v is number => v !== undefined)
    .sort((a, b) => a - b)[0];

  const learning =
    observations === 0 && tooSmall.length === 0
      ? `Nothing to compare against yet — a normal range needs ${needed} comparable days of records.`
      : !anyJudgeable && tooSmall.length === 0
        ? `Still learning what is normal here: ${observations} of the ${needed} comparable days a range needs.`
        : tooSmall.length > 0
          ? `${tooSmall.length} of these are rates over too few appointments to judge${smallestSample === undefined ? "" : ` — a range for them needs at least ${smallestSample} in the window`}.`
          : observations < strong
            ? `Comparisons rest on ${observations} comparable days so far. At ${strong} they stop being provisional.`
            : null;

  const nearMisses: NearMissView[] = [];
  for (const decision of [...measurable].sort((a, b) => distanceToEdge(a) - distanceToEdge(b))) {
    const b = decision.baseline;
    if (b === undefined || b.current === null) continue;
    const title = TITLE[decision.metricKey] ?? "This measure";
    const now = formatValue(decision.metricKey, b.current);
    const towards = decision.direction === BaselineDirection.LOWER_IS_BETTER ? "below" : "above";
    const edge = formatValue(
      decision.metricKey,
      decision.direction === BaselineDirection.LOWER_IS_BETTER ? b.lower : b.upper,
    );

    if (decision.rejection === "already_good") {
      nearMisses.push({
        id: decision.metricKey,
        title,
        line: `${now}, and normally ${formatValue(decision.metricKey, b.median)} — already where it should be.`,
        // Not a gap to close. Saying so is the point: a clinic should not be left
        // wondering why its best measure never appears here.
        whatWouldShowIt: "Nothing to improve, so this will not appear as a win.",
      });
    } else if (decision.rejection === "inside_normal_range") {
      nearMisses.push({
        id: decision.metricKey,
        title,
        line: `${now} today, inside your usual ${rangePhrase(decision)}.`,
        whatWouldShowIt: `It would show here ${towards} ${edge}.`,
      });
    } else if (decision.rejection === "below_minimum_delta") {
      nearMisses.push({
        id: decision.metricKey,
        title,
        line: `${now} today against your usual ${formatValue(decision.metricKey, b.median)} — a real move, too small to call a change.`,
        whatWouldShowIt: `A move of ${formatValue(decision.metricKey, decision.minimumDelta)} or more would show here.`,
      });
    }
    // `wrong_direction` is deliberately absent. A metric moving the wrong way is
    // a problem, and the briefing has a place for problems; dressing it as a
    // near miss in the wins strip would bury it in the quietest block on the page.
    if (nearMisses.length === 3) break;
  }

  const headline =
    nearMisses.length === 0
      ? `Nothing outside your usual range today. All ${decisions.length} measures were checked.`
      : `Nothing outside your usual range today — the closest were:`;

  return { headline, learning, nearMisses };
}
