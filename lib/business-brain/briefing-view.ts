/**
 * lib/business-brain/briefing-view.ts
 *
 * The projection behind the redesigned Morning Briefing.
 *
 * The page has exactly two columns — Problems (left) and Actions (right) — so
 * this file produces exactly two lists, paired by problem id. Everything here is
 * plain language a dentist or receptionist reads without translation: no
 * "constraint", "signal", "diagnosis", "confidence" or any other word from the
 * machinery that produced it. Those words are correct inside the engine and
 * wrong on this page.
 *
 * It decides nothing. Severity, ordering and what counts as a problem all arrive
 * already settled from the pipeline; this only renames and reshapes.
 */

import type {
  ActionDraftKind,
  BusinessBrainResult,
  Constraint,
  Diagnosis,
  Metric,
  Opportunity,
  OpportunityQuantity,
  Priority,
  Severity,
} from "@/business-brain";
import { WorkflowOwner } from "@/business-brain";
import { BRIEFING_MESSAGE_KINDS } from "@/lib/messaging/templates";

// ── How long this has been going on ──────────────────────────────────────────

/**
 * Whether the reader should treat the trend as good news, bad news, or neither.
 *
 * Separate from severity, which says how big the problem is. A small problem that
 * is getting worse and a large one that is receding are different messages, and
 * the card needs to colour them differently without implying either is the more
 * urgent.
 */
export type TrendTone = "worsening" | "improving" | "neutral";

/**
 * The plain-language read on a problem's history.
 *
 * The Diagnosis Engine has always classified this — transient, intermittent,
 * sustained, worsening, improving, with the consecutive-day count behind it — and
 * the projection threw it away, so a dentist saw a flat statement of today for a
 * problem the engine knew was in its third day.
 *
 * Null when the engine could not classify it. That is the common case for a new
 * clinic and it must stay silent rather than defaulting to "new today", which
 * would be a claim about history rather than an absence of it.
 */
export interface TrendView {
  /** Two or three words for the chip: "New today", "3rd day running". */
  readonly label: string;
  readonly tone: TrendTone;
  /** One sentence, shown only when the card is expanded. */
  readonly detail: string;
}

// ── Left column: one problem, in plain words ─────────────────────────────────

export interface ProblemView {
  readonly id: string;
  readonly title: string;
  readonly severity: Severity;
  /**
   * The constraint category this card is about, e.g. "revenue_leakage".
   *
   * Surfaced so the card can offer a snooze: a dismissal is recorded against the
   * category and the severity, and both have to travel with the card for the
   * control to say what it is actually suppressing.
   */
  readonly category: string;
  /** One short line naming the problem, with a real number where we have one. */
  readonly summary: string;
  /** A short paragraph: what it means and why it matters. */
  readonly explanation: string;
  /** The formatted figure at stake, or null when it could not be measured. */
  readonly atStake: string | null;
  readonly atStakeLabel: string | null;
  /** Practical, shown only when the card is expanded. */
  readonly howToFix: string;
  /** Plain evidence, shown only when the card is expanded. */
  readonly whyWeThink: string;
  /**
   * How long this has been going on, when the engine could classify it.
   *
   * Null rather than a default: see {@link TrendView}.
   */
  readonly trend: TrendView | null;
}

// ── Right column: one thing to do, with a checklist ──────────────────────────

export interface ChecklistItem {
  readonly id: string;
  readonly label: string;
}

export interface BriefingButton {
  readonly label: string;
  readonly href: string;
}

/**
 * Which inline action a button performs. The button itself (which dialog it
 * opens) is rendered by ActionCard — this is just the discriminator.
 */
export type PrimaryActionKind = "contact_patients" | "book_appointment" | "create_follow_up";

export interface PrimaryAction {
  readonly kind: PrimaryActionKind;
  readonly label: string;
}

export interface ActionCardView {
  readonly id: string;
  /** The problem this action resolves — pairs it with the left column. */
  readonly problemId: string;
  readonly category: string;
  /** Action-oriented heading — what to DO, never a restatement of the problem. */
  readonly title: string;
  readonly reason: string;
  readonly checklist: readonly ChecklistItem[];
  /**
   * Every directly-executable inline action for this diagnosis, in priority
   * order — a card can offer more than one when more than one genuinely
   * applies (e.g. a planned-treatment patient can be contacted OR booked
   * directly). Empty when nothing is directly executable; ActionCard renders
   * the first entry as the visually primary button and any further entries
   * as secondary buttons alongside it, never competing for top billing.
   */
  readonly primaryActions: readonly PrimaryAction[];
  /** Secondary "see the full list" link, shown inside the Steps dropdown. */
  readonly moreInfoLink: BriefingButton | null;
  readonly ownerLabel: string;
  readonly timeframeLabel: string;
  /** Short past-tense phrase for the score-change toast, e.g. "Payment recorded". */
  readonly doneReason: string;
  /**
   * Set when this card's patients can be reached with a prepared WhatsApp
   * message (recall, payment reminder, next-visit). Drives the inline
   * "Contact Patients" action when `primaryActions` includes it; absent
   * categories have no per-patient message.
   */
  readonly messageKind?: ActionDraftKind;
  /**
   * Measured opportunities that belong to this card's finding — both halves of
   * each (the open time or delivered work, and the patients or balance on the
   * other side). Absent when none attaches. Carried on the existing card rather
   * than as a card of their own: an opportunity is a sharper reading of the same
   * finding, not a second thing to do.
   */
  readonly opportunities?: readonly OpportunityView[];
}

/**
 * An opportunity in the page's language.
 *
 * Every line states a recorded figure. None of them ranks a patient, predicts a
 * booking or forecasts revenue — the engine never produced any of those, and the
 * words here must not add them.
 */
