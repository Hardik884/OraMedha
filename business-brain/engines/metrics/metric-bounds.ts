/**
 * Business Brain — Metrics Engine: what a metric's values can be, and what it
 * was divided by
 *
 * Two facts that belong to the METRIC rather than to any one consumer, kept here
 * so a rate and the judgement made about it cannot disagree:
 *
 *   bounds   the values the metric can take at all. A no-show rate below 0% or
 *            above 100% is not a low reading, it is an impossible one.
 *   basis    which metric holds the rate's DENOMINATOR, and how many events must
 *            be behind it before the rate may be judged against a range.
 *
 * ## Why the basis exists
 *
 * A rate arrives as a single number with its denominator already divided away.
 * Nothing downstream can tell 1-of-3 from 30-of-90; both are 33%. The Baseline
 * Engine measured the test clinic's "normal" no-show range as -0.1% to 66.7%
 * for exactly that reason: about five appointments a week, so one missed
 * appointment moved the rate twenty points, the spread of those swings became
 * the band, and the band grew until it excluded nothing and meant nothing.
 *
 * Two separate defects, and this file addresses both:
 *
 *   1. the band was built from days whose denominators were too small to carry
 *      a rate at all, and
 *   2. it ran past the ends of the scale, which told the reader the clinic's
 *      normal includes a negative share of its appointments.
 *
 * ## Why the minimum is expressed against the smallest change worth reporting
 *
 * A rate over `n` appointments moves in steps of `100/n` points — one
 * appointment is the finest movement it can express. If that step is larger than
 * the smallest change the clinic would be told about, then every reportable
 * movement can be produced by a single appointment, and the metric cannot
 * distinguish a changed practice from one person's flat tyre.
 *
 * The attendance rates are reported down to 2 points (see the Achievement
 * Catalogue's `minimumDelta`), so they need 50 appointments behind them. At 40 a
 * single missed appointment is 2.5 points and clears that floor on its own.
 *
 * ## This does not make a small clinic invisible
 *
 * Below the minimum the rate is still MEASURED and still shown; what is withheld
 * is the judgement that it is unusual. "Too few appointments to judge" is the
 * honest reading, and it is a different statement from "normal".
 *
 * Pure data. No clock, no I/O.
 */

import { MetricUnit } from "../../domain";
import { METRIC_DESCRIPTORS, MetricKey } from "./metric-ids";

/** The values a metric can take. `null` on a side means genuinely unbounded. */
export interface MetricBounds {
  readonly min: number | null;
  readonly max: number | null;
}

/**
 * Metrics whose bounds are not implied by their unit.
 *
 * A percentage is NOT automatically 0..100 here, and the distinction is load
 * bearing:
 *
 *   - a share of a whole (what portion of appointments were missed) is bounded
 *     by that whole;
 *   - a comparison of two quantities expressed as a percentage — chair
 *     utilization, collection rate, overrun — is not. Appointments genuinely
 *     overrun by more than 100%, a month's collections genuinely exceed that
 *     month's production when old balances are paid off, and a double-booked
 *     chair genuinely runs past the time it was open for.
 *
 * So each one is declared, with the reason, rather than inferred.
 */
const DECLARED_BOUNDS: Readonly<Partial<Record<MetricKey, MetricBounds>>> = {
  // Shares of one whole: every appointment in the window carries exactly one
  // status, so neither rate can exceed the book it is measured against.
  [MetricKey.SCHEDULING_CANCELLATION_RATE_30D]: { min: 0, max: 100 },
  [MetricKey.SCHEDULING_NO_SHOW_RATE_30D]: { min: 0, max: 100 },

  // Ratios of two quantities. Bounded below — a clinic cannot use negative chair
  // time, collect a negative share, or book a negative week — and unbounded
  // above, because each legitimately passes 100%.
  [MetricKey.CAPACITY_CHAIR_UTILIZATION]: { min: 0, max: null },
  [MetricKey.CAPACITY_CHAIR_UTILIZATION_30D]: { min: 0, max: null },
  [MetricKey.CAPACITY_BOOKED_NEXT_7D]: { min: 0, max: null },
  [MetricKey.REVENUE_COLLECTION_RATE_30D]: { min: 0, max: null },

  // A share of one whole after all: the unpaid part is capped at what was
  // charged, so this cannot pass 100 however much old debt is cleared. That is
  // the property the cash-flow ratio above does not have.
  [MetricKey.REVENUE_PRODUCTION_PAID_RATE_30D]: { min: 0, max: 100 },

  // Signed on purpose: a negative overrun is an appointment that finished early.
  // Clamping it at zero would erase half of what the metric measures.
  [MetricKey.SCHEDULING_APPOINTMENT_OVERRUN_30D]: { min: null, max: null },
};

