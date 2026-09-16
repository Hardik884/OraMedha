/**
 * Business Brain — Strategy Engine
 *
 * The first component in the pipeline permitted to say what to do.
 *
 * Everything upstream is held to silence on that point, by an executable test:
 * `no-advice.spec.ts` scans every string the Metrics, Signal and Diagnosis
 * engines can emit against nine advisory patterns and asserts zero matches. That
 * boundary was never squeamishness — it was so that when advice finally appears,
 * it appears in exactly one place, with its reasoning attached and its licence
 * to speak clearly bounded.
 *
 * ## The rule that keeps this honest
 *
 * A strategy may only propose ACTING on something the engine actually settled.
 *
 * The Diagnosis Engine leaves a hypothesis `undetermined` when it could not tell
 * which of several explanations fits. Advising a fix for an undetermined cause
 * is guessing dressed as analysis — and worse, it is confident guessing, because
 * it arrives in the same voice as the findings that were genuinely established.
 *
 * So the engine emits two kinds of strategy, and never confuses them:
 *
 *   corrective   the diagnosis settled a cause; act on that cause
 *   investigative the diagnosis could not settle it; the proposal is to obtain
 *                the missing measurement, and the discriminator already names
 *                exactly which one
 *
 * An investigative strategy is not a lesser output. "We know the schedule is
 * leaking and we cannot yet tell why; here is the measurement that would tell
 * us" is a genuinely useful thing to be told, and it is the truth.
 *
 * ## Still deterministic
 *
 * No model, no clock, no I/O. Same constraints and diagnoses produce the same
 * strategies, byte for byte. An LLM belongs downstream of this, rephrasing a
 * finished strategy — the same arrangement the AI explanation layer already has
 * with diagnoses.
 */

import {
  ConstraintCategory,
  type Constraint,
  type Diagnosis,
  type Hypothesis,
  type Strategy,
  type Value,
  ValueType,
} from "../../domain";
import { compareValueAtStake } from "../value";
import { Priority, Severity } from "../../types";

/** How a strategy earns its place. */
export const StrategyKind = {
  /** Acts on a cause the engine established. */
  CORRECTIVE: "corrective",
  /** Obtains a measurement the engine could not take. */
  INVESTIGATIVE: "investigative",
} as const;

export type StrategyKind = (typeof StrategyKind)[keyof typeof StrategyKind];

/**
 * A strategy, with the reasoning that licensed it.
 *
 * Extends the domain `Strategy` rather than replacing it: the extra fields are
 * what make the recommendation auditable, and a caller that only wants the
 * domain shape can ignore them.
 */
export interface ReasonedStrategy extends Strategy {
  readonly kind: StrategyKind;
  /** Hypothesis ids this acts on — empty for an investigative strategy. */
  readonly basedOn: readonly string[];
  /** Diagnosis ids behind it, so a reader can trace back to the evidence. */
  readonly diagnosisIds: readonly string[];
  /**
   * Why this was proposed, stated as the finding rather than the remedy. Lets a
   * dentist judge the recommendation instead of taking it on trust.
   */
  readonly rationale: string;
}

const SEVERITY_TO_PRIORITY: Readonly<Record<string, Priority>> = {
  [Severity.CRITICAL]: Priority.CRITICAL,
  [Severity.HIGH]: Priority.HIGH,
  [Severity.MEDIUM]: Priority.MEDIUM,
  [Severity.LOW]: Priority.LOW,
  [Severity.INFO]: Priority.LOW,
};

const PRIORITY_RANK: Readonly<Record<string, number>> = {
  [Priority.CRITICAL]: 3,
  [Priority.HIGH]: 2,
  [Priority.MEDIUM]: 1,
  [Priority.LOW]: 0,
};

