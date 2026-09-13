/**
 * Business Brain — Domain: Trajectory
 *
 * How one metric has been MOVING, not only where it stands today — measured
 * from the history the run already holds, never forecast.
 *
 * A trajectory is built from three independent readings, and every one is
 * carried on the object so a statement about it can be checked:
 *
 *   position     where the value sits against this clinic's earlier normal range
 *   direction    whether weekly medians have moved the bad way, the good way, or
 *                not materially, and for how many consecutive weeks
 *   persistence  how many recent measured days have been on the bad side, and
 *                how many since it returned
 *
 * The state is a fixed rule over those readings — see the engine. Nothing here
 * extrapolates a future value.
 */

import type { Confidence } from "../types";
import type { ConstraintCategory } from "./constraint";
import type { MetricUnit } from "./metric";

export const TrajectoryState = {
  /** Too little measured history to say how it is moving. Never read as "fine". */
  INSUFFICIENT_DATA: "insufficient_data",
  /** Worse than normal, but only recently — not yet a trend. Never a warning on its own. */
  NEW: "new",
  /** Worse than normal for a sustained run, not materially changing. */
  PERSISTENT: "persistent",
  /** Weekly medians have moved the bad way for consecutive weeks. */
  WORSENING: "worsening",
  /** Within normal, no sustained movement. */
  STABLE: "stable",
  /** Still worse than normal, but weekly medians are moving the good way. */
  IMPROVING: "improving",
  /** Back within normal after a sustained episode, but not yet for long. */
  RECOVERING: "recovering",
  /** Back within normal long enough that the episode is over. */
  RESOLVED: "resolved",
} as const;

export type TrajectoryState = (typeof TrajectoryState)[keyof typeof TrajectoryState];

/** One week of daily readings, reduced to a median. */
export interface TrajectoryWeek {
  /** Last date the week covers, "YYYY-MM-DD". */
  readonly endsOn: string;
  /** Median of the week's measured days; null when too few days were measured. */
  readonly value: number | null;
  readonly observations: number;
}

/** The clinic's earlier normal range the trajectory is judged against. */
export interface TrajectoryReference {
  /** Oldest and newest dates the reference rests on. */
  readonly from: string;
  readonly to: string;
  readonly median: number;
  readonly lower: number;
  readonly upper: number;
  readonly observations: number;
  readonly quality: "thin" | "adequate" | "strong";
}

/** Whether a warning is new, changed, or the same one seen again. */
export interface TrajectoryLifecycle {
  /**
   * not_a_warning      new, stable or insufficient — nothing to surface
   * new_warning        a warning state that began recently
   * escalated          moved to a worse warning state recently
   * eased              moved to a less severe warning state recently
   * worsening_further  worsening for a while, and the latest week worsened again
   * unchanged          the same warning state for `quietAfterDays` or more — true, not news
   * recovering / resolved
   */
  readonly status:
    | "not_a_warning"
    | "new_warning"
    | "escalated"
    | "eased"
    | "worsening_further"
    | "unchanged"
    | "recovering"
    | "resolved";
  /** The date the current state began, as far back as the lookback can see. */
  readonly since: string | null;
  /** Days the state has held unchanged; null when there is no state to hold. */
  readonly unchangedDays: number | null;
  /** The state before the current one, when the lookback saw a change. */
  readonly previousState: TrajectoryState | null;
}

export interface MetricTrajectory {
  /** `trajectory.<metricKey>:<clinicId>:<date>` */
  readonly id: string;
  readonly clinicId: string;
  readonly date: string;
  readonly metricKey: string;
  /** Plain name: "The 30-day cancellation rate". */
  readonly label: string;
  readonly unit: MetricUnit;
  /** Which direction is bad for this metric. */
  readonly worseWhen: "higher" | "lower";
  /** The constraint category that describes the same underlying issue, if any. */
  readonly category: ConstraintCategory | null;

  readonly state: TrajectoryState;
  readonly lifecycle: TrajectoryLifecycle;
  /** One factual sentence. Never a cause, never a forecast. */
  readonly statement: string;
  /** Why the state is insufficient_data, when it is. */
  readonly insufficientReason: string | null;

  readonly current: number | null;
  readonly reference: TrajectoryReference | null;
  /** `current − reference.median`. */
  readonly deviation: number | null;
  readonly position: "worse_than_normal" | "within_normal" | "better_than_normal" | null;

  /** Oldest first. */
  readonly weeks: readonly TrajectoryWeek[];
  readonly consecutiveWorseningWeeks: number;
  readonly consecutiveImprovingWeeks: number;
  /**
   * Robust (Theil–Sen) change per week across measured weekly medians, in the
   * metric's unit. Null unless enough weeks were measured for a slope to mean
   * anything. Evidence only — never extrapolated.
   */
  readonly slopePerWeek: number | null;

  /** Consecutive most-recent measured days worse than normal. */
  readonly daysWorseThanNormal: number;
  /** Consecutive most-recent measured days not worse than normal. */
  readonly daysBackToNormal: number;
  /** Worse-than-normal days in the window before the current return to normal. */
  readonly priorDaysWorseThanNormal: number;

  /** Measured daily values in the window, today included. */
  readonly observations: number;
  readonly windowDays: number;
  /** observations / windowDays. Missing days are missing — never zero. */
  readonly coverage: number;
  /** First day of the most recent worse-than-normal episode, if there has been one. */
  readonly firstDetectedDate: string | null;
  /** The day the current state began. */
  readonly lastChangedDate: string | null;

  /** A disagreement between the readings, stated rather than resolved silently. */
  readonly conflict: "worsening_within_normal_range" | "slope_disagrees_with_weekly_direction" | null;
  readonly confidence: Confidence;
  readonly confidenceBasis: readonly string[];
}