export interface OpportunityView {
  readonly id: string;
  readonly type: Opportunity["type"];
  readonly headline: string;
  /** The capacity or delivered-work side. */
  readonly surplusLine: string;
  /** The patients or balance side. */
  readonly demandLine: string;
  /** A recorded amount and what it is not, or null when none is recorded. */
  readonly impactLine: string | null;
  readonly priority: Priority;
  /** ISO-8601; null when the opportunity has no deadline. Formatting is the page's job. */
  readonly expiresAt: string | null;
  /** The prepared plan's first action, from the existing catalog. */
  readonly primaryActionId: string | null;
}

export interface BriefingView {
  readonly problems: readonly ProblemView[];
  readonly actions: readonly ActionCardView[];
  /**
   * Opportunities with no card to sit on — the run raised no finding about the
   * same resource, or it was merged away. Not rendered yet; carried so the next
   * UI step has them without re-deriving anything.
   */
  readonly unattachedOpportunities?: readonly OpportunityView[];
}

// ── Plain-language copy, keyed by problem category ───────────────────────────

interface CategoryCopy {
  readonly title: string;
  readonly explanation: string;
  readonly howToFix: string;
  readonly whyWeThink: string;
  /** Fallback summary when no live count is available for this category. */
  readonly summaryFallback: string;
  readonly atStakeLabel: string | null;
}

const COPY: Record<string, CategoryCopy> = {
  revenue_leakage: {
    title: "Patients owe money for completed work",
    explanation:
      "This is money the clinic has already earned but hasn't collected. The longer a balance sits unpaid, the harder it usually gets to recover.",
    howToFix:
      "Work through the unpaid balances, oldest first, and follow up with each patient to arrange payment.",
    whyWeThink: "Patients have completed treatment on record with no matching payment.",
    summaryFallback: "Some completed work hasn't been paid for.",
    atStakeLabel: "owed",
  },
  treatment_acceptance: {
    title: "Patients haven't booked their next visit",
    explanation:
      "These patients started or planned treatment but have nothing booked next. Unless someone contacts them, they may not come back to finish.",
    howToFix:
      "Open the list of planned treatments and book a next visit for each patient who doesn't have one.",
    whyWeThink: "There's planned treatment on record for patients with nothing on the calendar.",
    summaryFallback: "Some patients with planned treatment have no next visit.",
    atStakeLabel: "in planned treatment",
  },
  capacity: {
    title: "Your chair was empty today",
    explanation:
      "Chairs sat unused during opening hours. Empty chair time is capacity — and income — that can't be recovered later.",
    howToFix:
      "Fill open slots by bringing forward planned treatments or offering appointments to patients who are due.",
    whyWeThink: "Booked time today was well below the hours the clinic was open.",
    summaryFallback: "The clinic had unused chair time today.",
    atStakeLabel: "of empty chair time today",
  },
  scheduling: {
    title: "Patients cancelled or didn't show up",
    explanation:
      "Booked slots went unused because patients cancelled late or didn't arrive. Each lost slot is a patient not treated and a gap that's hard to fill at short notice.",
    howToFix:
      "Confirm tomorrow's appointments in advance, and offer freed-up slots to patients on your waiting list.",
    whyWeThink: "The share of appointments cancelled or missed was higher than normal.",
    summaryFallback: "More appointments than usual were lost.",
    atStakeLabel: "appointments lost today",
  },
  retention: {
    title: "Patients have stopped coming back",
    explanation:
      "Existing patients aren't returning at the usual rate. Returning patients are the steadiest source of work, so a drop here tends to show up in income later.",
    howToFix: "Reach out to patients who are overdue for a check-up and invite them back in.",
    whyWeThink: "Return visits are down while overdue recalls are building up.",
    summaryFallback: "Fewer patients are coming back than usual.",
    atStakeLabel: "patients overdue",
  },
  forward_schedule: {
    title: "Next week is filling up slowly",
    explanation:
      "Less of next week's chair time is booked than usual. This is the one thing here you can still change before it happens — every other item describes a day that's already gone.",
    howToFix:
      "Call patients with planned treatment and patients who are overdue for a check-up, and offer them a specific slot from next week's open time.",
    whyWeThink: "Less of the chair time offered over the next 7 days is booked than this clinic normally has by now.",
    summaryFallback: "Next week has more open chair time than usual.",
    // No at-stake figure: what is at stake is chair time, and nothing measures
    // the minutes the coming week offers. The real number lives in the summary
    // line as a share instead. See ConstraintCategory.FORWARD_SCHEDULE.
    atStakeLabel: null,
  },
  patient_flow: {
    title: "Patients waited too long after arriving",
    explanation:
      "People sat in the waiting room longer than they should have. A long wait is the thing patients remember and the thing they mention in reviews, and unlike most problems here it costs you nothing to fix — it is usually about how the day is arranged rather than how much work there is.",
    howToFix:
      "Look at when the queue built up. If the chairs were free at the time, spread the bookings out and stagger arrival times. If they were full, the day simply had more work in it than it could hold.",
    whyWeThink: "Patients were queueing and waiting longer than the clinic's own limits.",
    summaryFallback: "Patients waited longer than they should have today.",
    atStakeLabel: "average wait today",
  },
  reactivation: {
    title: "Patients have quietly stopped coming back",
    explanation:
      "These patients have been to the clinic before, have not been back in a long time, and have nothing booked — and none of them is on your recall list, because no follow-up was ever raised for them. They are invisible until somebody goes looking.",
    howToFix:
      "Open the list of patients not seen in six months, longest absence first, and call them. Raise a follow-up for anyone who wants to come later, so they cannot drop off the list again.",
    whyWeThink:
      "Patients on the roster have no visit within a recall interval and nothing booked, while the overdue recall list is within its normal limit — so these are different people from the ones that list covers.",
    summaryFallback: "Patients who used to come have stopped, and none is on the recall list.",
    atStakeLabel: "patients gone quiet",
  },
  schedule_accuracy: {
    title: "Appointments take longer than the time booked for them",
    explanation:
      "Over the last month, visits have consistently run past the slot they were booked into. Nobody queued today, so the difference is being absorbed by the day running late rather than showing up as a waiting room — which is why it is easy to miss and why it repeats every week.",
    howToFix:
      "Look at which treatments routinely finish later than booked, and lengthen the default slot you book them into, so a full day on paper is a day the clinic can actually deliver.",
    whyWeThink:
      "Comparing the time each appointment was booked for against the time between calling the patient in and finishing with them, across enough visits that no single long appointment explains it.",
    summaryFallback: "Appointments are running longer than the time booked for them.",
    // No at-stake figure: what is at stake is minutes, and the only measurement
    // available is a ratio over the window. The share is stated in the summary
    // line instead, where a share reads as a share. See
    // ConstraintCategory.SCHEDULE_ACCURACY in the Value Engine.
    atStakeLabel: null,
  },
  acquisition: {
    title: "Fewer new patients than usual",
    explanation:
      "Fewer new patients registered than this clinic usually sees. New patients are how a practice grows and replaces the ones who naturally move on.",
    howToFix:
      "Check that enquiries are being followed up promptly and that referral sources are still active.",
    whyWeThink: "New registrations were lower than this clinic's normal.",
    summaryFallback: "New patient numbers are below normal.",
    atStakeLabel: null,
  },
};