/**
 * What to do about a settled cause.
 *
 * Keyed by hypothesis slug — the same slugs the matchers declare — so a
 * recommendation is bound to the specific explanation the engine established,
 * not to the pattern in general. A pattern can be reached by several routes, and
 * "the schedule is leaking" warrants different responses depending on whether
 * patients cancelled early or did not turn up at all.
 *
 * ## Completeness is enforced, not aspirational
 *
 * Every hypothesis slug the Diagnosis Engine can emit is accounted for exactly
 * once: either here, with a corrective strategy, or in `CAUSES_WITHOUT_STRATEGY`
 * below, with a written reason it deserves none. `strategy-coverage.spec.ts`
 * enumerates the slugs the matchers actually produce and fails if any slug is
 * missing from both tables, or if a template here names a slug no matcher emits.
 * That is what keeps this playbook from drifting behind the Diagnosis Engine.
 *
 * A slug absent from BOTH tables would produce no corrective strategy — silence
 * rather than generic advice — but the coverage test exists so that silence is
 * always a deliberate, documented choice and never an oversight.
 */
const CORRECTIVE_BY_HYPOTHESIS: Readonly<
  Record<string, { title: string; description: string }>
> = {
  // ── Scheduling: schedule_attrition ────────────────────────────────────────
  cancellation_dominant: {
    title: "Recover the slots that are released early",
    description:
      "Lost appointments were predominantly cancellations made with enough notice to refill the slot. Keep a short standby list of patients waiting for an earlier date and call them the moment a cancellation comes in, so the released time is rebooked rather than lost.",
  },
  no_show_dominant: {
    title: "Confirm attendance the day before",
    description:
      "Lost appointments were predominantly no-shows, where the slot was held until the appointment time and then went unused. Call or message each patient the day before to confirm; a no-show turned into an early cancellation is a slot you can still refill.",
  },
  slot_clustering: {
    title: "Fix the specific slots and treatments that keep emptying",
    description:
      "Cancellations and no-shows concentrate in particular times of day or treatment types rather than falling evenly. Review those specific slots and treatments, and change how they are booked — a deposit, a shorter lead time, a confirmation call — or stop offering the worst-performing ones.",
  },
  patient_level_pattern: {
    title: "Handle the repeat non-attenders differently",
    description:
      "Non-attendance is concentrated among patients who have missed before, rather than spread across the patient base. Book that small group into same-week slots, ask for a deposit, or call to confirm personally, without changing anything for everyone else.",
  },
  reminder_process: {
    title: "Make sure every patient gets a reminder before their visit",
    description:
      "The lost appointments are spread across patients and slots rather than concentrated, the pattern that shows when reminders are not reaching people. Put a day-before reminder call or message on every booking and tick each one off, so no appointment goes unconfirmed.",
  },

  // ── Scheduling: forward_schedule_gap ──────────────────────────────────────
  forward_schedule_gap: {
    title: "Fill next week from the patients already waiting on you",
    description:
      "The coming week is booked below normal while there is still time to change it. Work two lists into the open slots before they pass: patients with planned treatment and no next visit, and patients whose recall is overdue. Both have already chosen this clinic, so they are the cheapest appointments available to fill a thin week with.",
  },

  // ── Financial: collection_gap ─────────────────────────────────────────────
  systemic_process: {
    title: "Collect at checkout, every time",
    description:
      "The collection gap has repeated across consecutive days, so it is the routine rather than a one-off lag. Take payment — or formally record the balance and a payment date — before the patient leaves the chair, and make it a fixed step in checkout.",
  },
  patient_balances: {
    title: "Chase the balances that have been unpaid longest",
    description:
      "The unpaid book is weighted toward balances outstanding for weeks, not toward today's billing. Send statements and call those specific patients to arrange payment or a plan, starting with the largest and oldest.",
  },

  // ── Financial: revenue_shortfall ──────────────────────────────────────────
  volume: {
    title: "Fill the schedule — the day was quiet, not underpriced",
    description:
      "Revenue was low because fewer appointments happened and less treatment was delivered, not because work went uncollected. Put the effort into booking patients — work the recall list and the waiting treatment plans — rather than into billing.",
  },
  yield: {
    title: "Collect for the work you delivered today",
    description:
      "The day's appointment and treatment volume was normal, but the money did not come in. Check that every completed treatment was charged and paid for, or its balance formally recorded, before the patient left.",
  },
  case_mix: {
    title: "Check that patients are being offered the treatment they need",
    description:
      "Revenue was lower because the work completed was lower-value, not because it went unpaid. Review whether patients who need larger treatment are being presented complete plans rather than only the immediate fix.",
  },

  // ── Operational: capacity_ceiling ─────────────────────────────────────────
  demand_exceeds_capacity: {
    title: "Add chair time on the days you are turning full",
    description:
      "Demand met the clinic's ceiling while patients were still queueing, so the limit is chair time rather than interest. Consider an extra session, a longer day, or protecting your highest-value slots on the busiest days.",
  },
  schedule_overbooking: {
    title: "Book realistic lengths for the treatments that overrun",
    description:
      "The schedule looks full because appointments are booked shorter than they actually take, so a full day turns into a queue. Lengthen the booked time for the treatment types that consistently run over.",
  },

  // ── Operational: throughput_congestion ────────────────────────────────────
  capacity_bound: {
    title: "Relieve your busiest sessions",
    description:
      "Patients waited because the chair was full through the day, not because of how the day was arranged. The lever is capacity — an added session, or fewer appointments packed into the peak sessions.",
  },
  flow_bound: {
    title: "Spread the day's bookings so patients aren't stacked",
    description:
      "Patients waited while chairs sat empty, so the queue comes from how the day is arranged rather than from a lack of capacity. Even out appointment spacing and stagger arrival times so people are not all booked into the same part of the day.",
  },
  service_time_variance: {
    title: "Book the time appointments actually take",
    description:
      "Appointments are consistently running past their booked length, so the queue builds from durations that are too short on paper rather than from patients arriving together. Lengthen the booked slots for the treatments that overrun.",
  },
  arrival_punctuality: {
    title: "Spread arrivals across the session",
    description:
      "Patients are arriving together rather than across the session, and the queue forms from arrival timing rather than from appointments overrunning. Stagger appointment times and set clear arrival windows so patients do not all turn up at once.",
  },

  // ── Retention: patient_base_erosion ───────────────────────────────────────
  acquisition_driven: {
    title: "Rebuild new-patient flow",
    description:
      "First-time registrations fell below the daily minimum. The lever is new-patient supply — ask satisfied patients for referrals, keep your Google and maps listing current and reviewed, and follow up enquiries that never became bookings.",
  },
  retention_driven: {
    title: "Bring existing patients back on recall",
    description:
      "Returning-patient volume fell against the prior period. Work the recall list — call patients who are due or overdue for a check-up and book them a visit before they lapse.",
  },

  // ── Retention: recall_process_failure ─────────────────────────────────────
  recall_execution: {
    title: "Work the overdue recall list this week",
    description:
      "Returning visits dropped while new-patient numbers held steady and the recall list is overdue, so the gap is in bringing existing patients back rather than in demand. Set aside time to call every overdue recall and book them in.",
  },

  // ── Clinical: pipeline_conversion_failure ─────────────────────────────────
  no_available_capacity: {
    title: "Open chair time to place the treatment that is waiting",
    description:
      "Patients have planned treatment and no next visit because the book was full when they were ready. Open additional slots — a session or extended hours — and place the waiting plans into them.",
  },
  booking_follow_through: {
    title: "Book the next visit before the patient leaves",
    description:
      "Chairs were free, yet patients with planned treatment left without a date. Make booking the next appointment part of checkout, so no plan walks out of the clinic unscheduled.",
  },
  patient_deferral: {
    title: "Follow up the plans that have been sitting for weeks",
    description:
      "A large share of planned treatment has been waiting well beyond a normal booking gap, so these patients deferred rather than declined. Call them, re-present the plan, and book the visit.",
  },
  cost_barrier: {
    title: "Offer a payment option for the high-value plans that are stuck",
    description:
      "The unbooked backlog is concentrated in expensive treatments, which points to cost as the barrier. Offer staged payment or phased treatment so patients can start rather than keep deferring.",
  },

  // ── Operational: demand_supply_mismatch ───────────────────────────────────
  unconverted_demand: {
    title: "Book the patients who have a plan and no next visit",
    description:
      "Planned treatment is sitting with patients who have nothing in the book, while chair time went unused on the same day. The work and the capacity both exist; call those patients and put them into the open slots.",
  },
  insufficient_demand: {
    title: "Bring patients back before filling new capacity",
    description:
      "Chair time went unused and the planned-treatment pipeline is thin, so the shortfall is in patients to see rather than in time to see them. Work the recall and reactivation lists before adding more open slots.",
  },
  capacity_not_offered: {
    title: "Open chair time before treating the day as quiet",
    description:
      "No bookable chair time was published for this day, so an empty schedule reflects what was offered rather than what patients wanted. Publish availability and open slots patients can actually book into.",
  },

  // ── Standalone single-signal readings ─────────────────────────────────────
  // Acquisition: acquisition_shortfall
  acquisition_shortfall: {
    title: "Rebuild new-patient flow",
    description:
      "First-time registrations fell below the clinic's normal while returning patients held. Ask satisfied patients for referrals, keep the online listing and map profile current, and follow up enquiries that never turned into a booking.",
  },
  // Revenue leakage: balance_owed
  balance_owed: {
    title: "Chase the outstanding balances, oldest first",
    description:
      "Unpaid patient balances have built past the acceptable ceiling for money owed on delivered work. Send statements and call those patients to arrange payment or a plan, starting with the largest and oldest.",
  },
  // Reactivation: dormant_patient_base
  dormant_patient_base: {
    title: "Call the patients who have quietly stopped coming",
    description:
      "A large group of patients has been seen before, has not been back within a recall interval, and has nothing booked — and none of them is on the overdue recall list, because no follow-up was ever raised for them. Work the inactive-patient list by longest absence: these people already chose this clinic once, which makes them the cheapest appointments available to fill.",
  },
  // Schedule accuracy: chronic_appointment_overrun
  chronic_appointment_overrun: {
    title: "Book the time appointments actually take",
    description:
      "Across the last month, appointments took materially longer than the time booked for them, and nobody queued today — so the difference is being absorbed by running late rather than showing up as a backlog. Review the slot lengths you book for the treatments that routinely overrun and lengthen them, so a full day on paper is a day the clinic can actually deliver.",
  },
  // Revenue leakage: production_collection_gap
  sustained_under_collection: {
    title: "Check that every completed treatment is being charged and settled",
    description:
      "Over the last month the clinic collected materially less than it delivered, and no single day breached the same-day collection check — so the shortfall is spread thinly rather than concentrated in one bad afternoon, which is why it has not been visible. Reconcile the month's completed treatments against payments and balances, and find the ones with neither.",
  },
  // Capacity: sustained_idle_capacity
  sustained_idle_capacity: {
    title: "Match the chair time you publish to the work you have",
    description:
      "Chair time has been going unused across the whole month rather than on one quiet day, so this is the shape of the week rather than bad luck. Either fill it — recall list, reactivation list, patients with planned treatment and no next visit — or reduce the hours you publish so the capacity you offer matches the demand you have.",
  },
  // Retention: recall_backlog
  recall_backlog: {
    title: "Work the overdue recall backlog this week",
    description:
      "The overdue recall list is above its limit while returning volume held. Set aside time to call every overdue recall and book them in before those patients lapse.",
  },
};

