/**
 * Business Brain — Action Engine: workflow → action mapping
 *
 * One entry per workflow template, listing which catalog capabilities DentGrow
 * offers for it and in what order. This table is the whole of the Action
 * Engine's "thinking", and it is deliberately not thinking at all: it is a
 * lookup. Nothing here decides whether a workflow matters, how urgent it is, or
 * who should do it — all of that arrives on the workflow and is copied through.
 *
 * ## Keyed on the workflow template, not on the constraint category
 *
 * Two workflows in the same category want different help. `yield` (work
 * delivered, money not collected) wants today's completed treatments and a
 * payment form; `patient_balances` (long-outstanding amounts) wants the balance
 * list and a reminder draft. Keying on category would collapse them into the same
 * generic financial shortcut, which is exactly the vagueness the Workflow Engine
 * was built to escape.
 *
 * ## Coverage is enforced
 *
 * Every key in `WORKFLOW_TEMPLATE_KEYS` has an entry here, and every entry names
 * a real key. `action-coverage.spec.ts` reads the workflow engine's own key list
 * and fails on either kind of gap, so a new workflow template cannot ship with
 * no actions and a plan cannot outlive the workflow it served. Every capability
 * in the catalog must also be referenced by at least one plan, so a capability
 * nobody uses is a failure rather than dead weight.
 */

import { DentGrowArea } from "../../domain";
import { Capability, type CapabilityId } from "./action-catalog";

/** One step in a plan: a capability, plus the wording that plan needs. */
export interface ActionPlanStep {
  readonly capability: CapabilityId;
  /**
   * Override the catalog title where the plan gives it a sharper meaning.
   *
   * Used sparingly. The catalog title describes what the capability does; an
   * override describes what it is FOR here — "Find a slot for the freed-up time"
   * reads better in a cancellation plan than "Open the booking form".
   */
  readonly title?: string;
  /** Override the catalog description for the same reason. */
  readonly description?: string;
  /** Extra query parameters merged over the capability's own. */
  readonly filters?: Readonly<Record<string, string>>;
  /** Redirect a generic capability at the screen this plan is working from. */
  readonly area?: DentGrowArea;
  /**
   * The single action to click if only one thing gets done. Exactly one step per
   * plan carries this; the coverage test enforces it.
   */
  readonly primary?: boolean;
  /** Capabilities in the same plan that should be done first. */
  readonly after?: readonly CapabilityId[];
}

const {
  OPEN_CANCELLED_APPOINTMENTS,
  OPEN_NO_SHOWS,
  OPEN_NON_ATTENDANCE_HISTORY,
  OPEN_TOMORROWS_SCHEDULE,
  OPEN_NEXT_THREE_DAYS,
  OPEN_WEEK_SCHEDULE,
  OPEN_APPOINTMENT_SCHEDULER,
  OPEN_QUEUE_BOARD,
  OPEN_PLANNED_TREATMENTS,
  OPEN_IN_PROGRESS_TREATMENTS,
  OPEN_TODAYS_COMPLETED_TREATMENTS,
  OPEN_WEEKS_COMPLETED_TREATMENTS,
  OPEN_OVERDUE_RECALL_PATIENTS,
  OPEN_RECENT_PATIENTS,
  OPEN_NEW_REGISTRATIONS,
  OPEN_PATIENT_RECORD,
  OPEN_OVERDUE_FOLLOW_UPS,
  SCHEDULE_FOLLOW_UP,
  OPEN_OUTSTANDING_BALANCES,
  OPEN_TODAYS_PAYMENTS,
  OPEN_PATIENT_LEDGER,
  RECORD_PAYMENT,
  PREPARE_CALL_LIST,
  DRAFT_RECALL_INVITATION,
  DRAFT_APPOINTMENT_CONFIRMATION,
  DRAFT_PAYMENT_REMINDER,
  DRAFT_STANDBY_SLOT_OFFER,
  DRAFT_TREATMENT_PLAN_FOLLOW_UP,
  OPEN_AVAILABILITY_SETTINGS,
  OPEN_CLINIC_SETTINGS,
  OPEN_MONTH_PERFORMANCE_REPORT,
  OPEN_NEW_PATIENT_REPORT,
} = Capability;

