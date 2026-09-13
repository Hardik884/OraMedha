/**
 * Business Brain — Repositories: Data Snapshots
 *
 * The Business Brain's own read-only view of the clinic data the Metrics
 * Engine needs. These are deliberately NOT DentGrow database rows — they are
 * a narrow, stable shape the engine depends on, so the engine never couples to
 * the database schema.
 *
 * A future phase provides a Supabase-backed implementation that maps DentGrow
 * rows into these snapshots. This phase only defines the shape and consumes it.
 */

/** An appointment scheduled on the target date. */
export interface AppointmentSnapshot {
  readonly id: string;
  readonly patientId: string;
  /** DentGrow appointment_status: scheduled | checked_in | in_progress | completed | cancelled | no_show. */
  readonly status: string;
  /** ISO-8601 time the appointment is scheduled for. */
  readonly scheduledAt: string;
  /**
   * ISO-8601 time the appointment record was created — i.e. when it was booked.
   * Together with `scheduledAt` this gives booking lead time, the clearest read
   * on whether demand is ahead of or behind capacity.
   */
  readonly createdAt: string;
  /** Planned duration in minutes. */
  readonly durationMinutes: number;
  /** DentGrow appointment_source. */
  readonly source: string;
}

/** A patient record, reduced to what metrics need. */
export interface PatientSnapshot {
  readonly id: string;
  /** ISO-8601 timestamp the patient record was created. */
  readonly createdAt: string;
}

/** A recorded payment. */
export interface PaymentSnapshot {
  readonly id: string;
  readonly amount: number;
  /** Calendar date the payment was recorded, "YYYY-MM-DD". */
  readonly paymentDate: string;
  /**
   * The patient this payment belongs to. Enables per-patient balance clamping so
   * a deposit on one patient's planned work cannot net against another patient's
   * billable debt. Optional so hand-built test snapshots stay valid; when absent,
   * all rows fall into one bucket (the old clinic-level behaviour).
   */
  readonly patientId?: string;
}

/** A treatment record, reduced to what metrics need. */
export interface TreatmentSnapshot {
  readonly id: string;
  /** The patient this treatment belongs to (see PaymentSnapshot.patientId). */
  readonly patientId?: string;
  /**
   * GROSS treatment amount — what the patient owes. Patient billing never uses
   * the consultant split (see `lib/billing/revenue.ts`).
   */
  readonly cost: number;
  /**
   * Consultation (OPD) and radiograph (X-ray) charges recorded against this
   * visit. Owed whenever the consultation / X-ray happened, independent of the
   * treatment's status — so the outstanding metric reconciles with the canonical
   * per-patient billing in `lib/billing/balance.ts`. Optional so hand-built test
   * snapshots (and any repository written before these were added) stay valid;
   * when absent, no OPD/X-ray charge is applied, matching the pre-OPD behaviour.
   */
  readonly opdCharged?: boolean;
  readonly opdFee?: number;
  readonly xrayTaken?: boolean;
  readonly xrayCost?: number;
  /** DentGrow treatment_status: planned | in_progress | completed | cancelled. */
  readonly status: string;
  /** ISO-8601 time the treatment was performed, or null if not yet performed. */
  readonly performedAt: string | null;
  /**
   * Whether follow-through on this treatment has been booked.
   *
   *   true   the patient has at least one upcoming visit
   *   false  the patient has no upcoming visit
   *   null   NOT DETERMINABLE from the available data
   *
   * Deliberately defined at the PATIENT level, not per treatment. A repository
   * answers "does this treatment's patient have another visit booked?", which
   * is an approximation of "is this specific treatment booked". Modelling the
   * latter exactly requires a link from planned work to the visit booked to
   * deliver it, and the workflow cost of asking a dentist to maintain one is not
   * currently justified.
   *
   * Do not mistake `treatments.appointment_id` for that link. It is NOT NULL, but
   * it records the visit the treatment was WRITTEN DOWN at — for planned work,
   * the past consultation that planned it. The clinic ledger names it
   * `recordedAtAppointmentId` for exactly this reason.
   *
   * The direction of the error is known and one-way: the derived metric
   * UNDER-reports. Anything it flags as pending scheduling is genuinely
   * unbooked; some genuinely unbooked work is missed because the patient
   * happens to have an unrelated appointment.
   *
   * `null` remains a first-class value for any repository that cannot determine
   * booking state at all. The Metrics Engine then withholds the dependent
   * metric rather than reporting a measured zero — the same discipline the
   * Signal and Diagnosis engines apply to absent input.
   */
  readonly isScheduled: boolean | null;
}