/**
 * Bounds by unit, for everything not declared above.
 *
 * Counts, durations and day-spans cannot be negative: they count rows or measure
 * elapsed time. Currency and bare percentages are left unbounded, because a
 * balance can be overpaid and a percentage may be a signed divergence — a
 * default that guesses wrong there would clamp a real reading.
 */
const BOUNDS_BY_UNIT: Readonly<Record<MetricUnit, MetricBounds>> = {
  [MetricUnit.COUNT]: { min: 0, max: null },
  [MetricUnit.MINUTES]: { min: 0, max: null },
  [MetricUnit.HOURS]: { min: 0, max: null },
  [MetricUnit.DAYS]: { min: 0, max: null },
  [MetricUnit.CURRENCY]: { min: null, max: null },
  [MetricUnit.PERCENTAGE]: { min: null, max: null },
  [MetricUnit.RATIO]: { min: null, max: null },
};

const UNBOUNDED: MetricBounds = { min: null, max: null };

/**
 * What values this metric can take.
 *
 * Unknown keys are unbounded rather than assumed: a metric this file has never
 * heard of must not have a range invented for it.
 */
export function boundsFor(key: string): MetricBounds {
  const declared = DECLARED_BOUNDS[key as MetricKey];
  if (declared !== undefined) return declared;
  const descriptor = METRIC_DESCRIPTORS[key as MetricKey];
  if (descriptor === undefined) return UNBOUNDED;
  return BOUNDS_BY_UNIT[descriptor.unit] ?? UNBOUNDED;
}

/** Clamp a band edge into the metric's own domain. */
export function clampToBounds(key: string, value: number): number {
  const { min, max } = boundsFor(key);
  if (min !== null && value < min) return min;
  if (max !== null && value > max) return max;
  return value;
}

/** A rate's denominator, and how much of it is needed before judging the rate. */
export interface RateBasis {
  /** The metric holding the count the rate was computed over. */
  readonly denominatorKey: MetricKey;
  /**
   * Events needed behind the rate before a range may be judged against it.
   *
   * Set so that one event moves the rate by LESS than the smallest change this
   * metric is reported for — see the header.
   */
  readonly minimumToJudge: number;
  /** What the denominator counts, for the sentence a clinic reads. */
  readonly noun: string;
}

const RATE_BASIS: Readonly<Partial<Record<MetricKey, RateBasis>>> = {
  [MetricKey.SCHEDULING_NO_SHOW_RATE_30D]: {
    denominatorKey: MetricKey.SCHEDULING_APPOINTMENTS_30D,
    // 50: reported down to 2 points, and 100/50 = 2, so one missed appointment
    // can no longer produce a reportable movement by itself.
    minimumToJudge: 50,
    noun: "appointments",
  },
  [MetricKey.SCHEDULING_CANCELLATION_RATE_30D]: {
    denominatorKey: MetricKey.SCHEDULING_APPOINTMENTS_30D,
    minimumToJudge: 50,
    noun: "appointments",
  },
  [MetricKey.REVENUE_PRODUCTION_PAID_RATE_30D]: {
    denominatorKey: MetricKey.REVENUE_PRODUCTION_30D,
    // A month that produced almost nothing gives a rate that is arithmetic
    // rather than a finding: one unpaid consultation reads as a collapse. The
    // same floor the collection-rate signal has always used — roughly a month of
    // minimum daily revenue — because what makes this rate meaningful is the size
    // of the denominator in money, which is the unit the rate is in.
    minimumToJudge: 125_000,
    noun: "of work delivered",
  },
  [MetricKey.REVENUE_COLLECTION_RATE_30D]: {
    denominatorKey: MetricKey.REVENUE_PRODUCTION_30D,
    minimumToJudge: 125_000,
    noun: "of work delivered",
  },
  [MetricKey.SCHEDULING_APPOINTMENT_OVERRUN_30D]: {
    denominatorKey: MetricKey.SCHEDULING_MEASURED_VISITS_30D,
    // The overrun rate is a share of total booked MINUTES, not a count of
    // visits, so one visit does not move it by a fixed step. 20 is the point at
    // which a single long case stops dominating the aggregate — twice the
    // signal evaluator's guard, because that rule compares against a fixed 20%
    // limit while a baseline has to resolve this clinic's own day-to-day spread.
    minimumToJudge: 20,
    noun: "measured visits",
  },
};

/** The denominator rule for a rate, or undefined when the metric is not a rate. */
export function rateBasisFor(key: string): RateBasis | undefined {
  return RATE_BASIS[key as MetricKey];
}