/** Work the appointment list as a call list rather than the patient list. */
const CALL_FROM_APPOINTMENTS: ActionPlanStep = {
  capability: PREPARE_CALL_LIST,
  title: "Work the appointment list as a call list",
  area: DentGrowArea.APPOINTMENTS,
};

const CALL_FROM_TREATMENTS: ActionPlanStep = {
  capability: PREPARE_CALL_LIST,
  title: "Work the treatment list as a call list",
  area: DentGrowArea.TREATMENTS,
};

const CALL_FROM_BALANCES: ActionPlanStep = {
  capability: PREPARE_CALL_LIST,
  title: "Work the balance list as a call list",
  area: DentGrowArea.PAYMENTS,
};

const CALL_FROM_FOLLOW_UPS: ActionPlanStep = {
  capability: PREPARE_CALL_LIST,
  title: "Work the follow-up list as a call list",
  area: DentGrowArea.FOLLOW_UPS,
};

export const ACTION_PLANS: Readonly<Record<string, readonly ActionPlanStep[]>> = {
  // ── Scheduling ────────────────────────────────────────────────────────────
  cancellation_dominant: [
    { capability: OPEN_CANCELLED_APPOINTMENTS, primary: true },
    {
      capability: OPEN_APPOINTMENT_SCHEDULER,
      title: "Check which of those slots are still open",
      after: [OPEN_CANCELLED_APPOINTMENTS],
    },
    { ...CALL_FROM_APPOINTMENTS, after: [OPEN_CANCELLED_APPOINTMENTS] },
    { capability: DRAFT_STANDBY_SLOT_OFFER },
  ],

  no_show_dominant: [
    { capability: OPEN_TOMORROWS_SCHEDULE, primary: true },
    { capability: DRAFT_APPOINTMENT_CONFIRMATION },
    { ...CALL_FROM_APPOINTMENTS, after: [OPEN_TOMORROWS_SCHEDULE] },
    {
      capability: DRAFT_STANDBY_SLOT_OFFER,
      title: "Prepare an offer for slots nobody confirms",
    },
  ],

  patient_level_pattern: [
    { capability: OPEN_NON_ATTENDANCE_HISTORY, primary: true },
    {
      capability: DRAFT_APPOINTMENT_CONFIRMATION,
      title: "Prepare a confirmation for their next visit",
      description:
        "Prepares confirmation text to send before the next appointment of a patient who has missed before. Draft only — OraMedha does not send it.",
    },
    { ...CALL_FROM_APPOINTMENTS, after: [OPEN_NON_ATTENDANCE_HISTORY] },
    {
      capability: OPEN_APPOINTMENT_SCHEDULER,
      title: "Offer same-week booking instead of an advance date",
    },
    {
      capability: OPEN_PATIENT_RECORD,
      title: "Note on the record that the next visit needs confirming",
    },
  ],

  slot_clustering: [
    { capability: OPEN_CANCELLED_APPOINTMENTS, primary: true },
    { capability: OPEN_NO_SHOWS },
    { capability: OPEN_WEEK_SCHEDULE },
    { capability: OPEN_AVAILABILITY_SETTINGS, after: [OPEN_WEEK_SCHEDULE] },
  ],

  reminder_process: [
    { capability: OPEN_NEXT_THREE_DAYS, primary: true },
    { capability: DRAFT_APPOINTMENT_CONFIRMATION },
    { ...CALL_FROM_APPOINTMENTS, after: [OPEN_NEXT_THREE_DAYS] },
  ],

  // ── Revenue leakage ───────────────────────────────────────────────────────
  systemic_process: [
    { capability: OPEN_TODAYS_COMPLETED_TREATMENTS, primary: true },
    { capability: OPEN_TODAYS_PAYMENTS, after: [OPEN_TODAYS_COMPLETED_TREATMENTS] },
    { capability: RECORD_PAYMENT, after: [OPEN_TODAYS_PAYMENTS] },
    { capability: OPEN_PATIENT_LEDGER },
  ],

  patient_balances: [
    { capability: OPEN_OUTSTANDING_BALANCES, primary: true },
    { ...CALL_FROM_BALANCES, after: [OPEN_OUTSTANDING_BALANCES] },
    { capability: DRAFT_PAYMENT_REMINDER },
    { capability: OPEN_PATIENT_LEDGER },
    {
      capability: SCHEDULE_FOLLOW_UP,
      title: "Log a follow-up for anyone who agreed to pay later",
    },
  ],

  volume: [
    { capability: OPEN_OVERDUE_RECALL_PATIENTS, primary: true },
    { capability: OPEN_PLANNED_TREATMENTS },
    { capability: DRAFT_RECALL_INVITATION },
    { capability: PREPARE_CALL_LIST, after: [OPEN_OVERDUE_RECALL_PATIENTS] },
    { capability: OPEN_APPOINTMENT_SCHEDULER, title: "Book into the open slots" },
  ],

  yield: [
    { capability: OPEN_TODAYS_COMPLETED_TREATMENTS, primary: true },
    { capability: OPEN_TODAYS_PAYMENTS, after: [OPEN_TODAYS_COMPLETED_TREATMENTS] },
    { capability: RECORD_PAYMENT, after: [OPEN_TODAYS_PAYMENTS] },
  ],

  case_mix: [
    { capability: OPEN_WEEKS_COMPLETED_TREATMENTS, primary: true },
    { capability: OPEN_IN_PROGRESS_TREATMENTS },
    { capability: OPEN_MONTH_PERFORMANCE_REPORT },
  ],

  // ── Capacity ──────────────────────────────────────────────────────────────
  demand_exceeds_capacity: [
    { capability: OPEN_WEEK_SCHEDULE, primary: true },
    { capability: OPEN_QUEUE_BOARD },
    { capability: OPEN_AVAILABILITY_SETTINGS, after: [OPEN_WEEK_SCHEDULE] },
  ],

  schedule_overbooking: [
    { capability: OPEN_QUEUE_BOARD, primary: true },
    { capability: OPEN_WEEKS_COMPLETED_TREATMENTS },
    { capability: OPEN_CLINIC_SETTINGS, after: [OPEN_WEEKS_COMPLETED_TREATMENTS] },
  ],

  capacity_bound: [
    { capability: OPEN_WEEK_SCHEDULE, primary: true },
    { capability: OPEN_QUEUE_BOARD },
    { capability: OPEN_AVAILABILITY_SETTINGS, after: [OPEN_WEEK_SCHEDULE] },
  ],

  flow_bound: [
    { capability: OPEN_QUEUE_BOARD, primary: true },
    { capability: OPEN_WEEK_SCHEDULE },
    {
      capability: OPEN_APPOINTMENT_SCHEDULER,
      title: "Stagger the next bookings by their real duration",
    },
  ],

  service_time_variance: [
    { capability: OPEN_WEEKS_COMPLETED_TREATMENTS, primary: true },
    { capability: OPEN_QUEUE_BOARD },
    { capability: OPEN_CLINIC_SETTINGS, after: [OPEN_WEEKS_COMPLETED_TREATMENTS] },
  ],

  arrival_punctuality: [
    { capability: OPEN_QUEUE_BOARD, primary: true },
    { capability: OPEN_WEEK_SCHEDULE },
    {
      capability: OPEN_APPOINTMENT_SCHEDULER,
      title: "Give the next bookings specific arrival times",
    },
  ],

  // ── Retention and acquisition ─────────────────────────────────────────────
  acquisition_driven: [
    { capability: OPEN_NEW_PATIENT_REPORT, primary: true },
    { capability: OPEN_NEW_REGISTRATIONS },
    {
      capability: OPEN_RECENT_PATIENTS,
      title: "Ask recently seen patients about referrals",
    },
  ],

  retention_driven: [
    { capability: OPEN_OVERDUE_RECALL_PATIENTS, primary: true },
    { capability: PREPARE_CALL_LIST, after: [OPEN_OVERDUE_RECALL_PATIENTS] },
    { capability: DRAFT_RECALL_INVITATION },
    { capability: OPEN_APPOINTMENT_SCHEDULER, title: "Offer a specific date and book it" },
  ],

  recall_execution: [
    { capability: OPEN_OVERDUE_FOLLOW_UPS, primary: true },
    { capability: OPEN_OVERDUE_RECALL_PATIENTS },
    { ...CALL_FROM_FOLLOW_UPS, after: [OPEN_OVERDUE_FOLLOW_UPS] },
    { capability: DRAFT_RECALL_INVITATION },
    { capability: OPEN_APPOINTMENT_SCHEDULER, title: "Book those who agree, on the call" },
  ],

  // ── Treatment acceptance ──────────────────────────────────────────────────
  unconverted_demand: [
    { capability: OPEN_PLANNED_TREATMENTS, primary: true },
    { capability: OPEN_APPOINTMENT_SCHEDULER, title: "Check what is open this week" },
    { ...CALL_FROM_TREATMENTS, after: [OPEN_PLANNED_TREATMENTS] },
    { capability: DRAFT_TREATMENT_PLAN_FOLLOW_UP },
  ],

  insufficient_demand: [
    { capability: OPEN_OVERDUE_RECALL_PATIENTS, primary: true },
    { capability: OPEN_OVERDUE_FOLLOW_UPS },
    { capability: DRAFT_RECALL_INVITATION },
    { capability: OPEN_APPOINTMENT_SCHEDULER, title: "Book into this week's open slots" },
  ],

  capacity_not_offered: [
    { capability: OPEN_AVAILABILITY_SETTINGS, primary: true },
    { capability: OPEN_WEEK_SCHEDULE },
    {
      capability: OPEN_APPOINTMENT_SCHEDULER,
      title: "Confirm the new slots appear when booking",
      after: [OPEN_AVAILABILITY_SETTINGS],
    },
  ],

  booking_follow_through: [
    { capability: OPEN_PLANNED_TREATMENTS, primary: true },
    { capability: OPEN_APPOINTMENT_SCHEDULER, title: "Book the next visit now" },
    { capability: DRAFT_TREATMENT_PLAN_FOLLOW_UP },
    {
      capability: SCHEDULE_FOLLOW_UP,
      title: "Log a follow-up for anyone you could not reach",
    },
  ],

  patient_deferral: [
    { capability: OPEN_PLANNED_TREATMENTS, primary: true },
    { ...CALL_FROM_TREATMENTS, after: [OPEN_PLANNED_TREATMENTS] },
    { capability: DRAFT_TREATMENT_PLAN_FOLLOW_UP },
    { capability: OPEN_APPOINTMENT_SCHEDULER, title: "Book those who are ready" },
  ],

  cost_barrier: [
    { capability: OPEN_PLANNED_TREATMENTS, primary: true },
    { capability: OPEN_PATIENT_LEDGER, title: "Check what the patient has already paid" },
    { capability: DRAFT_TREATMENT_PLAN_FOLLOW_UP },
    { capability: OPEN_APPOINTMENT_SCHEDULER, title: "Book those who accept a payment plan" },
  ],

  // ── Operational ───────────────────────────────────────────────────────────
  no_available_capacity: [
    { capability: OPEN_WEEK_SCHEDULE, primary: true },
    { capability: OPEN_AVAILABILITY_SETTINGS, after: [OPEN_WEEK_SCHEDULE] },
    { capability: OPEN_PLANNED_TREATMENTS },
    {
      capability: OPEN_APPOINTMENT_SCHEDULER,
      title: "Book waiting treatment into the new time",
      after: [OPEN_AVAILABILITY_SETTINGS],
    },
  ],

  // ── Standalone single-signal readings ─────────────────────────────────────
  acquisition_shortfall: [
    { capability: OPEN_NEW_PATIENT_REPORT, primary: true },
    {
      capability: OPEN_RECENT_PATIENTS,
      title: "Ask this week's satisfied patients for a referral",
    },
    { capability: OPEN_CLINIC_SETTINGS, title: "Check the listing and contact details are current" },
  ],

  balance_owed: [
    { capability: OPEN_OUTSTANDING_BALANCES, primary: true },
    { ...CALL_FROM_BALANCES, after: [OPEN_OUTSTANDING_BALANCES] },
    { capability: DRAFT_PAYMENT_REMINDER },
  ],

  recall_backlog: [
    { capability: OPEN_OVERDUE_FOLLOW_UPS, primary: true },
    { capability: OPEN_OVERDUE_RECALL_PATIENTS },
    { ...CALL_FROM_FOLLOW_UPS, after: [OPEN_OVERDUE_FOLLOW_UPS] },
    { capability: DRAFT_RECALL_INVITATION },
    { capability: OPEN_APPOINTMENT_SCHEDULER, title: "Book those who agree, on the call" },
  ],

  // Reactivation. Deliberately does NOT open the overdue-follow-up list: these
  // patients are precisely the ones no follow-up was ever raised for, so that
  // screen would show the wrong people. The last step raises follow-ups for
  // whoever wants to come later, which is what stops the same patients lapsing
  // invisibly a second time.
  dormant_patient_base: [
    {
      capability: OPEN_OVERDUE_RECALL_PATIENTS,
      primary: true,
      title: "Open the patients with no visit in six months",
    },
    { ...CALL_FROM_APPOINTMENTS, area: DentGrowArea.PATIENTS, title: "Work it as a call list" },
    { capability: DRAFT_RECALL_INVITATION },
    { capability: OPEN_APPOINTMENT_SCHEDULER, title: "Book those who agree, on the call" },
    {
      capability: SCHEDULE_FOLLOW_UP,
      title: "Raise a follow-up for anyone who wants to come later",
      description:
        "Opens a blank follow-up. Recording an intention is what puts the patient on the recall list, so the next lapse shows up as a backlog rather than as silence.",
    },
  ],

  // Schedule accuracy. Every step is about the booking template rather than about
  // any patient, which is why no call list and no message draft appears here —
  // there is nobody to contact about a slot length.
  chronic_appointment_overrun: [
    {
      capability: OPEN_WEEKS_COMPLETED_TREATMENTS,
      primary: true,
      title: "See which treatments routinely run past their slot",
    },
    { capability: OPEN_WEEK_SCHEDULE, title: "Compare against the lengths those visits were booked for" },
    {
      capability: OPEN_AVAILABILITY_SETTINGS,
      title: "Set realistic default lengths for the types that overrun",
      after: [OPEN_WEEKS_COMPLETED_TREATMENTS],
    },
  ],

  // The month-level collection reconciliation. Opens the WEEK's completed
  // treatments rather than today's: the finding is that no single day looks wrong,
  // so a single day is the one view guaranteed not to show it.
  sustained_under_collection: [
    {
      capability: OPEN_WEEKS_COMPLETED_TREATMENTS,
      primary: true,
      title: "Pull the completed work to reconcile",
    },
    { capability: OPEN_OUTSTANDING_BALANCES, title: "Match each against a balance or a payment" },
    { capability: OPEN_PATIENT_LEDGER, after: [OPEN_WEEKS_COMPLETED_TREATMENTS] },
    { capability: RECORD_PAYMENT, title: "Raise the charges that were never recorded" },
    { ...CALL_FROM_BALANCES, after: [OPEN_OUTSTANDING_BALANCES] },
  ],

  // Sustained idle capacity. Two directions, in order: fill the time from lists the
  // clinic already owns, and only then reduce what it publishes.
  sustained_idle_capacity: [
    { capability: OPEN_WEEK_SCHEDULE, primary: true, title: "See which sessions are consistently empty" },
    { capability: OPEN_PLANNED_TREATMENTS, title: "Pull work that could fill them" },
    { capability: OPEN_OVERDUE_RECALL_PATIENTS, title: "Pull patients who are due back" },
    { capability: OPEN_APPOINTMENT_SCHEDULER, after: [OPEN_WEEK_SCHEDULE] },
    {
      capability: OPEN_AVAILABILITY_SETTINGS,
      title: "Where a session stays empty, reduce the hours you publish",
    },
  ],

  // The only plan that opens a FORWARD window. Every step points at days that
  // have not happened yet, and the two lists it pulls are the cheapest possible
  // sources of a booking: patients who already chose this clinic.
  forward_schedule_gap: [
    { capability: OPEN_WEEK_SCHEDULE, primary: true, title: "See which days next week are thinnest" },
    { capability: OPEN_PLANNED_TREATMENTS, title: "Pull patients with planned treatment and no next visit" },
    { capability: OPEN_OVERDUE_RECALL_PATIENTS, title: "Pull patients whose recall is overdue" },
    { ...CALL_FROM_TREATMENTS, after: [OPEN_PLANNED_TREATMENTS] },
    { capability: DRAFT_RECALL_INVITATION },
    { capability: OPEN_APPOINTMENT_SCHEDULER, title: "Book into next week's open slots, on the call" },
  ],

  // ── Investigative ─────────────────────────────────────────────────────────
  // Shorter plans, and deliberately so: the cause is not settled, so the actions
  // gather the measurement that would settle it rather than acting on a guess.
  "investigate.capacity": [
    { capability: OPEN_WEEK_SCHEDULE, primary: true },
    { capability: OPEN_AVAILABILITY_SETTINGS },
    { capability: OPEN_QUEUE_BOARD },
  ],

  "investigate.scheduling": [
    { capability: OPEN_CANCELLED_APPOINTMENTS, primary: true },
    { capability: OPEN_NO_SHOWS },
    {
      ...CALL_FROM_APPOINTMENTS,
      title: "Ask a few of them why they did not come",
      after: [OPEN_CANCELLED_APPOINTMENTS],
    },
  ],

  "investigate.revenue_leakage": [
    { capability: OPEN_OUTSTANDING_BALANCES, primary: true },
    { capability: OPEN_TODAYS_COMPLETED_TREATMENTS },
    { capability: OPEN_TODAYS_PAYMENTS },
  ],

  "investigate.treatment_acceptance": [
    { capability: OPEN_PLANNED_TREATMENTS, primary: true },
    {
      ...CALL_FROM_TREATMENTS,
      title: "Ask three to five patients what is holding them back",
      after: [OPEN_PLANNED_TREATMENTS],
    },
    { capability: OPEN_PATIENT_LEDGER, title: "Check whether cost is plausibly the barrier" },
    {
      capability: SCHEDULE_FOLLOW_UP,
      title: "Record what each patient told you",
      description:
        "Opens a blank follow-up. Writing the reason down is what lets the next analysis separate a cost barrier from a timing one — nothing else in OraMedha captures it.",
    },
  ],

  "investigate.retention": [
    { capability: OPEN_OVERDUE_RECALL_PATIENTS, primary: true },
    { capability: OPEN_OVERDUE_FOLLOW_UPS },
    {
      capability: PREPARE_CALL_LIST,
      title: "Ask five to ten of them why they have not been back",
      after: [OPEN_OVERDUE_RECALL_PATIENTS],
    },
  ],

  "investigate.patient_flow": [
    { capability: OPEN_QUEUE_BOARD, primary: true },
    { capability: OPEN_TOMORROWS_SCHEDULE, title: "Check how tightly the day is packed" },
    { capability: OPEN_WEEKS_COMPLETED_TREATMENTS, title: "Check whether visits are running long" },
  ],

  "investigate.reactivation": [
    { capability: OPEN_OVERDUE_RECALL_PATIENTS, primary: true },
    {
      ...CALL_FROM_APPOINTMENTS,
      area: DentGrowArea.PATIENTS,
      title: "Ask five to ten of them plainly whether anything changed",
      after: [OPEN_OVERDUE_RECALL_PATIENTS],
    },
    { capability: OPEN_MONTH_PERFORMANCE_REPORT, title: "Check when the drop-off began" },
  ],

  "investigate.schedule_accuracy": [
    { capability: OPEN_WEEKS_COMPLETED_TREATMENTS, primary: true },
    { capability: OPEN_QUEUE_BOARD, title: "Check that queue entries are being closed promptly" },
    { capability: OPEN_WEEK_SCHEDULE, title: "Compare booked lengths against what was delivered" },
  ],

  "investigate.acquisition": [
    { capability: OPEN_NEW_PATIENT_REPORT, primary: true },
    { capability: OPEN_NEW_REGISTRATIONS },
    {
      capability: OPEN_RECENT_PATIENTS,
      title: "Ask recent new patients how they found the clinic",
    },
  ],

  "investigate.forward_schedule": [
    { capability: OPEN_WEEK_SCHEDULE, primary: true, title: "Check next week day by day" },
    {
      capability: OPEN_AVAILABILITY_SETTINGS,
      title: "Confirm next week's hours are published and bookable",
    },
  ],
};
