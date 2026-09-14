/**
 * Business Brain — Clinic Memory: every threshold a memory is derived and
 * revalidated with.
 *
 * No calendar expiry appears here. A memory weakens or goes stale because the
 * most recent evidence stops supporting it, measured in observations, recorded
 * days, closed outcomes, or the clinic's own recurrence interval and completion
 * cadence.
 */

import { MetricKey } from "../engines/metrics/metric-ids";

/** Bumped whenever a derivation rule changes, so builds of different rules never compare equal. */
export const MEMORY_DERIVATION_VERSION = "memory-v1";

export interface MemoryConfig {
  /** Days of evidence one build reads, the build date included. */
  readonly windowDays: number;
  readonly normalRange: {
    /** Days in the established period, and in the recent period that revalidates it. */
    readonly periodDays: number;
    readonly minObservations: number;
    /** Below this many recent readings the range cannot be revalidated at all. */
    readonly minRecentObservations: number;
    /** Share of recent readings inside the established range for it to stay active. */
    readonly holdShare: number;
    /** Below this share it no longer holds. Between the two it is weakening. */
    readonly weakShare: number;
  };
  readonly historicalChange: {
    readonly periodDays: number;
    readonly minObservations: number;
    /** Share of the readings after a change point outside the range before it. */
    readonly sustainedShare: number;
  };
  readonly weekday: {
    readonly supportingDays: number;
    readonly minOccurrences: number;
    readonly minOtherObservations: number;
    readonly consistency: number;
    readonly recentOccurrences: number;
    readonly weakShare: number;
  };
  readonly recurring: {
    readonly minRecordedDays: number;
    readonly minEpisodes: number;
    /** Share of days since an episode ended that must be recorded to judge that it has not returned. */
    readonly minRecentCoverage: number;
  };
  readonly rootCause: {
    readonly minObservedDays: number;
    readonly minWeeks: number;
    readonly minShare: number;
    readonly recentRecordedDays: number;
    readonly minRecentAnalysedDays: number;
    readonly weakShare: number;
  };
  readonly actions: {
    /** The most recent closed outcomes per action that revalidate an action memory. */
    readonly recentOutcomes: number;
    readonly recentRecordedDays: number;
    /** An action not repeated for this many of its own typical intervals cannot be revalidated. */
    readonly staleAfterIntervals: number;
  };
  readonly confidence: {
    readonly weakeningPenalty: number;
    readonly stalePenalty: number;
    readonly floor: number;
  };
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  windowDays: 365,
  normalRange: { periodDays: 28, minObservations: 14, minRecentObservations: 7, holdShare: 0.75, weakShare: 0.5 },
  historicalChange: { periodDays: 28, minObservations: 14, sustainedShare: 0.75 },
  weekday: { supportingDays: 84, minOccurrences: 6, minOtherObservations: 30, consistency: 0.75, recentOccurrences: 6, weakShare: 0.5 },
  recurring: { minRecordedDays: 28, minEpisodes: 3, minRecentCoverage: 0.3 },
  rootCause: { minObservedDays: 7, minWeeks: 3, minShare: 0.5, recentRecordedDays: 28, minRecentAnalysedDays: 7, weakShare: 0.25 },
  actions: { recentOutcomes: 5, recentRecordedDays: 28, staleAfterIntervals: 2 },
  confidence: { weakeningPenalty: 0.2, stalePenalty: 0.4, floor: 0.05 },
};

/** Metrics whose normal range and level shifts are remembered. Daily and 30-day readings the Brain already stores. */
export const RANGE_METRIC_KEYS: readonly string[] = [
  MetricKey.APPOINTMENTS_TOTAL_TODAY,
  MetricKey.CAPACITY_CHAIR_UTILIZATION,
  MetricKey.CAPACITY_CHAIR_UTILIZATION_30D,
  MetricKey.FOLLOWUPS_OVERDUE,
  MetricKey.PATIENTS_REACTIVATION_CANDIDATES,
  MetricKey.REVENUE_OUTSTANDING,
  MetricKey.SCHEDULING_CANCELLATION_RATE_30D,
  MetricKey.SCHEDULING_NO_SHOW_RATE_30D,
  MetricKey.TREATMENT_ACCEPTED_PENDING_SCHEDULING,
];

/** Daily metrics for which a weekday pattern is meaningful. A 30-day rate has no weekday. */
export const WEEKDAY_METRIC_KEYS: readonly string[] = [MetricKey.APPOINTMENTS_TOTAL_TODAY, MetricKey.CAPACITY_CHAIR_UTILIZATION];