/**
 * The hypothesis slugs that have a corrective strategy, exported so the coverage
 * test can compare them against what the matchers actually emit.
 */
export const STRATEGISED_CAUSES: ReadonlySet<string> = new Set(
  Object.keys(CORRECTIVE_BY_HYPOTHESIS),
);

/**
 * Hypothesis slugs the engine can emit that deliberately carry no corrective
 * strategy, each with the reason. Two kinds live here, and the distinction
 * matters to a reader:
 *
 *   - "benign"  the engine CAN settle it, but the settled finding is that no
 *               action is warranted. Inventing a fix would contradict the
 *               diagnosis, not support it.
 *   - "unsettleable"  the engine can NEVER settle it — the discriminators that
 *               would are data OraMedha does not hold — so it is always
 *               undetermined and handled by the investigative fallback instead.
 *
 * This is the other half of the coverage contract: the test treats a slug here
 * as fully accounted for, so anything NOT here and NOT in
 * `CORRECTIVE_BY_HYPOTHESIS` is an unhandled cause and fails the build.
 */
export const CAUSES_WITHOUT_STRATEGY: Readonly<
  Record<string, { kind: "benign" | "unsettleable"; reason: string }>
> = {
  billing_lag: {
    kind: "benign",
    reason:
      "Settled only when the collection gap appeared on a single day and cleared. The finding is a same-day billing lag — the money arrived late, not never — which is why the matcher separates it from systemic_process. A 'collect faster' action would contradict the diagnosis; monitoring is the correct response.",
  },
  capacity_suppresses_acquisition: {
    kind: "unsettleable",
    reason:
      "Never reaches supported. Whether a full schedule is turning enquiries away needs booking-channel and enquiry data OraMedha does not record (booking_channel_activity, patient_acquisition_source), so it stays undetermined and the investigative fallback names those measurements.",
  },
  external_demand: {
    kind: "unsettleable",
    reason:
      "Never reaches supported. Whether demand across the catchment moved needs a baseline outside the clinic's own records (catchment_demand_baseline), which by definition it does not hold.",
  },
  contact_reachability: {
    kind: "unsettleable",
    reason:
      "Never reaches supported. Separating recalls never attempted from recalls that did not reach the patient needs a contact-attempt log (recall_contact_attempts); the port returns null because OraMedha records none.",
  },
  patient_choice: {
    kind: "unsettleable",
    reason:
      "Never reaches supported. Whether reached patients chose not to return needs post-visit feedback (post_visit_feedback), which OraMedha does not capture.",
  },
  unbilled_delivery: {
    kind: "unsettleable",
    reason:
      "Never reaches supported, and no discriminator can settle it. Work that was never charged produces no balance row, so it is invisible to invoice ageing — the one entity measurement that looks like it would separate the two. Settling it needs a reconciliation of completed treatments against charges raised, which is exactly what the supported sustained_under_collection strategy asks a person to do, because no query performs it.",
  },
  awaiting_payment: {
    kind: "unsettleable",
    reason:
      "The mirror of unbilled_delivery, and unsettleable for the same reason. Kept as an explicit hypothesis rather than dropped, because the benign reading of a collection shortfall — money that will arrive — deserves to be named alongside the alarming one rather than quietly left out of consideration.",
  },
  measured_condition: {
    kind: "unsettleable",
    reason:
      "The unclustered_signal safety net's only hypothesis, always undetermined by design: a single signal with no correlating signal cannot imply a cause. The investigative fallback names the longer-history measurement that would.",
  },
};

