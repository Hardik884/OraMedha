/**
 * Business Brain — Signal Engine: thresholds
 *
 * Every number the Signal Engine compares against lives here. Evaluators are
 * forbidden from containing literals: they receive the resolved config through
 * their `EvaluatorContext` so tests can override any value.
 *
 * Currency values are INR and sized for a single-chair to small (2-3 chair)
 * Indian dental practice.
 */

import type { SignalType } from "../../../domain";
import type { Severity } from "../../../types";

/** Recursive partial, used for threshold overrides. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

/** Per-signal severity clamping. */
export interface SeverityOverride {
  /** Severity is never reported below this level. */
  readonly floor?: Severity;
  /** Severity is never reported above this level. */
  readonly ceiling?: Severity;
}

/** Breach magnitude -> severity band boundaries (inclusive lower bounds). */
export interface SeverityBands {
  readonly low: number;
  readonly medium: number;
  readonly high: number;
  readonly critical: number;
}

/** The complete, typed threshold surface of the Signal Engine. */
export interface SignalThresholdConfig {
  readonly revenue: {
    /** Minimum expected collection for a working day (INR). */
    readonly minimumDailyRevenue: number;
    /** Acceptable ceiling for total unpaid patient balances (INR). */
    readonly outstandingBalanceLimit: number;
    /** Growth in outstanding vs previous period that counts as a trend (%). */
    readonly outstandingGrowthRate: number;
    /**
     * Absolute floor for the outstanding trend (INR), anchored to one working
     * day's expected collection. A receivable book smaller than a single normal
     * day's takings is not material however fast it grew; at or above the floor,
     * a zero prior baseline is graded against the floor instead of returning
     * no_signal.
     */
    readonly outstandingGrowthFloor: number;
    /** Appointments required before a low-revenue day is meaningful. */
    readonly minimumActivityForRevenueSignal: number;
    /** Completed treatments required before a collection gap is meaningful. */
    readonly minimumCompletionsForCollectionCheck: number;
    /**
     * Share of the window's production that should have been collected by now (%).
     *
     * A RATE, so global: a clinic collecting 60% of what it delivers has the same
     * problem at any size, and holding it fixed is what keeps clinics comparable.
     */
    readonly minimumCollectionRate: number;
    /**
     * Production in the window required before a collection rate means anything
     * (INR). A rate computed against a nearly-idle month is arithmetic, not a
     * finding.
     */
    readonly minimumProductionForRateCheck: number;
  };
  readonly appointments: {
    /** Cancellation share of the day's appointments that is too high (%). */
    readonly highCancellationRate: number;
    /** No-show share of the day's appointments that is too high (%). */
    readonly highNoShowRate: number;
    /** Minimum healthy booked volume for a working day. */
    readonly minimumDailyAppointments: number;
    /** Denominator guard: below this, rates are statistical noise. */
    readonly minimumAppointmentSample: number;
    /**
     * Share of the next 7 days' offered chair time that should already be
     * booked (%). Below this, the week ahead is thin enough to act on while
     * there is still time to fill it.
     *
     * A RATE, so it stays global rather than being calibrated per clinic — the
     * same rule as cancellation and no-show rates. A percentage of a clinic's
     * own offered capacity is already relative to that clinic's size.
     */
    readonly minimumWeekAheadBooked: number;
    /**
     * Distinct patients who each missed 2+ appointments in the trailing window
     * before the concentration is worth naming.
     *
     * A COUNT of people, not a rate, and deliberately not calibrated: this is
     * "is there a short list worth working", and that list is the same size
     * whether the clinic has one chair or four.
     */
    readonly repeatNonAttenderLimit: number;
    /**
     * Share by which booked appointments may overrun their booked length before
     * the clinic's booking template is understood to be wrong (%).
     *
     * A RATE, so it stays global for the same reason the cancellation and
     * no-show rates do: a clinic whose appointments run a third longer than
     * booked has the same problem at one chair or six.
     */
    readonly appointmentOverrunRate: number;
    /**
     * Visits with BOTH a called and a completed timestamp required before the
     * overrun reading means anything.
     *
     * A statistical guard rather than a size threshold — it is about whether the
     * measurement is valid, not about how big the clinic is — so it stays global
     * alongside `minimumAppointmentSample`.
     */
    readonly minimumMeasuredVisits: number;
    /**
     * Combined cancellation + no-show share of the trailing window that is too
     * high (%). A rate, therefore global — see `appointmentOverrunRate`.
     */
    readonly sustainedAttritionRate: number;
    /**
     * Appointments in the trailing window before its rates carry a finding.
     *
     * The daily rules have `minimumAppointmentSample` for exactly this reason,
     * and the window rules were written believing a 30-day denominator was
     * always large enough. At a clinic booking five a week it is thirty
     * appointments over the whole window, where one cancellation is 3 points
     * and two of them clear a 15% limit between them.
     *
     * A statistical guard, not a size threshold, so it stays global and
     * uncalibrated — the same reasoning as `minimumMeasuredVisits`.
     */
    readonly minimumWindowAppointments: number;
    /**
     * Median booking lead time above which demand is read as pressing against
     * capacity (days).
     *
     * Not calibrated: lead time is already expressed in the patient's units
     * ("how long until I can be seen"), and a three-week wait is a three-week
     * wait at one chair or six.
     */
    readonly longBookingLeadTimeDays: number;
  };
  readonly patients: {
    /** Minimum new patients expected on a working day. */
    readonly minimumNewPatientsPerDay: number;
    /** Fall in returning patients vs previous period that counts (%). */
    readonly returningVolumeDropRate: number;
    /**
     * Absolute floor for the returning-volume trend (patients). A fall smaller
     * than this is not material however large the percentage; when the drop
     * clears the floor but the percentage is undefined, the floor grades it.
     */
    readonly returningVolumeFloor: number;
    /**
     * Patients gone quiet — seen at least once, not seen for the clinic's recall
     * interval, nothing booked — before the dormant base is worth naming.
     *
     * NOT calibrated, and for the same dull reason `overdueFollowupLimit` is
     * not: the honest denominator is active roster size and no metric measures
     * it. Deriving this from production or capacity instead would invent a
     * relationship rather than measure one. It is a call list, and a list of
     * twenty-five people is a morning's work at any clinic size.
     */
    readonly lapsedPatientLimit: number;
  };
  readonly queue: {
    /** Waiting-room time that becomes an experience problem (minutes). */
    readonly maximumWaitingTimeMinutes: number;
    /** Simultaneous waiting patients that becomes a backlog. */
    readonly maximumQueueLength: number;
    /** Queue growth vs previous period that counts as a trend (%). */
    readonly queueGrowthRate: number;
    /** Absolute floor: growth below this many patients is not material. */
    readonly queueGrowthFloor: number;
  };
  readonly followups: {
    /** Overdue follow-ups that constitute a backlog. */
    readonly overdueFollowupLimit: number;
  };
  readonly capacity: {
    /** Chair utilization below this is idle capacity (%). */
    readonly minimumChairUtilization: number;
    /** Chair utilization at or above this is effectively full (%). */
    readonly nearCapacityUtilization: number;
    /** Remaining slots at or below this is effectively full. */
    readonly minimumAvailableSlots: number;
    /**
     * Chair utilization over the trailing window below which the clinic is
     * structurally under-used (%).
     *
     * Set BELOW the daily `minimumChairUtilization`, deliberately. A month that
     * averages under this is a materially worse statement than one quiet day, and
     * a threshold set at the same level would fire on any clinic whose daily rule
     * fires regularly — which is every clinic the daily rule is wrong for.
     */
    readonly minimumSustainedChairUtilization: number;
  };
  readonly treatment: {
    /** Planned-but-undelivered treatment value that is too large to ignore (INR). */
    readonly pendingTreatmentValueLimit: number;
    /**
     * Planned treatments whose patient has no next visit booked that constitute
     * a backlog. Named `accepted` for continuity with the metric key; neither
     * measures patient consent.
     */
    readonly acceptedUnscheduledLimit: number;
  };
  readonly severity: {
    readonly bands: SeverityBands;
    readonly overrides?: Partial<Record<SignalType, SeverityOverride>>;
  };
  readonly confidence: {
    /** Deducted per declared optional metric that was absent. */
    readonly missingOptionalMetricPenalty: number;
    /** Deducted when the governing denominator is a small sample. */
    readonly smallSamplePenalty: number;
    /** Deducted when a metric's period does not match the requested date. */
    readonly stalePeriodPenalty: number;
    /** Confidence never falls below this. */
    readonly floor: number;
    /** Signals below this confidence are suppressed. */
    readonly minimumToEmit: number;
  };
}

