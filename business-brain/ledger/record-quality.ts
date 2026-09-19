/**
 * Business Brain — how completely the clinic records its day
 *
 * `record-evidence.ts` says what a row may be read AS. This says how often the
 * row is there at all.
 *
 * ## Why this is a measurement and not a nag
 *
 * Every "unknown" in this module traces back to something nobody pressed. A
 * visit completed without a call-in has no measurable wait; a treatment with no
 * `performed_at` is dated by when its completion was typed; a no-show the
 * nightly job inferred is not an observation that anyone made. The analysis
 * handles each honestly — it withholds, it labels, it says unknown — and the
 * result is a clinic quietly told less and less, with no way to see why.
 *
 * So the gaps are counted and named, each one beside the measurement it costs
 * and the screen where it is closed. A dentist can then decide whether to care:
 * a clinic that never uses the queue board is making a legitimate choice, and
 * this says what that choice costs rather than calling it a mistake.
 *
 * ## What it must never become
 *
 * A compliance score. There is no target, no grade, no red, and no comparison
 * against other clinics — nothing here is a judgement about the practice. It
 * measures the RECORDS, and it exists so that "we could not tell" has a visible
 * cause.
 *
 * ## Pure
 *
 * Counts in, a reading out. No database client, no clock, no I/O.
 */

/** One thing a clinic either records or does not. */
export const RecordCheck = {
  /** Patients checked in when they arrived, for visits that happened. */
  ARRIVALS: "arrivals",
  /** Patients called in from the queue, so the wait has two ends. */
  CALL_INS: "call_ins",
  /** Visits given an outcome once their day ended. */
  VISIT_OUTCOMES: "visit_outcomes",
  /** Completed treatments carrying the date they were performed. */
  TREATMENT_DATES: "treatment_dates",
  /** No-shows marked by a person rather than inferred by the nightly job. */
  NO_SHOW_MARKS: "no_show_marks",
} as const;

export type RecordCheck = (typeof RecordCheck)[keyof typeof RecordCheck];

/** What one check found. */
export interface RecordCheckCount {
  readonly check: RecordCheck;
  /**
   * How many carried the record, or null when the question could not be asked
   * at all — a read that failed, or a source this deployment does not have.
   *
   * Null is never 0. "Nobody recorded an arrival" and "we could not look" lead
   * to opposite conclusions, and only one of them is about the clinic.
   */
  readonly recorded: number | null;
  /** How many could have. */
  readonly total: number;
}

export type RecordCheckStatus =
  /** Everything that could be recorded was. */
  | "complete"
  /** Some were not. */
  | "gaps"
  /** There was nothing to record — no visits, no no-shows, no treatments. */
  | "nothing_to_record"
  /** The question could not be asked. */
  | "unknown";

export interface RecordCheckResult extends RecordCheckCount {
  /** Share recorded (%), or null when there is nothing to divide by. */
  readonly sharePercent: number | null;
  readonly status: RecordCheckStatus;
  /** How many were missing, or null when unknown. */
  readonly missing: number | null;
}

export interface RecordQuality {
  readonly checks: readonly RecordCheckResult[];
  /**
   * The mean share across the checks that could be measured, or null when none
   * could.
   *
   * UNWEIGHTED, deliberately. Weighting would encode a claim about which gap
   * matters most, and that depends on what the clinic is trying to find out —
   * a practice that never runs a queue board loses waiting times and nothing
   * else. Each check is stated beside the score for exactly that reason.
   *
   * Checks with nothing to record are excluded rather than counted as perfect: a
   * day with no no-shows says nothing about how a clinic records them.
   */
  readonly score: number | null;
  /** How many checks contributed to the score. */
  readonly measuredChecks: number;
  /** How many checks there are in total. */
  readonly totalChecks: number;
}

function resultFor(count: RecordCheckCount): RecordCheckResult {
  if (count.recorded === null) {
    return { ...count, sharePercent: null, missing: null, status: "unknown" };
  }
  if (count.total <= 0) {
    return { ...count, sharePercent: null, missing: 0, status: "nothing_to_record" };
  }
  const recorded = Math.min(count.recorded, count.total);
  const sharePercent = Math.round((recorded / count.total) * 1000) / 10;
  return {
    ...count,
    recorded,
    sharePercent,
    missing: count.total - recorded,
    status: recorded === count.total ? "complete" : "gaps",
  };
}

/**
 * Turn the counts into a reading.
 *
 * Every declared check appears in the output whatever its counts, in the order
 * given: a check that found nothing to look at is a different answer from a
 * check that was not run, and both have to be visible.
 */
export function assessRecordQuality(
  counts: readonly RecordCheckCount[],
): RecordQuality {
  const checks = counts.map(resultFor);
  const measured = checks.filter((c) => c.sharePercent !== null);
  const score =
    measured.length === 0
      ? null
      : Math.round(
          (measured.reduce((sum, c) => sum + (c.sharePercent as number), 0) / measured.length) *
            10,
        ) / 10;

  return {
    checks,
    score,
    measuredChecks: measured.length,
    totalChecks: checks.length,
  };
}

/**
 * How a window's no-shows were established.
 *
 * Its own type because the split is worth stating on its own, not only as a
 * record-quality line: an inferred no-show is the nightly job's reading of an
 * appointment nobody closed, and a recorded one is a person saying the patient
 * did not come. A rate that mixes them without saying so implies an observation
 * that was never made — and on a clinic that clicks through its day, most of the
 * "no-shows" are the job's.
 */
export interface NoShowBasisSplit {
  readonly total: number;
  /** Marked by a person. */
  readonly recorded: number;
  /** Marked by the nightly job, with no actor. */
  readonly inferred: number;
  /** Marked before the basis could be established, or with no mark at all. */
  readonly unknown: number;
  /**
   * Share of the total that a person recorded (%), or null when there were no
   * no-shows at all — which is not 0%, and not 100%.
   */
  readonly recordedSharePercent: number | null;
}

/** Split a window's no-show bases into the three answers. */
export function splitNoShowBasis(
  bases: readonly ("recorded" | "inferred" | "unknown")[],
): NoShowBasisSplit {
  const recorded = bases.filter((b) => b === "recorded").length;
  const inferred = bases.filter((b) => b === "inferred").length;
  const unknown = bases.length - recorded - inferred;
  return {
    total: bases.length,
    recorded,
    inferred,
    unknown,
    recordedSharePercent:
      bases.length === 0 ? null : Math.round((recorded / bases.length) * 1000) / 10,
  };
}