/**
 * The categories COPY covers, exported so a completeness test can compare them
 * against `ConstraintCategory`.
 *
 * A category with no entry here still renders — it falls back to the constraint's
 * own name and description, which are written in the engine's vocabulary
 * ("bottleneck", "findings point here") and are exactly the words this page
 * exists to keep off the screen. That degradation is silent, which is why it
 * needs a test rather than a code review.
 */
export const COPY_CATEGORIES: readonly string[] = Object.keys(COPY);

/**
 * Action-card headings, keyed the same as COPY but answering a different
 * question. COPY.title says what's WRONG ("Patients owe money for completed
 * work"); this says what to DO about it ("Follow up on outstanding
 * payments") — the two must never be the same string, or the right column
 * just echoes the left one instead of telling the dentist what to click.
 */
const ACTION_TITLE: Record<string, string> = {
  revenue_leakage: "Follow up on outstanding payments",
  treatment_acceptance: "Bring planned treatments back onto the schedule",
  capacity: "Fill your open chair time",
  scheduling: "Recover today's lost appointments",
  retention: "Reach out to patients who are overdue",
  acquisition: "Give new enquiries a closer look",
  forward_schedule: "Fill next week's open slots",
  patient_flow: "Ease the wait in your waiting room",
  reactivation: "Call the patients who have stopped coming",
  schedule_accuracy: "Book the time your appointments really take",
};

// ── Live counts for concrete summaries ───────────────────────────────────────

function metricValue(metrics: readonly Metric[], key: string): number | null {
  const m = metrics.find((x) => x.id.startsWith(`${key}:`));
  return m ? m.value : null;
}

const rupees = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

/**
 * A concrete, numbered summary line for a category, or the fallback.
 *
 * `patientCount`, when given for a category, is the DISTINCT-patient count and
 * wins over the raw metric. The metric behind treatment/retention counts rows
 * (treatments, follow-ups), so a patient with several planned treatments would
 * inflate it; the briefing states patients, so it must count patients. This is
 * what keeps "14 patients have planned treatment" agreeing with the send list.
 */
function summaryFor(
  category: string,
  copy: CategoryCopy,
  metrics: readonly Metric[],
  patientCount?: number,
): string {
  const count = (v: number | null, one: string, many: string) => {
    if (v === null || v <= 0) return null;
    const n = Math.round(v);
    return n === 1 ? one : many.replace("{n}", String(n));
  };

  if (category === "revenue_leakage") {
    const v = metricValue(metrics, "revenue.outstanding");
    if (v && v > 0) return `${rupees(v)} is owed for treatment that's already been done.`;
  }
  if (category === "treatment_acceptance") {
    const s = count(
      patientCount ?? metricValue(metrics, "treatment.accepted_pending_scheduling"),
      "1 patient has planned treatment but no next visit.",
      "{n} patients have planned treatment but no next visit.",
    );
    if (s) return s;
  }
  if (category === "forward_schedule") {
    // Checked against null rather than truthiness: a week that is 0% booked is
    // the most urgent version of this finding, not a missing measurement.
    const v = metricValue(metrics, "capacity.booked_next_7d");
    if (v !== null) return `Only ${Math.round(v)}% of next week's chair time is booked.`;
  }
  if (category === "retention") {
    const s = count(
      patientCount ?? metricValue(metrics, "followups.overdue"),
      "1 patient has a follow-up due.",
      "{n} patients have a follow-up due.",
    );
    if (s) return s;
  }
  if (category === "reactivation") {
    // Never the patientCount override: that map is keyed by WhatsApp message
    // population, and this card deliberately has none — its patients are the ones
    // with no follow-up, which is the opposite of the recall send list. Reading it
    // here would state the recall list's size under the lapsed card's heading.
    const s = count(
      metricValue(metrics, "patients.reactivation_candidates"),
      "1 patient has been seen before but hasn't been back, with nothing booked.",
      "{n} patients have been seen before but haven't been back, with nothing booked.",
    );
    if (s) return s;
  }
  if (category === "patient_flow") {
    const v = metricValue(metrics, "queue.average_waiting_time");
    if (v !== null && v > 0) {
      return `Patients waited ${formatAtStake(v, "minutes")} on average after arriving.`;
    }
  }
  if (category === "schedule_accuracy") {
    const overrun = metricValue(metrics, "scheduling.appointment_overrun_30d");
    const sample = metricValue(metrics, "scheduling.measured_visits_30d");
    if (overrun !== null && overrun > 0) {
      // The sample is named because it is what makes the figure credible: the
      // same percentage over 4 visits would be one difficult morning.
      return sample !== null && sample > 0
        ? `Appointments ran ${Math.round(overrun)}% longer than booked, across ${Math.round(sample)} visits.`
        : `Appointments ran ${Math.round(overrun)}% longer than the time booked for them.`;
    }
  }
  return copy.summaryFallback;
}

