/**
 * Business Brain — Root-Cause Engine: every threshold it judges with.
 *
 * Three families of rule, one per kind of outcome. Each is deliberately
 * conservative: the cost of a missed concentration is a problem explained a week
 * later; the cost of a false one is a clinic reorganising its Mondays around two
 * unlucky appointments.
 */

export interface RootCauseConfig {
  /** Trailing days analysed, today included. */
  readonly windowDays: number;
  /** Lost/kept style outcomes (attrition). */
  readonly proportion: {
    /** Appointments with a recorded outcome before any dimension is looked at. */
    readonly minPopulation: number;
    /** Events in the whole population — below this there is nothing to locate. */
    readonly minTotalEvents: number;
    /** Units in a group before a rate is even computed for it. */
    readonly minGroupSize: number;
    readonly minComparisonSize: number;
    /** Events inside the group: four, so one bad afternoon cannot make a pattern. */
    readonly minGroupEvents: number;
    /** Group rate minus comparison rate, in percentage points. */
    readonly minGapPoints: number;
    /** Group rate ÷ comparison rate, when the comparison rate is above zero. */
    readonly minRatio: number;
  };
  /** Minute measurements (overrun, waiting). */
  readonly measurement: {
    readonly minPopulation: number;
    readonly minGroupSize: number;
    readonly minComparisonSize: number;
    /** Group median minus comparison median, in minutes. */
    readonly minGapMinutes: number;
  };
  /** Chair-time utilization by day or session. */
  readonly capacity: {
    /** Occurrences (dates, or date-sessions) in a group. */
    readonly minOccurrences: number;
    readonly minComparisonOccurrences: number;
    /** Comparison median utilization minus group median, in percentage points. */
    readonly minGapPoints: number;
    /** Share of the group's occurrences that must sit below the comparison median. */
    readonly consistency: number;
  };
  /**
   * The chance, shared across every group an analysis compares, of reporting a
   * concentration that is only noise. Each comparison is judged against this
   * divided by the number of comparisons (Bonferroni).
   */
  readonly familyAlpha: number;
  /** A dimension recorded for less than this share of the population is not analysed. */
  readonly minCoverage: number;
  /** Two associations sharing at least this share of units are flagged as overlapping. */
  readonly overlapShare: number;
  readonly confidenceFloor: number;
  readonly penalties: {
    /** A group or comparison under twice its minimum size. */
    readonly nearMinimum: number;
    /** The dimension is recorded for under 95% of the population. */
    readonly partialCoverage: number;
    /** The association overlaps another, so which description fits is uncertain. */
    readonly overlapping: number;
  };
}

export const DEFAULT_ROOT_CAUSE_CONFIG: RootCauseConfig = {
  windowDays: 30,
  proportion: {
    minPopulation: 30,
    minTotalEvents: 8,
    minGroupSize: 10,
    minComparisonSize: 10,
    minGroupEvents: 4,
    minGapPoints: 10,
    minRatio: 1.5,
  },
  measurement: {
    minPopulation: 16,
    minGroupSize: 8,
    minComparisonSize: 8,
    minGapMinutes: 10,
  },
  capacity: {
    minOccurrences: 3,
    minComparisonOccurrences: 3,
    minGapPoints: 20,
    consistency: 0.75,
  },
  familyAlpha: 0.05,
  minCoverage: 0.8,
  overlapShare: 0.5,
  confidenceFloor: 0.05,
  penalties: {
    nearMinimum: 0.15,
    partialCoverage: 0.15,
    overlapping: 0.1,
  },
};
