/**
 * Business Brain — Outcome Engine: what each category's action was meant to do
 *
 * One declared entry per ConstraintCategory that an action can be VERIFIED for,
 * and a stated absence for every category that cannot.
 *
 * ## Why this is a small declared list and not a rule
 *
 * Verification is only possible where the schema records the intended result.
 * Three categories qualify, and they are the three the briefing already builds a
 * patient population for:
 *
 *   retention             → the follow-up moves to completed
 *   revenue_leakage       → a payment is recorded against the patient
 *   treatment_acceptance  → the patient gets an appointment
 *
 * Everything else is honestly unverifiable. An idle chair targets nobody, so
 * there is no population whose subsequent behaviour could confirm anything; a
 * thin week ahead is answered by bookings that are indistinguishable from any
 * other bookings. Inventing a proxy for those would produce a number that looks
 * like verification and is not, which is worse than reporting that it cannot be
 * done.
 *
 * ## The metric half is separate on purpose
 *
 * A category can have a headline metric without having verifiable targets, and
 * the reverse. `reactivation` is the first case: the lapsed-patient count
 * responds immediately and is worth reporting, while the population is a roster
 * query the briefing does not build a contactable list from.
 *
 * Only LEVEL metrics appear here — counts and amounts that move the moment the
 * work lands. A 30-day rate cannot be used: it would barely shift on the day the
 * work was done, and reporting "your no-show rate went from 11% to 10.9%" as
 * what happened after would dress statistical inertia up as a result.
 */

import { ClinicDimension } from "../../domain";
import { BaselineDirection } from "../baseline";
import { MetricKey } from "../metrics/metric-ids";

/** What confirms the intended result for a category, in the clinic's data. */
export const VerificationTarget = {
  /** The patient's overdue follow-up is now completed. */
  FOLLOW_UP_COMPLETED: "follow_up_completed",
  /** A payment is now recorded against the patient. */
  PAYMENT_RECORDED: "payment_recorded",
  /** The patient now has an appointment. */
  APPOINTMENT_BOOKED: "appointment_booked",
} as const;

export type VerificationTarget =
  (typeof VerificationTarget)[keyof typeof VerificationTarget];

export interface OutcomeSpec {
  readonly category: string;
  readonly dimension: ClinicDimension;
  /**
   * What the adapter should look for to confirm each target, or null when the
   * schema cannot confirm this category's intended result at all.
   */
  readonly verifies: VerificationTarget | null;
  /**
   * The headline LEVEL metric, or null when the category has none that responds
   * on the timescale an action does.
   */
  readonly metricKey: string | null;
  /** Which direction of movement helps, for the metric above. */
  readonly direction: BaselineDirection | null;
}

/**
 * Every category an action card can carry, with its verification and metric.
 *
 * Complete by construction: a category missing from here produces an outcome at
 * `insufficient_evidence` rather than no outcome at all, so a completion is never
 * silently dropped. The list is stated in full anyway, because "we cannot verify
 * this" is a finding worth writing down rather than inferring from an absence.
 */
export const OUTCOME_SPECS: readonly OutcomeSpec[] = [
  {
    category: "retention",
    dimension: ClinicDimension.RETENTION_RECALL,
    verifies: VerificationTarget.FOLLOW_UP_COMPLETED,
    metricKey: MetricKey.FOLLOWUPS_OVERDUE,
    direction: BaselineDirection.LOWER_IS_BETTER,
  },
  {
    category: "revenue_leakage",
    dimension: ClinicDimension.FINANCIAL_HEALTH,
    verifies: VerificationTarget.PAYMENT_RECORDED,
    metricKey: MetricKey.REVENUE_OUTSTANDING,
    direction: BaselineDirection.LOWER_IS_BETTER,
  },
  {
    category: "treatment_acceptance",
    dimension: ClinicDimension.TREATMENT_PIPELINE,
    verifies: VerificationTarget.APPOINTMENT_BOOKED,
    metricKey: MetricKey.TREATMENT_ACCEPTED_PENDING_SCHEDULING,
    direction: BaselineDirection.LOWER_IS_BETTER,
  },
  {
    // A metric but no verifiable population: the lapsed count responds at once,
    // while the briefing sends staff to a filtered patient list rather than
    // building a contactable set this could be matched against.
    category: "reactivation",
    dimension: ClinicDimension.RETENTION_RECALL,
    verifies: null,
    metricKey: MetricKey.PATIENTS_REACTIVATION_CANDIDATES,
    direction: BaselineDirection.LOWER_IS_BETTER,
  },
  // ── Neither verifiable nor metric-trackable, and stated so ────────────────
  //
  // Each of these is an honest absence rather than a gap. The intended result is
  // either not something the schema records, or not something that moves on the
  // timescale of the action.
  {
    // An idle chair targets nobody, and today's utilization cannot be improved
    // retroactively once the day has passed.
    category: "capacity",
    dimension: ClinicDimension.SCHEDULE_HEALTH,
    verifies: null,
    metricKey: null,
    direction: null,
  },
  {
    // Bookings that fill next week are indistinguishable from any other
    // bookings, so nothing confirms that these ones came from the action.
    category: "forward_schedule",
    dimension: ClinicDimension.SCHEDULE_HEALTH,
    verifies: null,
    metricKey: null,
    direction: null,
  },
  {
    // Appointments already lost cannot be recovered, and the rates that measure
    // the loss are 30-day windows.
    category: "scheduling",
    dimension: ClinicDimension.ATTENDANCE,
    verifies: null,
    metricKey: null,
    direction: null,
  },
  {
    // A wait that already happened has no subsequent result to confirm.
    category: "patient_flow",
    dimension: ClinicDimension.PATIENT_FLOW,
    verifies: null,
    metricKey: null,
    direction: null,
  },
  {
    // The fix is a booking default in settings; its effect appears over a month
    // of subsequent appointments, not against any target list.
    category: "schedule_accuracy",
    dimension: ClinicDimension.SCHEDULE_HEALTH,
    verifies: null,
    metricKey: null,
    direction: null,
  },
  {
    // An enquiry that never became an appointment leaves no row at all, so there
    // is nothing to target and nothing to confirm.
    category: "acquisition",
    dimension: ClinicDimension.RETENTION_RECALL,
    verifies: null,
    metricKey: null,
    direction: null,
  },
];

export const OUTCOME_SPEC_BY_CATEGORY: ReadonlyMap<string, OutcomeSpec> = new Map(
  OUTCOME_SPECS.map((spec) => [spec.category, spec]),
);
