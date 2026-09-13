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
  "revenue.collection_rate_30d": "Collecting more of what you deliver",
  "followups.overdue": "Smaller overdue recall list",
  "queue.average_waiting_time": "Shorter waits for patients",
  "treatment.accepted_pending_scheduling": "More planned treatment booked in",
};

/** How each metric's value reads aloud. */
const UNIT: Readonly<Record<string, "percent" | "minutes" | "patients">> = {
  "scheduling.no_show_rate_30d": "percent",
  "scheduling.cancellation_rate_30d": "percent",
  "capacity.chair_utilization_30d": "percent",
  "revenue.collection_rate_30d": "percent",
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

/** "2nd week running" is wrong for a daily measurement; these are days. */
function durationPhrase(consecutiveDays: number): string {
  if (consecutiveDays <= 1) return "first day outside your usual range";
  return `${consecutiveDays} days running`;
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
      headline: `${direction} to ${current} from your usual ${baseline} · ${durationPhrase(a.consecutiveDays)}`,
      explanation: explain(a, current, baseline),
      evidence: [
        { label: "Now", value: current },
        { label: "Your usual", value: baseline },
        {
          label: "Outside your usual range for",
          value:
            a.consecutiveDays <= 1
              ? "1 day"
              : `${a.consecutiveDays} consecutive days`,
        },
        {
          label: "Measured against",
          value: `${a.observations} days of your own records`,
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
function explain(achievement: Achievement, current: string, baseline: string): string {
  const better = lowerIsBetter(achievement) ? "below" : "above";

  if (!achievement.sustained) {
    return (
      `Today is the first day this has been ${better} your clinic's usual range, ` +
      `and the move from ${baseline} to ${current} is larger than this clinic's ` +
      `normal day-to-day variation. One day is not yet a trend — if it holds, ` +
      `it will be reported as one.`
    );
  }

  return (
    `This has stayed ${better} your clinic's usual range for ` +
    `${achievement.consecutiveDays} days running, and the move from ${baseline} to ` +
    `${current} is larger than this clinic's normal day-to-day variation. ` +
    `The comparison is against your own records, not a general benchmark.`
  );
}