/** A queue entry for the target date. */
export interface QueueEntrySnapshot {
  readonly id: string;
  /** DentGrow queue_status: waiting | in_progress | completed. */
  readonly status: string;
  /** ISO-8601 time the patient checked in (started waiting). */
  readonly checkedInAt: string;
  /** ISO-8601 time the patient was called in (waiting ended), or null if still waiting. */
  readonly startedAt: string | null;
}

/** A follow-up record relevant to the target date. */
export interface FollowUpSnapshot {
  readonly id: string;
  /** Due date, "YYYY-MM-DD". */
  readonly dueDate: string;
  /** DentGrow follow_up_status: pending | completed | cancelled. */
  readonly status: string;
}

/**
 * One patient on the clinic's roster, with the two facts retention metrics need.
 *
 * This is the whole active roster rather than a filtered subset: deciding who
 * counts as lapsed is a business rule and belongs in a calculator, not in the
 * repository's query.
 */
export interface PatientRosterEntry {
  readonly id: string;
  /** ISO-8601 timestamp the patient record was created. */
  readonly createdAt: string;
  /** ISO-8601 timestamp of the most recent completed visit, or null if never seen. */
  readonly lastVisit: string | null;
  /** Whether the patient has at least one upcoming, non-cancelled appointment. */
  readonly hasUpcomingAppointment: boolean;
}

/**
 * One attended visit, with the time it was BOOKED for beside the time it
 * actually took.
 *
 * The two numbers come from different ledgers on purpose, and that is the whole
 * value of the shape: `scheduledMinutes` is the plan a clinic wrote into the
 * appointment book, `actualMinutes` is what the queue recorded when staff called
 * the patient in and marked them finished. Neither ledger alone can say whether
 * a clinic books realistically.
 *
 * `actualMinutes` is `null` when either end of the interval was not recorded.
 * Never inferred from anything else — a guessed duration would fabricate exactly
 * the quantity this exists to measure, and the calculator drops such rows rather
 * than treating an unrecorded visit as an on-time one.
 */
export interface VisitDurationSnapshot {
  readonly appointmentId: string;
  /** Minutes the appointment was booked for, as planned. */
  readonly scheduledMinutes: number;
  /** Minutes it actually took, called-in to finished; null when unrecorded. */
  readonly actualMinutes: number | null;
}

/**
 * A date range of schedule activity, with the capacity offered across it.
 *
 * Appointments and capacity travel together because every metric that uses a
 * window needs both: a fill rate is meaningless without the denominator, and
 * two separately-supplied ranges could silently disagree about their bounds.
 *
 * Both ends are inclusive "YYYY-MM-DD" business dates.
 */
export interface ScheduleWindow {
  readonly from: string;
  readonly to: string;
  /** Appointments whose `scheduledAt` falls inside the range. */
  readonly appointments: readonly AppointmentSnapshot[];
  /**
   * Chair-minutes the clinic is open across the whole range: the sum of each
   * day's open minutes multiplied by its chair count.
   */
  readonly openChairMinutes: number;
}

/**
 * Clinic capacity for the target date, expressed in TIME rather than slot count.
 *
 * `availability_rules.slot_duration_minutes` is a step size for generating
 * candidate start times, not a unit of capacity: at 10-minute steps a four-hour
 * window yields 24 overlapping candidates, and you cannot book 24 half-hour
 * appointments in four hours. Counting candidates inflates capacity by the ratio
 * of appointment length to step size, and the distortion changes with the step —
 * so the same clinic would read differently on different weekdays.
 *
 * Minutes have none of those problems and are exact at any granularity.
 */
export interface CapacitySnapshot {
  /**
   * Minutes the clinic is open on the target date: the union of its active
   * availability rules, less consultancy blocks, zero on a closed day.
   * Per chair — multiply by {@link chairCount} for total treatable capacity.
   */
  readonly openMinutesToday: number;
  /**
   * Chairs that can be occupied at once. Always at least 1. A clinic with three
   * chairs genuinely delivers three appointments an hour, and treating it as one
   * makes utilization read triple and pin at its cap.
   */
  readonly chairCount: number;
  /**
   * Typical appointment length in minutes (`clinic_settings.
   * average_appointment_duration`). Used only to express spare time in a unit a
   * dentist thinks in — "room for about 4 more appointments".
   */
  readonly typicalAppointmentMinutes: number;
}

/**
 * The complete data snapshot the Metrics Engine reasons over for a single
 * clinic + date. All arrays are already scoped by the repository; the engine
 * only counts, sums, and derives from them.
 */