/**
 * Defaults for a single-chair to small Indian dental practice.
 *
 * Reasoning is recorded in the phase notes; in short: ~8-12 patients/day at
 * consult/filling/RCT price points of roughly INR 300-8,000 puts a normal
 * working day above INR 5,000 collected, so that is the floor rather than an
 * average.
 */
export const DEFAULT_SIGNAL_THRESHOLDS: SignalThresholdConfig = {
  revenue: {
    minimumDailyRevenue: 5_000,
    outstandingBalanceLimit: 25_000,
    outstandingGrowthRate: 20,
    outstandingGrowthFloor: 5_000,
    minimumActivityForRevenueSignal: 3,
    minimumCompletionsForCollectionCheck: 2,
    // 85%. Dental collection in a cash/UPI practice should run high; the gap
    // between delivery and payment is days, not months. Below 85% over a month,
    // money is being left on the table rather than merely arriving late.
    minimumCollectionRate: 85,
    // One month of the minimum daily revenue over ~25 working days. Below this
    // the clinic barely produced, and a collection RATE over it is noise.
    minimumProductionForRateCheck: 125_000,
  },
  appointments: {
    highCancellationRate: 10,
    highNoShowRate: 8,
    minimumDailyAppointments: 5,
    minimumAppointmentSample: 5,
    // A week that is under 40% booked with seven days to go has room that can
    // still be sold; above it, the normal flow of walk-ins and short-notice
    // bookings usually closes the gap. Like every other default here this is a
    // reasoned starting point, not a validated figure.
    minimumWeekAheadBooked: 40,
    // Two. One patient who missed twice is a conversation the dentist is
    // probably already having; two or more is a pattern, and the point at which
    // "handle these people differently" becomes a policy rather than a favour.
    repeatNonAttenderLimit: 2,
    // A fifth longer than booked. Below that, ordinary variation between a quick
    // check and a difficult filling explains it; at or above it, the booking
    // template is systematically short and every day inherits the error.
    appointmentOverrunRate: 20,
    // Ten visits. Chosen as the point where one long appointment stops moving
    // the aggregate — at n=3 a single difficult extraction reads as a broken
    // booking policy.
    minimumMeasuredVisits: 10,
    // 15% of everything booked lost, cancellations and no-shows together. The
    // separate daily thresholds are 10% and 8%; a month sustaining their rough
    // sum is a policy problem rather than a run of bad luck.
    sustainedAttritionRate: 15,
    // Twenty. One appointment then moves the combined rate by 5 points, a third
    // of the 15% limit, so no single cancellation can carry a finding on its
    // own. Deliberately lower than the 50 a BASELINE asks of the same
    // denominator: this rule compares against a fixed limit, where the band has
    // to resolve this clinic's own day-to-day spread.
    minimumWindowAppointments: 20,
    // Two weeks. Long enough that an urgent patient goes elsewhere, short enough
    // that a genuinely booked-out practice clears it.
    longBookingLeadTimeDays: 14,
  },
  patients: {
    minimumNewPatientsPerDay: 1,
    returningVolumeDropRate: 30,
    returningVolumeFloor: 2,
    lapsedPatientLimit: 25,
  },
  queue: {
    maximumWaitingTimeMinutes: 30,
    maximumQueueLength: 5,
    queueGrowthRate: 50,
    queueGrowthFloor: 3,
  },
  followups: {
    overdueFollowupLimit: 10,
  },
  capacity: {
    minimumChairUtilization: 50,
    nearCapacityUtilization: 90,
    minimumAvailableSlots: 1,
    minimumSustainedChairUtilization: 40,
  },
  treatment: {
    pendingTreatmentValueLimit: 50_000,
    acceptedUnscheduledLimit: 5,
  },
  severity: {
    bands: { low: 0.1, medium: 0.25, high: 0.5, critical: 1.0 },
    overrides: {
      // Being busy is not an emergency.
      "operational.near_full_capacity": { ceiling: "medium" },
      // A backlog is always worth surfacing, even when barely over the limit.
      "retention.followup_backlog": { floor: "low" },
      // Same reasoning, and the same one-way growth: a dormant base only gets
      // larger until somebody works it, so it stays visible while barely over —
      // and it is never an emergency, because it took months to build and will
      // not be cleared this morning.
      "retention.lapsed_patient_base": { floor: "low", ceiling: "high" },
      // A booking template that runs long is a standing condition, not today's
      // crisis. Capped so it can never outrank something actually going wrong
      // on the day the dentist is reading the card.
      "scheduling.appointments_overrunning": { ceiling: "high" },
      // A month-long condition, not today's emergency — and the clinic has had
      // thirty days to notice it, so arriving as a crisis would be theatre.
      "operational.sustained_low_utilization": { ceiling: "high" },
      "scheduling.sustained_attrition": { ceiling: "high" },
      // Never a finding on its own — it exists to strengthen the capacity-ceiling
      // reading — so it must not compete for attention as though it were.
      "scheduling.long_booking_lead_time": { ceiling: "medium" },
      // A quiet day is a business problem, not a crisis.
      "scheduling.low_appointment_volume": { ceiling: "high" },
      // A thin week ahead is a warning with days left to act on it. It should
      // never outrank something already going wrong today.
      "scheduling.thin_week_ahead": { ceiling: "high" },
      // The threshold is 1 patient, so relative breach maths is jumpy here.
      "acquisition.low_new_patients": { ceiling: "medium" },
    },
  },
  confidence: {
    missingOptionalMetricPenalty: 0.1,
    smallSamplePenalty: 0.15,
    stalePeriodPenalty: 0.2,
    floor: 0.3,
    minimumToEmit: 0.4,
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const next = override[key];
    if (next === undefined) continue;
    const current = result[key];
    result[key] =
      isPlainObject(current) && isPlainObject(next)
        ? deepMerge(current, next)
        : next;
  }
  return result;
}

/**
 * Deep-merge caller overrides onto a defaults object, without mutating either.
 * Shared by every engine that resolves a typed config from partial overrides.
 */
export function mergeOverrides<T>(base: T, overrides?: DeepPartial<T>): T {
  if (!overrides) return base;
  return deepMerge(
    base as unknown as Record<string, unknown>,
    overrides as Record<string, unknown>,
  ) as unknown as T;
}

/**
 * Deep-merge caller overrides onto {@link DEFAULT_SIGNAL_THRESHOLDS}.
 * Pure: the defaults object is never mutated.
 */
export function resolveConfig(
  overrides?: DeepPartial<SignalThresholdConfig>,
): SignalThresholdConfig {
  return mergeOverrides(DEFAULT_SIGNAL_THRESHOLDS, overrides);
}