/** A constraint with no settled cause still deserves a stated direction. */
const INVESTIGATIVE_BY_CATEGORY: Readonly<Record<ConstraintCategory, string>> = {
  [ConstraintCategory.CAPACITY]: "why chair time is going unused",
  [ConstraintCategory.SCHEDULING]: "why booked appointments are being lost",
  [ConstraintCategory.REVENUE_LEAKAGE]: "why delivered work is not turning into money",
  [ConstraintCategory.TREATMENT_ACCEPTANCE]:
    "why patients with planned treatment are leaving without a next visit booked",
  [ConstraintCategory.RETENTION]: "why patients are not coming back",
  [ConstraintCategory.ACQUISITION]: "why fewer new patients are arriving",
  [ConstraintCategory.FORWARD_SCHEDULE]: "why the coming week is filling more slowly than usual",
  [ConstraintCategory.PATIENT_FLOW]: "why patients are waiting after they arrive",
  [ConstraintCategory.REACTIVATION]: "why patients who were seen before have stopped coming back",
  [ConstraintCategory.SCHEDULE_ACCURACY]:
    "why appointments are taking longer than the time booked for them",
};

/**
 * The kind of value acting on each bottleneck would produce.
 *
 * A category, not a promise. Acquisition is absent for the same reason it has no
 * measurable size: nothing records the patients who did not arrive.
 */