export interface ClinicDataSnapshot {
  /** The clinic the snapshot belongs to. */
  readonly clinicId: string;
  /** The business date the snapshot describes, "YYYY-MM-DD". */
  readonly date: string;
  /**
   * ISO-8601 moment the data was captured. Used for time-based, deterministic
   * calculations (e.g. current waiting time) and as each metric's timestamp.
   */
  readonly asOf: string;

  /** Appointments scheduled on `date`. */
  readonly appointmentsToday: readonly AppointmentSnapshot[];
  /** Patients whose record was created on `date`. */
  readonly patientsRegisteredToday: readonly PatientSnapshot[];
  /** Patients who have an appointment on `date` (with their creation date). */
  readonly patientsSeenToday: readonly PatientSnapshot[];
  /** Clinic-wide treatments, used for balance and pending-value metrics. */
  readonly treatments: readonly TreatmentSnapshot[];
  /** Clinic-wide payments, used for revenue and outstanding-balance metrics. */
  readonly payments: readonly PaymentSnapshot[];
  /** Queue entries for `date`. */
  readonly queueToday: readonly QueueEntrySnapshot[];
  /** Follow-ups relevant to `date` (pending, due, or overdue). */
  readonly followUps: readonly FollowUpSnapshot[];
  /** Capacity for `date`. */
  readonly capacity: CapacitySnapshot;

  /**
   * The clinic's full active patient roster.
   *
   * OPTIONAL by design. A repository that cannot afford to load the roster — or
   * a caller that only wants same-day metrics — omits it, and the metrics that
   * depend on it are withheld rather than reported as zero. Every metric that
   * existed before the roster was introduced is unaffected by its absence.
   */
  readonly patientRoster?: readonly PatientRosterEntry[];

  /**
   * Days since a patient's last visit before they count as due for reactivation,
   * for THIS clinic.
   *
   * OPTIONAL. Recall frequency is a clinical judgement that varies by practice
   * type — orthodontic lists review in weeks, implant-led ones in years — so a
   * single global constant is wrong for anyone who is not a general practice.
   * When a repository supplies one, `patients.reactivation_candidates` uses it;
   * when it does not, the metric falls back to the global default and behaves
   * exactly as it always has.
   *
   * Optional rather than required on purpose: making it mandatory would force
   * every existing repository and every test fixture to state a number, which
   * would have meant inventing one in a dozen places that have no opinion.
   */
  readonly recallIntervalDays?: number;

  /**
   * Patient ids whose outstanding balance is currently under an agreed payment
   * plan with the clinic — `patients.payment_plan_until >= today`, resolved by
   * the repository.
   *
   * OPTIONAL, and its absence means something different from an empty set. Not
   * supplied: no repository support, so `revenue.outstanding_on_payment_plan` is
   * WITHHELD and `revenue.high_outstanding` reads the whole outstanding total
   * exactly as it always has. An empty set: the repository looked and nobody
   * currently has one — a real, reportable zero.
   */
  readonly patientsOnPaymentPlan?: ReadonlySet<string>;

  /**
   * The trailing schedule window ending on `date` (inclusive).
   *
   * Rates and averages need a denominator larger than one day. Dentistry is
   * lumpy — a single cancellation swings a daily rate by tens of percent — so a
   * daily figure is n=1 noise, and thresholds set against it fire on ordinary
   * quiet days.
   *
   * OPTIONAL: a repository that cannot afford the range read omits it, and the
   * window metrics are withheld rather than reported as zero.
   */
  readonly trailingWindow?: ScheduleWindow;

  /**
   * The forward schedule window starting the day AFTER `date` (inclusive).
   *
   * The only forward-looking input the engine has. Everything else reports what
   * already happened; this is what lets it warn while there is still time to
   * act — a clinic can look healthy today and be empty next week.
   *
   * Excludes `date` itself: today is already half-spent, and counting it would
   * make "how full is the week ahead" depend on the time of day.
   *
   * OPTIONAL, as above.
   */
  readonly forwardWindow?: ScheduleWindow;

  /**
   * Attended visits across the SAME trailing window as {@link trailingWindow},
   * each carrying its booked length beside its measured length.
   *
   * A separate field rather than a property of `ScheduleWindow`, because a
   * schedule window is appointments plus the capacity offered for them — a
   * forward window has no measured durations at all, and putting an always-empty
   * array there would invite reading it as "nothing overran next week".
   *
   * OPTIONAL, as every window input is. A repository that cannot afford the read
   * omits it and the overrun metrics are withheld rather than reported as zero —
   * which matters more here than almost anywhere else, since a reported 0%
   * overrun is the exact claim "this clinic books accurately".
   */
  readonly trailingVisitDurations?: readonly VisitDurationSnapshot[];
}