/** Format an at-stake amount the way a clinic would say it aloud. */
function formatAtStake(amount: number, unit: string): string {
  if (unit === "currency") return rupees(amount);
  if (unit === "minutes") {
    const hours = Math.floor(amount / 60);
    const minutes = Math.round(amount % 60);
    if (hours === 0) return `${minutes} min`;
    return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`;
  }
  return `${Math.round(amount)}`;
}

// ── Right-column actions ──────────────────────────────────────────────────────
//
// Each category gets every directly-executable action that genuinely applies
// to it — opened inline (as a dialog) by ActionCard, never a navigation. A
// category can list more than one (a planned-treatment patient can be
// contacted about booking, or booked directly); "acquisition" has none,
// because there is no inline action that fixes "fewer new patients than
// usual" today. Order matters: the FIRST entry is the one ActionCard renders
// as the visually primary button; any further entries render as secondary
// buttons beside it, never competing for top billing.
//
// `moreInfoLink` is a secondary, lower-emphasis deep-link into the full list
// view for whoever wants to work through every record by hand — shown inside
// the "Steps" dropdown, never as a competing primary button.

const PRIMARY_ACTIONS: Partial<Record<string, readonly PrimaryActionKind[]>> = {
  revenue_leakage: ["contact_patients"],
  treatment_acceptance: ["contact_patients", "book_appointment"],
  retention: ["contact_patients", "create_follow_up"],
  capacity: ["book_appointment"],
  scheduling: ["book_appointment"],
  // Booking only, deliberately. Filling next week means calling patients with
  // planned treatment or an overdue recall — but those are exactly the
  // populations the treatment_acceptance and retention cards already own, each
  // with its own prepared message. There is no "next week is thin" message,
  // because the thing you say depends on which of those two lists the patient is
  // on, and ActionCard drops a contact button with no message kind anyway. The
  // checklist under Steps sends staff to both lists.
  forward_schedule: ["book_appointment"],
  // Booking and a follow-up, but NO contact action: these patients have no
  // prepared message. The recall invitation belongs to `retention`, whose
  // population is the overdue follow-up list — and this card exists precisely
  // because these are DIFFERENT people. Pointing both at one message kind would
  // make the two send lists resolve to the same patients and undo the split.
  reactivation: ["book_appointment", "create_follow_up"],
  // patient_flow: nothing inline shortens a wait that has already happened.
  // schedule_accuracy: the fix is a booking default in settings, not an inline act.
  // acquisition: no directly-executable action exists today.
};

const PRIMARY_ACTION_LABEL: Record<PrimaryActionKind, string> = {
  contact_patients: "Contact Patients",
  book_appointment: "Book Appointment",
  create_follow_up: "Create Follow-up",
};

const MORE_INFO_LINK: Record<string, BriefingButton> = {
  revenue_leakage: { label: "Open unpaid balances", href: "/dentist/payments" },
  treatment_acceptance: { label: "Open planned treatments", href: "/dentist/treatments?status=planned" },
  capacity: { label: "Open the schedule", href: "/dentist/appointments" },
  scheduling: { label: "Open appointments", href: "/dentist/appointments" },
  retention: { label: "Open overdue recalls", href: "/dentist/follow-ups?status=pending" },
  acquisition: { label: "Open patients", href: "/dentist/patients" },
  forward_schedule: { label: "Open next week's schedule", href: "/dentist/appointments" },
  patient_flow: { label: "Open the queue", href: "/dentist/queue" },
  reactivation: {
    label: "Open patients not seen in six months",
    href: "/dentist/patients?filter=inactive",
  },
  schedule_accuracy: { label: "Open the schedule", href: "/dentist/appointments" },
};

// ── The one card that says something no other PMS can ────────────────────────

/**
 * Whether the day's idle chair time and its unbooked treatment are the SAME
 * story, according to the engine rather than according to this file.
 *
 * Two cards saying "your chair was empty" and "patients haven't booked" is the
 * view fragmenting one finding into two — the exact thing the Constraint Engine
 * exists to prevent, undone one layer later. But they are only one story when
 * the demand was genuinely there and went unconverted, and that is a judgement
 * this projection has no business making: idle chairs and an unbooked treatment
 * book can also co-occur for unrelated reasons (a day the clinic closed early,
 * a plan raised an hour ago).
 *
 * So it is not inferred from the two constraints being present. It is read from
 * the Diagnosis Engine having SETTLED `unconverted_demand` on
 * `demand_supply_mismatch` — the hypothesis whose supporting evidence is
 * literally "planned treatment demand is at or above its limit while the chair
 * was idle, so demand demonstrably existed on this day". When that is supported,
 * the combination is a measured finding. When it is not, two cards is correct.
 */
function idleChairAndUnbookedTreatmentAreOneStory(result: BusinessBrainResult): boolean {
  return (result.diagnoses ?? []).some(
    (d) =>
      d.pattern === "demand_supply_mismatch" &&
      d.hypotheses.some(
        (h) => h.id.endsWith("#h.unconverted_demand") && h.status === "supported",
      ),
  );
}

/**
 * Whether the capacity bottleneck is about the MONTH rather than about today.
 *
 * `sustained_idle_capacity` and the today-level capacity patterns deliberately
 * share one constraint category, so the Constraint Engine gives a clinic one
 * capacity card instead of two competing headlines. That is right, and it leaves
 * this projection one job: when the ONLY thing that fired is the window reading,
 * the card must not say "your chair was empty today" and must not headline today's
 * idle minutes — today was fine, which is exactly the point.
 *
 * Read from the run's diagnoses rather than inferred from the metrics, for the
 * same reason the merge check is: a 30-day utilization figure being low is not the
 * same as the engine having decided it is a finding.
 */
function capacityIsMonthLevelOnly(result: BusinessBrainResult): boolean {
  const capacityPatterns = new Set([
    "demand_supply_mismatch",
    "capacity_ceiling",
    "sustained_idle_capacity",
  ]);
  const present = (result.diagnoses ?? [])
    .map((d) => d.pattern as string)
    .filter((p) => capacityPatterns.has(p));
  return present.length > 0 && present.every((p) => p === "sustained_idle_capacity");
}

/** The capacity card, worded for a month rather than for a day. */
function monthLevelCapacityProblem(
  result: BusinessBrainResult,
  constraint: Constraint,
  metrics: readonly Metric[],
): ProblemView {
  const utilization = metricValue(metrics, "capacity.chair_utilization_30d");
  return {
    id: constraint.id,
    title: "Chair time is going unused month after month",
    severity: constraint.severity,
    category: constraint.category,
    summary:
      utilization !== null
        ? `Over the last 30 days you booked ${Math.round(utilization)}% of the chair time you opened.`
        : "Chair time has been going unused across the month, not just on one day.",
    explanation:
      "This is not one quiet day — it is the shape of a normal month for this clinic. That matters because you cannot respond to a quiet Tuesday, but you can change what a normal week looks like.",
    // No at-stake figure on purpose. The sized value for this bottleneck is
    // TODAY's unbooked minutes, and today was not the problem; showing it here
    // would put a small, irrelevant number under a month-level heading.
    atStake: null,
    atStakeLabel: null,
    howToFix:
      "Fill the empty sessions from lists you already have — planned treatment with no next visit, and patients who are due back. Where a session stays empty week after week, publish fewer hours for it instead.",
    whyWeThink:
      "Booked chair time across the last 30 days was below the level this clinic should sustain, measured against the hours it actually opened — closed days count towards neither side.",
    trend: trendFor(drivingDiagnosis(result, constraint)),
  };
}

// ── Trend projection ─────────────────────────────────────────────────────────

/**
 * Which contributing diagnosis's history the card reports.
 *
 * The one that DRIVES the constraint's severity. That is not an arbitrary pick —
 * the Constraint Engine already sets a bottleneck's severity to its worst
 * contributing diagnosis, never an average, and reporting that same diagnosis's
 * history keeps the card's two claims about one finding rather than two. Ties
 * break on diagnosis id, which the Constraint Engine already sorts, so the
 * output is byte-identical across runs.
 */
const SEVERITY_RANK_FOR_TREND: Readonly<Record<string, number>> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function drivingDiagnosis(
  result: BusinessBrainResult,
  constraint: Constraint,
): Diagnosis | null {
  const ids = new Set(constraint.relatedDiagnosisIds ?? []);
  const contributing = (result.diagnoses ?? []).filter((d) => ids.has(d.id));
  if (contributing.length === 0) return null;

  return contributing.reduce((worst, d) => {
    const a = SEVERITY_RANK_FOR_TREND[d.severity] ?? 0;
    const b = SEVERITY_RANK_FOR_TREND[worst.severity] ?? 0;
    if (a !== b) return a > b ? d : worst;
    return d.id < worst.id ? d : worst;
  });
}

/** "2nd", "3rd", "11th" — ordinals a clinic reads without stumbling. */
function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * Turn the engine's persistence classification into words for the card.
 *
 * Every branch states a measurement. None of them says what to do about it, and
 * none of them claims a cause — "worsening" is a statement that the breach got
 * bigger, not a theory about why.
 *
 * `insufficient_history` returns null. A clinic three days old genuinely has no
 * history to report, and filling the chip with "New today" would turn an absence
 * of data into a claim about the clinic.
 */
export function trendFor(diagnosis: Diagnosis | null): TrendView | null {
  if (diagnosis === null) return null;
  const detail = diagnosis.persistenceDetail;
  const days = detail?.consecutiveDays ?? 1;

  switch (diagnosis.persistence) {
    case "insufficient_history":
      return null;

    case "transient":
      return {
        label: "New today",
        tone: "neutral",
        detail: "This is the first day it has shown up in the records we hold.",
      };

    case "intermittent":
      // Says WHY it is being described loosely when missing data is the reason.
      // Presenting a data gap as clinic behaviour would be a quiet lie.
      return {
        label: "On and off",
        tone: "neutral",
        detail: detail?.cappedByUnknown
          ? "It has come and gone over recent days, and some of those days could not be measured, so we can't say whether it is settling or building."
          : `It has come and gone rather than persisting — seen on ${detail?.priorFiredDays ?? 0} of the recent days we hold.`,
      };

    case "sustained":
      return {
        label: days >= 2 ? `${ordinal(days)} day running` : "Ongoing",
        tone: "neutral",
        detail:
          days >= 2
            ? `It has been there ${days} days in a row, at about the same level.`
            : "It has persisted rather than being a one-off, at about the same level.",
      };

    case "worsening":
      return {
        label: "Worsening",
        tone: "worsening",
        detail:
          days >= 2
            ? `It has been there ${days} days in a row and has been getting bigger, not holding steady.`
            : "It has been getting bigger rather than holding steady.",
      };

    case "improving":
      return {
        label: "Improving",
        tone: "improving",
        detail:
          "It is still here, but smaller than it was over the recent days we hold — moving in the right direction.",
      };

    default:
      return null;
  }
}

/** Minutes as a clinic would say them aloud: "2 hr 30 min", "45 min". */
function spokenMinutes(amount: number): string {
  return formatAtStake(amount, "minutes");
}

/** Worst of two severities wins, matching the Constraint Engine's own rule. */
const SEVERITY_ORDER = ["info", "low", "medium", "high", "critical"];
function worstOf(a: Severity, b: Severity): Severity {
  return SEVERITY_ORDER.indexOf(b) > SEVERITY_ORDER.indexOf(a) ? b : a;
}

/**
 * The sentence a general scheduling tool cannot say and a general CRM cannot
 * say: how much chair time is going unused, and exactly who could fill it.
 *
 * It is only sayable by something that owns the appointment ledger and the
 * treatment ledger at once, which is the whole argument for this being one
 * product rather than two integrations.
 */
function mergedSummary(
  result: BusinessBrainResult,
  capacity: Constraint,
  metrics: readonly Metric[],
  patientCounts?: Readonly<Partial<Record<string, number>>>,
): string {
  const patients =
    patientCounts?.["treatment_acceptance"] ??
    metricValue(metrics, "treatment.accepted_pending_scheduling");
  const idle = result.valueAtStake.get(capacity.id)?.[0];

  const who =
    patients !== null && patients !== undefined && patients > 0
      ? `${Math.round(patients)} patient${Math.round(patients) === 1 ? "" : "s"} with planned treatment ${Math.round(patients) === 1 ? "has" : "have"} no next visit booked`
      : "patients with planned treatment have no next visit booked";

  // Both halves where both were measured; the patient half alone otherwise —
  // never a fabricated "0 minutes", which would read as a full day.
  return idle && idle.amount > 0
    ? `${spokenMinutes(idle.amount)} of chair time went unused today, and ${who}.`
    : `${who}, while chair time went unused today.`;
}

function mergedProblem(
  result: BusinessBrainResult,
  capacity: Constraint,
  acceptance: Constraint,
  metrics: readonly Metric[],
  patientCounts?: Readonly<Partial<Record<string, number>>>,
): ProblemView {
  // The money already on the books is the headline, not the idle minutes: it is
  // the figure that makes the case for acting today, and the minutes are stated
  // in the summary line right beneath it.
  const pending = result.valueAtStake.get(acceptance.id)?.[0];

  return {
    id: capacity.id,
    title: "Your chair sat idle while patients were waiting to be booked",
    severity: worstOf(capacity.severity, acceptance.severity),
    // Snoozing the merged card suppresses the capacity constraint it is keyed
    // to; the treatment-acceptance half is folded into it and travels with it.
    category: capacity.category,
    summary: mergedSummary(result, capacity, metrics, patientCounts),
    explanation:
      "These are not two problems. The treatment these patients have already planned is the work that would have filled today's empty chair time — the demand existed and simply never got booked in.",
    atStake: pending ? formatAtStake(pending.amount, pending.unit) : null,
    atStakeLabel: pending ? "in planned treatment, unbooked" : null,
    howToFix:
      "Work the planned-treatment list against your open slots: call each patient who has no next visit and offer them a specific time from the gaps in this week's schedule.",
    whyWeThink:
      "Chair time went unused on a day when patients with planned treatment had nothing booked, so the demand to fill it was already on your own books.",
    // Keyed to the capacity half, the constraint this merged card carries and is
    // snoozed against — so the history shown is the history of the finding the
    // card is filed under, not of the half folded into it.
    trend: trendFor(drivingDiagnosis(result, capacity)),
  };
}

function mergedAction(
  result: BusinessBrainResult,
  capacity: Constraint,
  acceptance: Constraint,
  metrics: readonly Metric[],
  patientCounts?: Readonly<Partial<Record<string, number>>>,
): ActionCardView {
  // The treatment-acceptance workflow is the one with the steps that actually
  // fill a chair (pull the list, call, offer a specific time). The capacity
  // workflow's steps are about why the chair was empty, which this card has
  // already answered.
  const workflow =
    result.workflows.find((w) => w.constraintId === acceptance.id) ??
    result.workflows.find((w) => w.constraintId === capacity.id);

  return {
    id: `action-${capacity.id}`,
    problemId: capacity.id,
    // Keyed to treatment_acceptance so the WhatsApp population, the reminder
    // summary and the "already contacted" count all resolve to the patients this
    // card is actually about.
    category: "treatment_acceptance",
    title: "Fill today's gaps from your own planned treatments",
    reason: mergedSummary(result, capacity, metrics, patientCounts),
    checklist: (workflow?.tasks ?? []).map((t) => ({ id: t.id, label: t.instruction })),
    primaryActions: (PRIMARY_ACTIONS["treatment_acceptance"] ?? []).map((kind) => ({
      kind,
      label: PRIMARY_ACTION_LABEL[kind],
    })),
    moreInfoLink: MORE_INFO_LINK["treatment_acceptance"] ?? null,
    ownerLabel: workflow ? (OWNER_LABEL[workflow.owner] ?? "You") : "You",
    timeframeLabel: "Today",
    doneReason: "Chair time filled",
    messageKind: (BRIEFING_MESSAGE_KINDS as Record<string, ActionDraftKind>)["treatment_acceptance"],
  };
}

// ── Build ────────────────────────────────────────────────────────────────────

/**
 * Who the card is addressed to.
 *
 * This page is dentist-only — `/dentist/business-brain` is gated by the route
 * AND by middleware — so the reader is always the dentist. Every card used to be
 * stamped "Front desk" regardless, which said, in writing, that a role which
 * cannot open the page was on top of the work. That is the contradiction this
 * map exists to remove: the chip now addresses the person actually reading it.
 *
 * The underlying ownership is not thrown away, which is the other half of the
 * fix. The Workflow Engine already decides per workflow whether the dentist or
 * the front desk should do the job (14 templates say dentist, 23 say
 * receptionist), and the view previously discarded that real judgement in favour
 * of one hard-coded string. Now it is read: "You" for the dentist's own work,
 * "Delegate" for work that belongs at the front desk and therefore has to be
 * handed over rather than merely noticed.
 *
 * Kept to one word because it renders as a small uppercase chip beside the
 * timeframe.
 */
const OWNER_LABEL: Record<WorkflowOwner, string> = {
  [WorkflowOwner.DENTIST]: "You",
  [WorkflowOwner.RECEPTIONIST]: "Delegate",
  // The clinic decides based on staffing; from the dentist's side that is still
  // theirs to place, so it reads the same as their own work.
  [WorkflowOwner.EITHER]: "You",
};

const DONE_REASON: Record<string, string> = {
  revenue_leakage: "Payments followed up",
  treatment_acceptance: "Next visits booked",
  capacity: "Schedule filled",
  scheduling: "Appointments confirmed",
  retention: "Recalls actioned",
  acquisition: "Enquiries followed up",
  forward_schedule: "Next week filled",
  patient_flow: "Waiting time addressed",
  reactivation: "Lapsed patients contacted",
  schedule_accuracy: "Booking lengths corrected",
};

/**
 * Project one pipeline run into the two-column briefing.
 *
 * `metrics` is passed alongside the result so problem summaries can name a real
 * count ("3 patients overdue") rather than a vague phrase — the same live
 * numbers the health score reads, so the two never disagree.
 */
export function buildBriefing(
  result: BusinessBrainResult,
  metrics: readonly Metric[],
  patientCounts?: Readonly<Partial<Record<string, number>>>,
  /**
   * Categories the clinic has snoozed and that are still suppressed.
   *
   * Resolved by the caller rather than here, because deciding it needs the
   * database (which dismissals are live) and the escalation rule (whether the
   * problem has since got worse) — see lib/business-brain/dismissals.ts. This
   * projection stays a pure function of the run so it remains testable without a
   * session, and so a dismissal can never reach the engines.
   *
   * The run itself is untouched: the metric, signal and diagnosis behind a
   * suppressed card are all still computed, still traced, still recorded in
   * history. Only the card is withheld.
   */
  suppressedCategories?: ReadonlySet<string>,
): BriefingView {
  const problems: ProblemView[] = [];
  const actions: ActionCardView[] = [];

  // When the engine has settled that the idle chair and the unbooked treatment
  // are one story, they are presented as one. The capacity constraint carries
  // it, because the diagnosis that licenses the merge (demand_supply_mismatch)
  // is the one that groups there — so treatment_acceptance is folded in and
  // skipped below rather than repeating half the same finding.
  const merged =
    idleChairAndUnbookedTreatmentAreOneStory(result) &&
    result.constraints.some((c) => c.category === "capacity") &&
    result.constraints.some((c) => c.category === "treatment_acceptance");

  for (const constraint of result.constraints) {
    // A snoozed category is filtered here, at the very end of the pipeline. The
    // merged card is keyed to `capacity`, so snoozing it suppresses the pair.
    if (suppressedCategories?.has(constraint.category)) continue;
    if (merged && constraint.category === "treatment_acceptance") continue;

    if (merged && constraint.category === "capacity") {
      const acceptance = result.constraints.find((c) => c.category === "treatment_acceptance")!;
      problems.push(mergedProblem(result, constraint, acceptance, metrics, patientCounts));
      actions.push(mergedAction(result, constraint, acceptance, metrics, patientCounts));
      continue;
    }

    // The capacity bottleneck, when only the window reading fired. Handled before
    // the generic path because every one of its strings differs — the today-level
    // copy would describe a day that was, in fact, fine.
    if (constraint.category === "capacity" && capacityIsMonthLevelOnly(result)) {
      problems.push(monthLevelCapacityProblem(result, constraint, metrics));
      const monthWorkflow = result.workflows.find((w) => w.constraintId === constraint.id);
      actions.push({
        id: `action-${constraint.id}`,
        problemId: constraint.id,
        category: constraint.category,
        title: "Match published chair time to the work you have",
        reason: monthLevelCapacityProblem(result, constraint, metrics).summary,
        checklist: (monthWorkflow?.tasks ?? []).map((t) => ({ id: t.id, label: t.instruction })),
        primaryActions: (PRIMARY_ACTIONS["capacity"] ?? []).map((kind) => ({
          kind,
          label: PRIMARY_ACTION_LABEL[kind],
        })),
        moreInfoLink: MORE_INFO_LINK["capacity"] ?? null,
        ownerLabel: monthWorkflow ? (OWNER_LABEL[monthWorkflow.owner] ?? "You") : "You",
        // THIS WEEK, never Today: nothing about a month-long level is fixed before
        // the first patient, and labelling it "Today" would make the urgent cards
        // beside it indistinguishable from this one.
        timeframeLabel: "This week",
        doneReason: "Chair time addressed",
      });
      continue;
    }

    const copy = COPY[constraint.category];
    const values = result.valueAtStake.get(constraint.id);
    const value = values?.[0];
    const patientCount = patientCounts?.[constraint.category];

    // Retention's headline number must name the SAME population as its summary
    // line and the "Open overdue recalls" action list — distinct patients with
    // an overdue follow-up — not the reactivation-candidate figure the Value
    // Engine uses to size and rank the constraint internally (audit A9). Sourcing
    // it here, in the view, keeps the deterministic engine and its ranking
    // untouched while making the card reconcile with the work it links to.
    let atStake: string | null;
    if (constraint.category === "retention") {
      const overdue = patientCount ?? metricValue(metrics, "followups.overdue");
      atStake = overdue !== null && overdue > 0 ? formatAtStake(overdue, "count") : null;
    } else {
      atStake = value ? formatAtStake(value.amount, value.unit) : null;
    }

    problems.push({
      id: constraint.id,
      title: copy?.title ?? constraint.name,
      severity: constraint.severity,
      category: constraint.category,
      summary: copy ? summaryFor(constraint.category, copy, metrics, patientCount) : constraint.description,
      explanation: copy?.explanation ?? "",
      atStake,
      atStakeLabel: atStake ? (copy?.atStakeLabel ?? null) : null,
      howToFix: copy?.howToFix ?? "",
      whyWeThink: copy?.whyWeThink ?? "",
      trend: trendFor(drivingDiagnosis(result, constraint)),
    });

    // The matching workflow supplies the concrete checklist steps.
    const workflow = result.workflows.find((w) => w.constraintId === constraint.id);
    const checklist: ChecklistItem[] = (workflow?.tasks ?? []).map((t) => ({
      id: t.id,
      label: t.instruction,
    }));

    const primaryActions: PrimaryAction[] = (PRIMARY_ACTIONS[constraint.category] ?? []).map((kind) => ({
      kind,
      label: PRIMARY_ACTION_LABEL[kind],
    }));

    actions.push({
      id: `action-${constraint.id}`,
      problemId: constraint.id,
      category: constraint.category,
      title: ACTION_TITLE[constraint.category] ?? copy?.title ?? constraint.name,
      reason: copy ? summaryFor(constraint.category, copy, metrics, patientCount) : constraint.description,
      checklist,
      primaryActions,
      moreInfoLink: MORE_INFO_LINK[constraint.category] ?? null,
      // Falls back to "You": with no workflow there is nothing to hand over, and
      // the dentist is the only person who can see the card anyway.
      ownerLabel: workflow ? (OWNER_LABEL[workflow.owner] ?? "You") : "You",
      timeframeLabel: constraint.severity === "critical" || constraint.severity === "high" ? "Today" : "This week",
      doneReason: DONE_REASON[constraint.category] ?? "Handled",
      messageKind: (BRIEFING_MESSAGE_KINDS as Record<string, ActionDraftKind>)[constraint.category],
    });
  }

  return attachOpportunities({ problems, actions }, result, suppressedCategories);
}

// ── Opportunities ────────────────────────────────────────────────────────────

function measure(quantities: readonly OpportunityQuantity[], label: string): OpportunityQuantity | undefined {
  return quantities.find((q) => q.label.startsWith(label));
}

const plural = (n: number, one: string, many: string) => (Math.round(n) === 1 ? one : many.replace("{n}", String(Math.round(n))));

/** Project one opportunity into plain lines. Exported for its tests. */
export function opportunityView(o: Opportunity): OpportunityView {
  const base = {
    id: o.id,
    type: o.type,
    priority: o.priority,
    expiresAt: o.window.expiresAt,
    primaryActionId: o.actionPlan.primaryActionId,
    impactLine: null as string | null,
  };

  if (o.type === "forward_capacity_match") {
    const gaps = o.surplus.measured[0]?.value ?? 0;
    const waiting = o.demand.measured[0]?.value ?? 0;
    const atLeast = o.demand.lowerBound ? "at least " : "";
    return {
      ...base,
      headline: plural(
        o.measuredValue.value,
        "Room for 1 more booking next week, from patients already waiting",
        "Room for {n} more bookings next week, from patients already waiting",
      ),
      surplusLine: plural(gaps, "1 appointment-length gap is open over the next 7 days.", "{n} appointment-length gaps are open over the next 7 days."),
      demandLine: `${atLeast}${plural(waiting, "1 patient with planned treatment or an overdue recall has nothing booked.", "{n} patients with planned treatment or an overdue recall have nothing booked.")}`,
      impactLine: o.impact
        ? `${rupees(o.impact.amount.value)} of treatment is already planned for them — quoted, not yet accepted.`
        : null,
    };
  }

  if (o.type === "freed_slot_refill") {
    const minutes = o.surplus.measured[0]?.value ?? 0;
    const candidates = o.demand.measured[0]?.value ?? 0;
    return {
      ...base,
      headline: "A cancelled slot is still open",
      surplusLine: `A ${formatAtStake(minutes, "minutes")} slot was cancelled and nobody has taken it.`,
      demandLine: plural(candidates, "1 patient waiting for a booking could be offered it.", "{n} patients waiting for a booking could be offered it."),
    };
  }

  const owed = o.measuredValue.value;
  const charged = o.surplus.measured[0]?.value ?? 0;
  const patients = measure(o.demand.measured, "patients owing")?.value ?? 0;
  const aged = measure(o.demand.measured, "owed by patients whose latest")?.value ?? 0;
  return {
    ...base,
    headline: `${rupees(owed)} is owed for work already done`,
    surplusLine: `${rupees(charged)} was charged for the delivered work behind it.`,
    demandLine:
      aged > 0
        ? `${plural(patients, "1 patient still owes it", "{n} patients still owe it")}; ${rupees(aged)} is for work a month old or more.`
        : `${plural(patients, "1 patient still owes it", "{n} patients still owe it")}.`,
    impactLine: "Charges less payments on record — not a prediction of what will be collected.",
  };
}

/**
 * Put each opportunity on the card for the finding about the same resource.
 *
 * Matched by constraint first, then by related category, so a merged card (which
 * carries the capacity constraint) still receives an opportunity linked to the
 * treatment-acceptance half folded into it. An opportunity whose finding the
 * clinic has snoozed is withheld with it — a snooze would mean nothing if the same
 * finding came back through a side door.
 */
function attachOpportunities(
  view: BriefingView,
  result: BusinessBrainResult,
  suppressedCategories?: ReadonlySet<string>,
): BriefingView {
  const opportunities = result.opportunities ?? [];
  if (opportunities.length === 0) return view;

  const constraintCategory = new Map(result.constraints.map((c) => [c.id, c.category as string]));
  const attached = new Map<string, OpportunityView[]>();
  const unattached: OpportunityView[] = [];

  for (const opportunity of opportunities) {
    const linkedCategory = opportunity.constraintId ? constraintCategory.get(opportunity.constraintId) : undefined;
    if (linkedCategory !== undefined && suppressedCategories?.has(linkedCategory)) continue;

    const related = new Set<string>(opportunity.relatedCategories);
    const card =
      view.actions.find((a) => a.problemId === opportunity.constraintId) ??
      view.actions.find((a) => related.has(a.category) || related.has(constraintCategory.get(a.problemId) ?? ""));
    const projected = opportunityView(opportunity);
    if (card === undefined) {
      unattached.push(projected);
      continue;
    }
    attached.set(card.id, [...(attached.get(card.id) ?? []), projected]);
  }

  return {
    problems: view.problems,
    actions: view.actions.map((a) => (attached.has(a.id) ? { ...a, opportunities: attached.get(a.id) } : a)),
    ...(unattached.length > 0 ? { unattachedOpportunities: unattached } : {}),
  };
}
