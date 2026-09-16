/**
 * Business Brain — Learning Engine: every threshold a learning must clear, and
 * the words it is stated in.
 *
 * Each threshold is conservative for the same reason the root-cause rules are: a
 * missed learning is noticed a month later; a false one teaches a clinic to
 * stop doing something that works, or to keep doing something that does not.
 */

export interface LearningConfig {
  /** Days of history a learning may rest on, today included. */
  readonly windowDays: number;
  readonly repeated: {
    /** Closed, assessable outcomes of one action before anything is said. */
    readonly minClosedOutcomes: number;
    /** Share of them followed by the intended result. */
    readonly minPositiveShare: number;
    /** likely_contributed outcomes (strong included) for the likely level. */
    readonly minLikely: number;
    readonly minLikelyShare: number;
  };
  readonly noChange: {
    readonly minClosedOutcomes: number;
    readonly minNoChangeShare: number;
  };
  readonly ignored: {
    readonly minRecordedDays: number;
    /** Days the action was a top recommendation. */
    readonly minExposureDays: number;
    /** A completion this many days after a recommendation still answers it. */
    readonly actedWithinDays: number;
    readonly minIgnoredShare: number;
  };
  readonly recurring: {
    readonly minRecordedDays: number;
    readonly minFlaggedDays: number;
    /** Days from the first to the last flagged day. */
    readonly minSpanDays: number;
  };
  readonly timeToOutcome: {
    readonly minOutcomes: number;
    readonly minResults: number;
  };
  readonly faster: {
    /** Closed episodes needed on each side. */
    readonly minEpisodesEach: number;
    readonly minMedianGapDays: number;
    /** The acted median must be at least this share shorter. */
    readonly minRelativeGap: number;
  };
  readonly opportunity: {
    readonly minRecordedDays: number;
    readonly minExposureDays: number;
    readonly actedWithinDays: number;
  };
}

export const DEFAULT_LEARNING_CONFIG: LearningConfig = {
  windowDays: 180,
  repeated: { minClosedOutcomes: 5, minPositiveShare: 0.6, minLikely: 3, minLikelyShare: 0.5 },
  noChange: { minClosedOutcomes: 5, minNoChangeShare: 0.6 },
  ignored: { minRecordedDays: 14, minExposureDays: 7, actedWithinDays: 2, minIgnoredShare: 0.8 },
  recurring: { minRecordedDays: 14, minFlaggedDays: 14, minSpanDays: 21 },
  timeToOutcome: { minOutcomes: 5, minResults: 8 },
  faster: { minEpisodesEach: 3, minMedianGapDays: 3, minRelativeGap: 0.25 },
  opportunity: { minRecordedDays: 14, minExposureDays: 7, actedWithinDays: 2 },
};

/** What each category's action is, as a clinic would say it. */
export const ACTION_LABEL: Readonly<Record<string, string>> = {
  retention: "Working the overdue recall list",
  revenue_leakage: "Following up outstanding payments",
  treatment_acceptance: "Chasing unbooked treatment plans",
  reactivation: "Contacting patients who had stopped coming",
  capacity: "Working on filling chair time",
  forward_schedule: "Working on next week's schedule",
  scheduling: "Working on lost appointments",
  patient_flow: "Working on waiting times",
  schedule_accuracy: "Reviewing booking lengths",
  acquisition: "Following up new-patient enquiries",
};

/** What each category's problem is. */
export const PROBLEM_LABEL: Readonly<Record<string, string>> = {
  retention: "The overdue recall list",
  revenue_leakage: "Outstanding payments",
  treatment_acceptance: "Unbooked treatment plans",
  reactivation: "Patients who have stopped coming",
  capacity: "Unused chair time",
  forward_schedule: "A thin schedule for next week",
  scheduling: "Lost appointments",
  patient_flow: "Long waiting times",
  schedule_accuracy: "Booking lengths that do not match visits",
  acquisition: "New-patient enquiries not converting",
};

/** The intended result each verifiable category is confirmed by, as a plural noun. */
export const RESULT_NOUN: Readonly<Record<string, string>> = {
  retention: "completed follow-ups",
  revenue_leakage: "patients recording a payment",
  treatment_acceptance: "booked visits",
};

/** The helpful movement of each category's headline metric. */
export const IMPROVEMENT_PHRASE: Readonly<Record<string, string>> = {
  retention: "a shorter overdue recall list",
  revenue_leakage: "a lower amount owed",
  treatment_acceptance: "fewer patients waiting for their next visit",
  reactivation: "fewer patients who had stopped coming",
};

export const OPPORTUNITY_LABEL: Readonly<Record<string, string>> = {
  forward_capacity_match: "open chair time next week with patients waiting to book",
  freed_slot_refill: "freed slot",
  unpaid_delivered_work: "unpaid delivered work",
};
