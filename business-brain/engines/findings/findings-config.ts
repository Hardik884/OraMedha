/**
 * Business Brain — Findings: every threshold the normaliser and prioritiser use.
 *
 * There are no weights here, and that is deliberate. The prioritiser compares
 * findings factor by factor in a fixed order and stops at the first factor that
 * differs, so every ranking decision can be stated as one sentence naming one
 * measured difference. A weighted sum can always produce an order; it can never
 * say why without reciting the weights.
 */

export const FINDINGS_CONFIG = {
  /** Confidence at or above which evidence is called high. */
  highConfidence: 0.7,
  /** Below this, evidence is low — and a low-confidence finding loses one stakes level. */
  moderateConfidence: 0.4,
  /**
   * The floor confidence can be reduced to. Insufficient data LOWERS confidence;
   * it never zeroes it, because a zero would read as "known to be false".
   */
  confidenceFloor: 0.05,
  /** Urgency bands, in hours to expiry. */
  urgentWithinHours: 24,
  soonWithinHours: 72,
  thisWeekWithinHours: 168,
  /** How many findings follow the top one before the rest become supporting. */
  nextCount: 3,
  penalties: {
    /** The driving diagnosis had too little history to classify persistence. */
    insufficientHistory: 0.1,
    /** Persistence was capped because days in the window could not be measured. */
    unmeasuredDays: 0.1,
    /** No contributing diagnosis could be found for a constraint. */
    noContributingDiagnosis: 0.2,
    /** An improvement seen on a single day, not yet sustained. */
    singleDay: 0.1,
  },
} as const;