const VALUE_TYPES_BY_CATEGORY: Readonly<Record<ConstraintCategory, readonly ValueType[]>> = {
  [ConstraintCategory.REVENUE_LEAKAGE]: [ValueType.REVENUE_RECOVERED],
  [ConstraintCategory.TREATMENT_ACCEPTANCE]: [
    ValueType.REVENUE_RECOVERED,
    ValueType.APPOINTMENTS_BOOKED,
  ],
  [ConstraintCategory.CAPACITY]: [ValueType.APPOINTMENTS_BOOKED, ValueType.HOURS_SAVED],
  [ConstraintCategory.SCHEDULING]: [ValueType.APPOINTMENTS_BOOKED],
  [ConstraintCategory.RETENTION]: [ValueType.RETENTION_IMPROVED],
  [ConstraintCategory.ACQUISITION]: [ValueType.OTHER],
  [ConstraintCategory.FORWARD_SCHEDULE]: [ValueType.APPOINTMENTS_BOOKED],
  // Time given back to patients, which is what a shorter wait is.
  [ConstraintCategory.PATIENT_FLOW]: [ValueType.HOURS_SAVED],
  [ConstraintCategory.REACTIVATION]: [
    ValueType.RETENTION_IMPROVED,
    ValueType.APPOINTMENTS_BOOKED,
  ],
  // Booking realistic lengths does not create appointments; it makes the day the
  // clinic publishes match the day it delivers, which is time rather than volume.
  [ConstraintCategory.SCHEDULE_ACCURACY]: [ValueType.HOURS_SAVED],
};

/** Hypothesis slug from its `<diagnosisId>#h.<slug>` id. */
function slugOf(hypothesis: Hypothesis): string {
  const at = hypothesis.id.lastIndexOf("#h.");
  return at === -1 ? hypothesis.id : hypothesis.id.slice(at + 3);
}

export interface StrategyResult {
  readonly strategies: readonly ReasonedStrategy[];
}

/**
 * Propose strategies for the clinic's constraints.
 *
 * At most one corrective strategy per settled cause, and at most one
 * investigative strategy per constraint. The cap matters: a list long enough to
 * need triage is a list nobody acts on, and a constraint that produced four
 * plausible suggestions has told the dentist less than one that produced a
 * single grounded one.
 */
export function proposeStrategies(
  constraints: readonly Constraint[],
  diagnoses: readonly Diagnosis[],
  clinicId: string,
  date: string,
  now: string,
  /**
   * What is measurably at stake per constraint, used only to order strategies
   * of EQUAL priority. Optional: without it the ordering falls back to the
   * stable id comparison, so a caller that cannot size its constraints gets the
   * same strategies in a slightly less useful order rather than none.
   */
  valueByConstraint?: ReadonlyMap<string, readonly Value[]>,
): StrategyResult {
  const byId = new Map(diagnoses.map((d) => [d.id, d]));
  const strategies: ReasonedStrategy[] = [];

  for (const constraint of constraints) {
    const related = (constraint.relatedDiagnosisIds ?? [])
      .map((id) => byId.get(id))
      .filter((d): d is Diagnosis => d !== undefined);

    const priority = SEVERITY_TO_PRIORITY[constraint.severity] ?? Priority.LOW;

    // ── Corrective: one per settled cause ────────────────────────────────────
    // Deduplicated by slug, because the same cause can be established by more
    // than one diagnosis and a clinic should be told it once.
    const settled = new Map<string, { hypothesis: Hypothesis; diagnosisIds: string[] }>();
    for (const diagnosis of related) {
      for (const hypothesis of diagnosis.hypotheses) {
        if (hypothesis.status !== "supported") continue;
        const slug = slugOf(hypothesis);
        const existing = settled.get(slug);
        if (existing === undefined) {
          settled.set(slug, { hypothesis, diagnosisIds: [diagnosis.id] });
        } else {
          existing.diagnosisIds.push(diagnosis.id);
        }
      }
    }

    for (const slug of [...settled.keys()].sort()) {
      const template = CORRECTIVE_BY_HYPOTHESIS[slug];
      // An unrecognised cause yields nothing rather than something generic.
      if (template === undefined) continue;
      const entry = settled.get(slug);
      if (entry === undefined) continue;

      strategies.push({
        id: `strategy.${constraint.category}.${slug}:${clinicId}:${date}`,
        title: template.title,
        description: template.description,
        constraintId: constraint.id,
        priority,
        kind: StrategyKind.CORRECTIVE,
        basedOn: [entry.hypothesis.id],
        diagnosisIds: [...entry.diagnosisIds].sort(),
        rationale: entry.hypothesis.statement,
        // The KIND of value acting here would produce — a category, never an
        // amount. Promising a figure would require knowing how effective the
        // action is, which nothing measures.
        expectedValueTypes: VALUE_TYPES_BY_CATEGORY[constraint.category],
        createdAt: now,
      });
    }

    // ── Investigative: only when nothing was settled ─────────────────────────
    // Withheld once a cause is established, so a clinic that has an answer is
    // not simultaneously told to go looking for one.
    const hasCorrective = strategies.some((s) => s.constraintId === constraint.id);
    if (hasCorrective) continue;

    // The discriminators already name the measurements that would settle this,
    // so the proposal can be specific rather than "look into it".
    // First sentence only. The catalogue's descriptions are a developer
    // deliverable and continue into implementation notes — schema caveats, port
    // method names — which are exactly right in the catalogue and unreadable on
    // a dentist's dashboard. The opening sentence is the measurement itself.
    const wanted = related
      .flatMap((d) => d.discriminators)
      .filter((d) => d.availability !== "available")
      .map((d) => {
        const stop = d.description.indexOf(". ");
        return stop === -1 ? d.description : d.description.slice(0, stop + 1);
      });
    const subject = INVESTIGATIVE_BY_CATEGORY[constraint.category];

    strategies.push({
      id: `strategy.${constraint.category}.investigate:${clinicId}:${date}`,
      title: `Establish ${subject}`,
      description:
        wanted.length === 0
          ? `The findings behind this did not settle a cause, so acting on one would be guesswork. What would separate the possibilities has not been identified either.`
          : `The findings behind this did not settle a cause, so acting on one would be guesswork. ${
              wanted.length === 1
                ? "One measurement would settle it"
                : `${wanted.length} measurements would settle it, starting with this one`
            }: ${wanted[0]}`,
      constraintId: constraint.id,
      // Deliberately capped below the constraint's own priority: knowing that
      // something is unexplained is less urgent than acting on something
      // understood, however severe the symptom.
      priority: priority === Priority.CRITICAL ? Priority.HIGH : priority,
      kind: StrategyKind.INVESTIGATIVE,
      basedOn: [],
      diagnosisIds: related.map((d) => d.id).sort(),
      rationale: `No hypothesis behind this constraint reached a supported status.`,
      createdAt: now,
    });
  }

  // Corrective before investigative at equal priority: a clinic that can act on
  // one thing and must investigate another should be shown the action first.
  strategies.sort((a, b) => {
    const byPriority = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
    if (byPriority !== 0) return byPriority;
    if (a.kind !== b.kind) return a.kind === StrategyKind.CORRECTIVE ? -1 : 1;
    // Size only breaks ties inside a priority band, never across one. Severity
    // is how urgent, value is how big; letting a large slow problem outrank a
    // small urgent one would invent an exchange rate between money and risk that
    // nobody chose.
    const byStake = compareValueAtStake(
      valueByConstraint?.get(a.constraintId),
      valueByConstraint?.get(b.constraintId),
    );
    if (byStake !== 0) return byStake;
    return a.id.localeCompare(b.id);
  });

  return { strategies };
}
