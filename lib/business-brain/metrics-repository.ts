/**
 * lib/business-brain/metrics-repository.ts
 *
 * Supabase-backed implementation of the Business Brain's `MetricsDataRepository`
 * port. This is the ONLY place the Business Brain's data comes from, and the
 * only file in the system that knows both DentGrow's schema and the engine's
 * snapshot shape.
 *
 * Why it lives in `lib/` and not in `business-brain/repositories/`
 * ----------------------------------------------------------------
 * The port (the interface + snapshot types) belongs to the Business Brain and
 * stays there. The adapter belongs to the application, because it is the thing
 * that depends on Supabase, on DentGrow's table names, and on `lib/` helpers.
 *
 * Keeping it here means `business-brain/` imports no database client and no
 * application code at all — so the module stays portable and its determinism
 * guarantee is absolute rather than "pure except the repositories folder". It
 * also lets this file reuse `lib/scheduling/slots.ts` rather than growing a
 * second, disagreeing definition of clinic capacity.
 *
 * Responsibilities that are ONLY enforced here
 * --------------------------------------------
 * 1. Soft deletes. The string `deleted_at` appears nowhere in `business-brain/`
 *    — the snapshot shape gives no hint it exists. CLAUDE.md §13.14 requires
 *    every query on a soft-deletable table to filter it, and a leaked
 *    soft-deleted treatment would corrupt every revenue metric.
 * 2. Clinic scoping. The engines reject mixed-clinic *metrics* downstream, but
 *    nothing stops a bad query from mixing *rows* before they get there.
 * 3. Timezone. `date` is a clinic-local business date, not a UTC day.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  SnapshotKnowledge,
  AppointmentSnapshot,
  ClinicDataSnapshot,
  FollowUpSnapshot,
  MetricsDataRepository,
  PatientSnapshot,
  PaymentSnapshot,
  QueueEntrySnapshot,
  TreatmentSnapshot,
  VisitDurationSnapshot,
} from "@/business-brain";
import type { Database } from "@/types/database.types";
import { DEFAULT_TIMEZONE } from "@/lib/clinic/constants";
import { getUtcBoundariesForLocalDate } from "@/lib/utils";
import { addDays, ALL_HISTORY_ENTITIES, historyCovers, type HistoryCapture, type HistoryEntity } from "@/business-brain";
import { fetchScheduleInputs, openMinutesInRange, openMinutesOnDate } from "./schedule-inputs";
import { readAll } from "./paged-read";

/**
 * Most rows one snapshot query may return. The cumulative reads (every treatment
 * and payment a clinic has ever recorded) grow with clinic history; past this a
 * snapshot fails loudly rather than measuring balances from part of a ledger.
 */
const MAX_SNAPSHOT_ROWS = 250_000;

/**
 * TYPING NOTE
 * -----------
 * Sixteen files in this codebase fall back to `type DbClient = any` because the
 * Supabase client appears untyped: `.from(...).select(...)` infers `never`.
 *
 * The cause is a version skew between packages, NOT the schema types.
 * `@supabase/ssr` 0.6.1 declares `createServerClient` as returning
 * `SupabaseClient<Database, SchemaName, Schema>`, a three-parameter form from an
 * older `@supabase/supabase-js`; the installed 2.110 has since changed that
 * signature, so the schema object lands in a slot expecting a schema NAME and
 * every table resolves to `never`. Regenerating `types/database.types.ts` was
 * necessary but does not fix it — the fix is aligning the two packages, which
 * carries runtime risk and belongs in its own change.
 *
 * Rather than spread `any` further, every query below declares the exact row
 * shape it selects and narrows the result once, through `readAll`'s type
 * parameter. The mapping code is then fully typed against these declarations —
 * only the client boundary is loose, and it is loose in exactly one place per query.
 */

interface ClinicSettingsRow {
  timezone: string | null;
  average_appointment_duration: number | null;
  chair_count: number | null;
  recall_interval_days: number | null;
}
interface AppointmentRow {
  id: string;
  patient_id: string;
  status: string;
  scheduled_at: string;
  created_at: string;
  duration_minutes: number;
  source: string;
}
interface PatientRow {
  id: string;
  created_at: string;
}
interface PatientRosterRow {
  id: string;
  created_at: string;
  last_visit: string | null;
}
interface TreatmentRow {
  id: string;
  cost: number | string | null;
  status: string;
  performed_at: string | null;
  patient_id: string;
  created_at: string;
  opd_charged: boolean | null;
  opd_fee: number | string | null;
  xray_taken: boolean | null;
  xray_cost: number | string | null;
}

/**
 * Appointment statuses that still represent a real upcoming visit.
 * A cancelled or no-show appointment is not one the patient will attend.
 *
 * `as const` is load-bearing: it types this as a tuple of literals rather than
 * `string[]`, so the generated `appointment_status` enum checks every entry at
 * compile time. A typo here would otherwise silently match no rows and report
 * every patient as having nothing booked.
 */
const LIVE_APPOINTMENT_STATUSES = ["scheduled", "checked_in", "in_progress", "completed"] as const;
interface PaymentRow {
  id: string;
  amount: number | string | null;
  payment_date: string;
  patient_id: string;
}
interface QueueRow {
  id: string;
  status: string;
  checked_in_at: string;
  called_at: string | null;
  completed_at: string | null;
}
interface QueueDurationRow {
  appointment_id: string;
  called_at: string | null;
  completed_at: string | null;
}
interface FollowUpRow {
  id: string;
  due_date: string;
  status: string;
}



/** The record reads a snapshot is built from, as current state or as known at a moment. */
interface SnapshotReader {
  appointments(start: string, end: string): Promise<AppointmentSnapshot[]>;
  patientsRegistered(start: string, end: string): Promise<PatientSnapshot[]>;
  patientsSeen(patientIds: string[]): Promise<PatientSnapshot[]>;
  treatments(asOf: string): Promise<Array<Omit<TreatmentSnapshot, "isScheduled"> & { patientId: string }>>;
  payments(date: string): Promise<PaymentSnapshot[]>;
  followUps(date: string): Promise<FollowUpSnapshot[]>;
  patientsWithFutureAppointments(asOf: string): Promise<Set<string>>;
  patientRoster(asOf: string): Promise<PatientRosterRow[]>;
  patientsOnPaymentPlan(date: string): Promise<Set<string>>;
}

type RpcRow<N extends keyof Database["public"]["Functions"]> = Database["public"]["Functions"][N]["Returns"] extends (infer R)[] ? R : never;
type AppointmentStateRow = RpcRow<"appointment_states_as_of">;
type TreatmentStateRow = RpcRow<"treatment_states_as_of">;
type FollowUpStateRow = RpcRow<"follow_up_states_as_of">;
type PaymentStateRow = RpcRow<"payment_states_as_of">;
type PatientStateRow = RpcRow<"patient_states_as_of">;

/** A timestamp, or null when it falls after the moment being described. */
function notAfter(iso: string | null, knownAt: string): string | null {
  return iso !== null && Date.parse(iso) <= Date.parse(knownAt) ? iso : null;
}

export interface SupabaseMetricsRepositoryOptions {
  /**
   * Capture moment for the snapshot, ISO-8601. Every metric is stamped with
   * this and time-based calculations (current waiting time) measure against it.
   *
   * This is the one legitimate place the clock is read: the engines themselves
   * are clock-free by design, so injecting it here keeps them testable and
   * makes a snapshot reproducible after the fact.
   */
  readonly asOf?: string;
  /**
   * Length of the trailing schedule window, in days (inclusive of `date`).
   * Must match the Metrics Engine's TRAILING_DAYS, or the window metrics will be
   * named `_30d` while measuring something else.
   */
  readonly trailingWindowDays?: number;
  /** Length of the forward schedule window, in days after `date`. */
  readonly forwardWindowDays?: number;
  /**
   * The real present, ISO-8601. A snapshot whose moment is earlier describes the
   * past and is read from state history where history reaches it. Injected for
   * tests only; production reads the clock.
   */
  readonly now?: string;
}

/**
 * Defaults mirror `business-brain` METRIC_WINDOWS. They are restated rather than
 * imported because the window length is part of each metric's NAME
 * (`production_30d`, `booked_next_7d`); changing one side alone would leave a
 * metric measuring something its own key denies.
 */
const DEFAULT_TRAILING_DAYS = 30;
const DEFAULT_FORWARD_DAYS = 7;

/**
 * Reads a clinic's day from Supabase and maps it into the narrow, stable shape
 * the Metrics Engine reasons over.
 *
 * Pass a service-role client (or any client already scoped to the clinic). The
 * queries filter by `clinic_id` explicitly and never rely on RLS for tenant
 * isolation, so the same code is correct under either.
 */
export class SupabaseMetricsDataRepository implements MetricsDataRepository {
  private readonly db: SupabaseClient<Database>;
  private readonly options: SupabaseMetricsRepositoryOptions;

  constructor(db: SupabaseClient<Database>, options: SupabaseMetricsRepositoryOptions = {}) {
    this.db = db;
    this.options = options;
  }

  async getClinicSnapshot(clinicId: string, date: string): Promise<ClinicDataSnapshot> {
    const clock = this.options.asOf ?? new Date().toISOString();

    // Clinic settings drive both the day boundaries and the slot size used for
    // capacity, so they must be resolved before anything date-scoped runs.
    const { data: settings, error: settingsError } = await this.db
      .from("clinic_settings")
      .select("timezone, average_appointment_duration, chair_count, recall_interval_days")
      .eq("clinic_id", clinicId)
      .maybeSingle();
    // A failed read is not "no settings": falling back would measure the day in
    // the wrong timezone with a guessed chair count and say nothing.
    if (settingsError) throw new Error(`clinic_settings: ${settingsError.message}`);

    const cfg = (settings ?? null) as ClinicSettingsRow | null;
    const timezone = cfg?.timezone ?? DEFAULT_TIMEZONE;
    const typicalAppointmentMinutes = cfg?.average_appointment_duration ?? 30;
    // A clinic that has never set a chair count is a one-chair clinic. Guarded
    // against 0 as well as null: capacity is open time x chairs, so a zero here
    // would report a working clinic as having no capacity at all.
    const chairCount = Math.max(1, cfg?.chair_count ?? 1);
    const { start: dayStart, end: dayEnd } = getUtcBoundariesForLocalDate(date, timezone);

    // POINT IN TIME
    // -------------
    // `asOf` is the moment the snapshot describes, and for a past date that is
    // the END OF THAT DAY — not now. This used to be the wall clock regardless
    // of `date`, which meant every historical day was measured with today's
    // knowledge: "outstanding balance last Tuesday" returned today's balance,
    // and "does this patient have an upcoming visit" asked about today's future.
    //
    // The Diagnosis Engine reads those history days to decide whether a breach
    // is sustained, improving or intermittent. Feeding it the same current
    // figure for all seven days made every cumulative metric a flat line, so a
    // threshold crossed this morning was classified as sustained for a week.
    //
    // Clamped rather than replaced: for today's date the clock is still the
    // right answer, because a snapshot taken at 11:00 must not claim to know
    // the afternoon.
    const asOf = clock < dayEnd ? clock : dayEnd;
    const trailingDays = this.options.trailingWindowDays ?? DEFAULT_TRAILING_DAYS;
    const forwardDays = this.options.forwardWindowDays ?? DEFAULT_FORWARD_DAYS;
    const trailingFrom = addDays(date, -(trailingDays - 1));
    const forwardFrom = addDays(date, 1);
    const forwardTo = addDays(date, forwardDays);

    // One read of the schedule rules covers today, the trailing window and the
    // forward window — see fetchScheduleInputs. Schedule rules are not versioned:
    // a past day reads today's rules, and every reading that uses them says so.
    const scheduleInputs = await fetchScheduleInputs(this.db, clinicId, trailingFrom, forwardTo);

    // WHAT THE SNAPSHOT KNOWS
    // -----------------------
    // A snapshot of the present reads records as they stand. A snapshot of a past
    // moment reads each record's state AS RECORDED BY THAT MOMENT, from the state
    // history (migration 20260917100000): an appointment cancelled since still
    // counts as booked, a payment keyed in since for an earlier date is not yet on
    // the books. Only where history does not reach the moment — before capture
    // began — are current records read instead, and the snapshot says so.
    // Without an injected moment the snapshot's clock IS the present; reading the
    // clock a second time would make a present snapshot look a few ms in the past.
    const now = this.options.now ?? (this.options.asOf === undefined ? clock : new Date().toISOString());
    const knowledge = await this.resolveKnowledge(asOf, now);
    const reader = knowledge.mode === "point_in_time" ? this.pointInTime(clinicId, asOf) : this.current(clinicId);

    const [
      appointmentsToday,
      patientsRegisteredToday,
      treatments,
      payments,
      queueToday,
      followUps,
      patientsWithFutureAppointment,
      roster,
      patientsOnPaymentPlan,
      trailingAppointments,
      forwardAppointments,
      trailingQueueDurations,
    ] = await Promise.all([
      reader.appointments(dayStart, dayEnd),
      reader.patientsRegistered(dayStart, dayEnd),
      reader.treatments(asOf),
      reader.payments(date),
      this.fetchQueue(clinicId, date, knowledge),
      reader.followUps(date),
      reader.patientsWithFutureAppointments(asOf),
      reader.patientRoster(asOf),
      reader.patientsOnPaymentPlan(date),
      reader.appointments(getUtcBoundariesForLocalDate(trailingFrom, timezone).start, getUtcBoundariesForLocalDate(date, timezone).end),
      reader.appointments(getUtcBoundariesForLocalDate(forwardFrom, timezone).start, getUtcBoundariesForLocalDate(forwardTo, timezone).end),
      this.fetchVisitDurations(clinicId, trailingFrom, date, knowledge),
    ]);

    // Depends on today's appointments, so it cannot join the parallel batch.
    //
    // A cancelled or no-show appointment is not a visit — the patient was not
    // seen, so they must not count as "seen"/"returning" today. Filtered to
    // LIVE_APPOINTMENT_STATUSES for the same reason `isScheduled` and
    // `bookedMinutes` already exclude them elsewhere in this file; leaving it
    // unfiltered inflated `patients.returning_today` on days with cancellations
    // (audit: patientsSeenToday row-status gap).
    const patientsSeenToday = await reader.patientsSeen(
      appointmentsToday
        .filter((a) => (LIVE_APPOINTMENT_STATUSES as readonly string[]).includes(a.status))
        .map((a) => a.patientId),
    );

    return {
      clinicId,
      date,
      asOf,
      timezone,
      knowledge,
      appointmentsToday,
      patientsRegisteredToday,
      patientsSeenToday,
      // Keep patientId on the snapshot so revenue.outstanding can clamp per
      // patient (a deposit on one patient's planned work must not erase another
      // patient's billable debt).
      treatments: treatments.map((t) => ({
        ...t,
        isScheduled: patientsWithFutureAppointment.has(t.patientId),
      })),
      payments,
      queueToday,
      followUps,
      capacity: {
        openMinutesToday: openMinutesOnDate(date, scheduleInputs),
        chairCount,
        typicalAppointmentMinutes,
      },
      trailingWindow: {
        from: trailingFrom,
        to: date,
        appointments: trailingAppointments,
        openChairMinutes:
          openMinutesInRange(trailingFrom, date, scheduleInputs) * chairCount,
      },
      forwardWindow: {
        from: forwardFrom,
        to: forwardTo,
        appointments: forwardAppointments,
        openChairMinutes:
          openMinutesInRange(forwardFrom, forwardTo, scheduleInputs) * chairCount,
      },
      patientRoster: roster.map((p) => ({
        id: p.id,
        createdAt: p.created_at,
        lastVisit: p.last_visit,
        hasUpcomingAppointment: patientsWithFutureAppointment.has(p.id),
      })),
      // Per-clinic recall interval, where the clinic has set one. Passed through
      // rather than defaulted here: the calculator owns the fallback, so there is
      // one place that decides what "no interval configured" means.
      recallIntervalDays: cfg?.recall_interval_days ?? undefined,
      patientsOnPaymentPlan,
      // Joined here rather than in SQL: the booked length lives on the
      // appointment and the delivered length on the queue entry, and the
      // trailing appointments were loaded a few lines above for the window
      // metrics. Pairing them in memory avoids a second read of the same rows.
      //
      // An appointment with no queue entry contributes nothing — not a zero. A
      // visit nobody checked in is a visit whose length was never measured, and
      // counting it as on-time would make a clinic that forgets to close its
      // queue entries look like one that books perfectly.
      trailingVisitDurations: joinVisitDurations(trailingAppointments, trailingQueueDurations),
    };
  }

  // ── How records are read ───────────────────────────────────────────────────

  /**
   * Point-in-time when the snapshot's moment is in the past AND every entity's
   * history reaches back to it; current state otherwise, with the reason.
   */
  private async resolveKnowledge(asOf: string, now: string): Promise<SnapshotKnowledge> {
    if (Date.parse(asOf) >= Date.parse(now)) return { mode: "current_state", knownAt: asOf, reason: "describes_present" };
    const { data, error } = await this.db.from("entity_history_capture").select("entity, captured_since");
    if (error) throw new Error(`entity_history_capture: ${error.message}`);
    const captures: HistoryCapture[] = ((data ?? []) as { entity: string; captured_since: string }[]).map((r) => ({
      entity: r.entity as HistoryEntity,
      capturedSince: r.captured_since,
    }));
    return historyCovers(captures, ALL_HISTORY_ENTITIES, asOf).covered
      ? { mode: "point_in_time", knownAt: asOf }
      : { mode: "current_state", knownAt: now, reason: "before_history_capture" };
  }

  /** Records as they stand now. */
  private current(clinicId: string): SnapshotReader {
    return {
      appointments: (windowStart, windowEnd) => this.fetchAppointments(clinicId, windowStart, windowEnd),
      patientsRegistered: (windowStart, windowEnd) => this.fetchPatientsRegistered(clinicId, windowStart, windowEnd),
      patientsSeen: (ids) => this.fetchPatientsSeen(clinicId, ids),
      treatments: (asOf) => this.fetchTreatments(clinicId, asOf),
      payments: (date) => this.fetchPayments(clinicId, date),
      followUps: (date) => this.fetchFollowUps(clinicId, date),
      patientsWithFutureAppointments: (asOf) => this.fetchPatientsWithFutureAppointments(clinicId, asOf),
      patientRoster: (asOf) => this.fetchPatientRoster(clinicId, asOf),
      patientsOnPaymentPlan: (date) => this.fetchPatientsOnPaymentPlan(clinicId, date),
    };
  }

  /**
   * Records as OraMedha knew them at `knownAt`: each one's latest state version
   * recorded by then, from the database's point-in-time readers. Nothing recorded
   * later (a cancellation, a deletion, a payment keyed in for an earlier date)
   * reaches the snapshot.
   */
  private pointInTime(clinicId: string, knownAt: string): SnapshotReader {
    let patients: Promise<PatientStateRow[]> | undefined;
    const patientStates = () =>
      (patients ??= readAll<PatientStateRow>(
        "patient_states_as_of",
        (from, to) =>
          this.db.rpc("patient_states_as_of", { p_clinic_id: clinicId, p_known_at: knownAt }).order("patient_id", { ascending: true }).range(from, to),
        MAX_SNAPSHOT_ROWS,
      ).then((rows) => rows.filter((p) => !p.is_deleted)));

    const appointmentStates = (args: { from?: string; to?: string; statuses?: Database["public"]["Enums"]["appointment_status"][] }) =>
      readAll<AppointmentStateRow>(
        "appointment_states_as_of",
        (from, to) =>
          this.db
            .rpc("appointment_states_as_of", {
              p_clinic_id: clinicId,
              p_known_at: knownAt,
              ...(args.from === undefined ? {} : { p_scheduled_from: args.from }),
              ...(args.to === undefined ? {} : { p_scheduled_to: args.to }),
              ...(args.statuses === undefined ? {} : { p_statuses: args.statuses }),
            })
            .order("appointment_id", { ascending: true })
            .range(from, to),
        MAX_SNAPSHOT_ROWS,
      ).then((rows) => rows.filter((a) => !a.is_deleted));

    return {
      appointments: async (windowStart, windowEnd) =>
        (await appointmentStates({ from: windowStart, to: windowEnd })).map((a) => ({
          id: a.appointment_id,
          patientId: a.patient_id,
          status: a.status,
          scheduledAt: a.scheduled_at,
          createdAt: a.entity_created_at,
          durationMinutes: a.duration_minutes,
          source: a.source,
        })),
      patientsRegistered: async (windowStart, windowEnd) =>
        (await patientStates())
          .filter((p) => Date.parse(p.entity_created_at) >= Date.parse(windowStart) && Date.parse(p.entity_created_at) <= Date.parse(windowEnd))
          .map((p) => ({ id: p.patient_id, createdAt: p.entity_created_at })),
      patientsSeen: async (ids) => {
        const wanted = new Set(ids);
        return (await patientStates()).filter((p) => wanted.has(p.patient_id)).map((p) => ({ id: p.patient_id, createdAt: p.entity_created_at }));
      },
      treatments: async (asOf) => {
        const rows = await readAll<TreatmentStateRow>(
          "treatment_states_as_of",
          (from, to) =>
            this.db.rpc("treatment_states_as_of", { p_clinic_id: clinicId, p_known_at: knownAt }).order("treatment_id", { ascending: true }).range(from, to),
          MAX_SNAPSHOT_ROWS,
        );
        return rows
          .filter((t) => !t.is_deleted)
          .map((t) => {
            // Work dated after the snapshot's moment had not been delivered then,
            // whenever it was keyed in: the same rule the current-state read applies.
            const performedInFuture = t.performed_at !== null && Date.parse(t.performed_at) > Date.parse(asOf);
            return {
              id: t.treatment_id,
              cost: Number(t.cost ?? 0),
              status: performedInFuture ? "planned" : t.status,
              performedAt: performedInFuture ? null : t.performed_at,
              patientId: t.patient_id,
              opdCharged: t.opd_charged ?? false,
              opdFee: Number(t.opd_fee ?? 0),
              xrayTaken: t.xray_taken ?? false,
              xrayCost: Number(t.xray_cost ?? 0),
            };
          });
      },
      payments: async (date) =>
        (
          await readAll<PaymentStateRow>(
            "payment_states_as_of",
            (from, to) =>
              this.db
                .rpc("payment_states_as_of", { p_clinic_id: clinicId, p_known_at: knownAt, p_payment_to: date })
                .order("payment_id", { ascending: true })
                .range(from, to),
            MAX_SNAPSHOT_ROWS,
          )
        )
          .filter((p) => !p.is_deleted)
          .map((p) => ({ id: p.payment_id, amount: Number(p.amount ?? 0), paymentDate: p.payment_date, patientId: p.patient_id })),
      followUps: async (date) =>
        (
          await readAll<FollowUpStateRow>(
            "follow_up_states_as_of",
            (from, to) =>
              this.db
                .rpc("follow_up_states_as_of", { p_clinic_id: clinicId, p_known_at: knownAt, p_due_to: date, p_statuses: ["pending"] })
                .order("follow_up_id", { ascending: true })
                .range(from, to),
            MAX_SNAPSHOT_ROWS,
          )
        )
          .filter((f) => !f.is_deleted)
          .map((f) => ({ id: f.follow_up_id, dueDate: f.due_date, status: f.status })),
      patientsWithFutureAppointments: async (asOf) =>
        new Set(
          (await appointmentStates({ from: asOf, statuses: [...LIVE_APPOINTMENT_STATUSES] }))
            .filter((a) => Date.parse(a.scheduled_at) > Date.parse(asOf))
            .map((a) => a.patient_id),
        ),
      patientRoster: async (asOf) => {
        const [roster, visits] = await Promise.all([patientStates(), appointmentStates({ to: asOf, statuses: ["completed"] })]);
        const lastVisit = new Map<string, string>();
        for (const v of visits) {
          const current = lastVisit.get(v.patient_id);
          if (current === undefined || Date.parse(v.scheduled_at) > Date.parse(current)) lastVisit.set(v.patient_id, v.scheduled_at);
        }
        return roster
          .filter((p) => Date.parse(p.entity_created_at) <= Date.parse(asOf))
          .map((p) => ({ id: p.patient_id, created_at: p.entity_created_at, last_visit: lastVisit.get(p.patient_id) ?? null }));
      },
      patientsOnPaymentPlan: async (date) =>
        new Set((await patientStates()).filter((p) => p.payment_plan_until !== null && p.payment_plan_until >= date).map((p) => p.patient_id)),
    };
  }


  // ── Queries ────────────────────────────────────────────────────────────────

  private async fetchAppointments(
    clinicId: string,
    dayStart: string,
    dayEnd: string,
  ): Promise<AppointmentSnapshot[]> {
    const data = await readAll<AppointmentRow>(
      "appointments",
      (from, to) =>
        this.db
          .from("appointments")
          .select("id, patient_id, status, scheduled_at, created_at, duration_minutes, source")
          .eq("clinic_id", clinicId)
          .is("deleted_at", null)
          .gte("scheduled_at", dayStart)
          .lte("scheduled_at", dayEnd)
          .order("id", { ascending: true })
          .range(from, to),
      MAX_SNAPSHOT_ROWS,
    );

    return data.map((a) => ({
      id: a.id,
      patientId: a.patient_id,
      status: a.status,
      scheduledAt: a.scheduled_at,
      createdAt: a.created_at,
      durationMinutes: a.duration_minutes,
      source: a.source,
    }));
  }

  private async fetchPatientsRegistered(
    clinicId: string,
    dayStart: string,
    dayEnd: string,
  ): Promise<PatientSnapshot[]> {
    const data = await readAll<PatientRow>(
      "patients (registered)",
      (from, to) =>
        this.db
          .from("patients")
          .select("id, created_at")
          .eq("clinic_id", clinicId)
          .is("deleted_at", null)
          .gte("created_at", dayStart)
          .lte("created_at", dayEnd)
          .order("id", { ascending: true })
          .range(from, to),
      MAX_SNAPSHOT_ROWS,
    );

    return data.map((p) => ({ id: p.id, createdAt: p.created_at }));
  }

  /**
   * Patients with an appointment today, carrying their record creation date so
   * the engine can separate new from returning. Soft-deleted patients are
   * excluded even when an appointment still references them.
   */
  private async fetchPatientsSeen(
    clinicId: string,
    patientIds: string[],
  ): Promise<PatientSnapshot[]> {
    const unique = [...new Set(patientIds)];
    if (unique.length === 0) return [];

    const seen: PatientRow[] = [];
    // Chunked: an `in` list is part of the URL.
    for (let i = 0; i < unique.length; i += 200) {
      const chunk = unique.slice(i, i + 200);
      seen.push(
        ...(await readAll<PatientRow>(
          "patients (seen)",
          (from, to) =>
            this.db
              .from("patients")
              .select("id, created_at")
              .eq("clinic_id", clinicId)
              .is("deleted_at", null)
              .in("id", chunk)
              .order("id", { ascending: true })
              .range(from, to),
          MAX_SNAPSHOT_ROWS,
        )),
      );
    }

    return seen.map((p) => ({ id: p.id, createdAt: p.created_at }));
  }

  /**
   * Clinic-wide treatments — deliberately NOT date-scoped. Outstanding balance
   * is cumulative, so restricting to one day would under-report it.
   *
   * `isScheduled` — a deliberate patient-level approximation
   * -------------------------------------------------------
   * It answers: does this treatment's patient have ANY upcoming visit booked?
   *
   *   true   the patient has at least one future, non-cancelled, non-no-show
   *          appointment
   *   false  the patient has no upcoming visit at all
   *
   * It is NOT a treatment-to-appointment mapping. A patient booked for a
   * cleaning while a planned crown goes unbooked reads as `true`, and the
   * crown will not appear in `treatment.accepted_pending_scheduling`.
   *
   * That imprecision is accepted knowingly. Modelling it exactly needs a link
   * from planned work to its future visit — `treatments.appointment_id` is the
   * visit the plan was recorded at, not that link — which would force the dentist to record
   * which future visit each planned item belongs to — workflow complexity that
   * is not worth the accuracy at this stage. The approximation still answers
   * the question the clinic actually asks:
   *
   *   "Do we have planned treatment where the patient has not even
   *    booked another visit?"
   *
   * The consequence to remember when reading the metric: it UNDER-reports.
   * Anything it flags is genuinely unbooked; some genuinely unbooked work will
   * be missed because the patient has some other appointment.
   */
  /**
   * Treatments that existed as of the snapshot moment.
   *
   * Cumulative by design — outstanding balance is a running total, not a daily
   * figure — but cumulative up to `asOf`, not up to now. A treatment raised
   * after the date being measured was not on the clinic's books then, and
   * counting it made every historical balance equal to today's.
   *
   * The bound is the ECONOMIC event, not the row's creation time, because this
   * app supports backdating (migration 20260713000000): a dentist can record on
   * Wednesday work that was performed on Monday. Monday's balance should
   * include that work — the treatment happened, whatever time the keyboard was
   * touched. So:
   *
   *   performed_at set    -> on the books once the work was performed
   *   performed_at null   -> planned or cancelled; on the books once created
   *
   * Status is corrected on the same evidence. A treatment performed after `asOf`
   * cannot have been `completed` then, so it is reported as `planned` — which is
   * what it must have been, derived from a recorded timestamp rather than
   * guessed — and only if it had been created by then.
   *
   * RESIDUAL, and the reason metric persistence is worth building: status
   * changes are not versioned. A treatment cancelled tomorrow reads as
   * cancelled in yesterday's snapshot, because nothing records when it was
   * cancelled. The effect is a slight UNDER-statement of historical pending
   * value, and no query can close it — only storing each day's metrics as they
   * were measured can.
   */
  private async fetchTreatments(
    clinicId: string,
    asOf: string,
  ): Promise<Array<Omit<TreatmentSnapshot, "isScheduled"> & { patientId: string }>> {
    const data = await readAll<TreatmentRow>(
      "treatments",
      (from, to) =>
        this.db
          .from("treatments")
          .select("id, cost, status, performed_at, patient_id, created_at, opd_charged, opd_fee, xray_taken, xray_cost")
          .eq("clinic_id", clinicId)
          .is("deleted_at", null)
          .or(`performed_at.lte.${asOf},created_at.lte.${asOf}`)
          .order("id", { ascending: true })
          .range(from, to),
      MAX_SNAPSHOT_ROWS,
    );

    return data
      .map((t) => {
        const performedAt = t.performed_at;
        // Performed strictly AFTER the snapshot moment — on a historical snapshot
        // this work had not been delivered yet, so it rolls back to pipeline.
        const performedInFuture = performedAt !== null && performedAt > asOf;
        // Existed by `asOf` if it was performed by then OR merely created by then.
        const existedByAsOf =
          (performedAt !== null && performedAt <= asOf) || t.created_at <= asOf;
        // Neither performed nor even created by then — it did not exist at all.
        if (!existedByAsOf) return null;
        return {
          id: t.id,
          cost: Number(t.cost ?? 0),
          // Preserve the treatment's REAL status. A completed/in_progress
          // treatment whose `performed_at` was simply never recorded must stay
          // billable, or BB outstanding under-reports vs the canonical balance
          // and the payment send-list (audit A8). Only a treatment genuinely
          // performed after this snapshot is rolled back to `planned`.
          status: performedInFuture ? "planned" : t.status,
          performedAt: performedInFuture ? null : performedAt,
          patientId: t.patient_id,
          // OPD and X-ray charges are owed whenever the consultation / radiograph
          // happened, independent of the treatment's own status (see lib/billing).
          opdCharged: t.opd_charged ?? false,
          opdFee: Number(t.opd_fee ?? 0),
          xrayTaken: t.xray_taken ?? false,
          xrayCost: Number(t.xray_cost ?? 0),
        };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);
  }

  /**
   * The clinic's active patient roster.
   *
   * `patients.last_visit` is maintained by `completeAppointmentCascade`, so this
   * is a plain read rather than a derivation. Deciding who counts as lapsed is a
   * business rule and stays in the calculator.
   *
   * COST NOTE: this loads every active patient, and grows linearly with clinic
   * history — the same unbounded-read caveat as treatments and payments. Fine at
   * pilot scale; needs bounding before a clinic with years of records.
   */
  /**
   * The clinic's roster as it stood at `asOf`.
   *
   * Membership is bounded exactly: a patient registered after the date was not
   * on the roster then, and counting them made the historical roster grow
   * backwards in time.
   *
   * `last_visit` is deliberately NOT read from the column. That column is a
   * maintained counter holding the CURRENT most recent visit, so on a
   * historical day it reports visits that had not happened yet — which is
   * precisely backwards for a metric whose job is finding patients not seen in
   * a long time. It is derived from completed appointments instead, which carry
   * their own dates and can therefore be asked about any moment.
   */
  /**
   * Patients currently under an agreed payment plan — `payment_plan_until` set
   * and not yet passed.
   *
   * Independent of {@link fetchPatientRoster}'s historical, creation-date-bounded
   * query: a payment plan is a fact about the clinic's arrangement TODAY, not
   * something that needs asking about as of an arbitrary past date, so it is its
   * own small query rather than folded into the roster's shape.
   */
  private async fetchPatientsOnPaymentPlan(clinicId: string, date: string): Promise<Set<string>> {
    const data = await readAll<{ id: string }>(
      "patients (payment plan)",
      (from, to) =>
        this.db
          .from("patients")
          .select("id")
          .eq("clinic_id", clinicId)
          .is("deleted_at", null)
          .gte("payment_plan_until", date)
          .order("id", { ascending: true })
          .range(from, to),
      MAX_SNAPSHOT_ROWS,
    );
    return new Set(data.map((p) => p.id));
  }

  private async fetchPatientRoster(clinicId: string, asOf: string): Promise<PatientRosterRow[]> {
    const [roster, visits] = await Promise.all([
      readAll<{ id: string; created_at: string }>(
        "patients (roster)",
        (from, to) =>
          this.db
            .from("patients")
            .select("id, created_at")
            .eq("clinic_id", clinicId)
            .is("deleted_at", null)
            .lte("created_at", asOf)
            .order("id", { ascending: true })
            .range(from, to),
        MAX_SNAPSHOT_ROWS,
      ),
      readAll<{ patient_id: string; scheduled_at: string }>(
        "patients (last visit)",
        (from, to) =>
          this.db
            .from("appointments")
            .select("patient_id, scheduled_at")
            .eq("clinic_id", clinicId)
            .is("deleted_at", null)
            .eq("status", "completed")
            .lte("scheduled_at", asOf)
            .order("id", { ascending: true })
            .range(from, to),
        MAX_SNAPSHOT_ROWS,
      ),
    ]);

    const lastVisit = new Map<string, string>();
    for (const v of visits) {
      const current = lastVisit.get(v.patient_id);
      if (current === undefined || v.scheduled_at > current) {
        lastVisit.set(v.patient_id, v.scheduled_at);
      }
    }

    return roster.map((p) => ({
      id: p.id,
      created_at: p.created_at,
      last_visit: lastVisit.get(p.id) ?? null,
    }));
  }

  /**
   * Patients who have at least one upcoming visit booked.
   *
   * This is the basis for `isScheduled`, and it is deliberately an
   * approximation at the PATIENT level rather than the treatment level — see
   * the note on {@link fetchTreatments}.
   *
   * "Upcoming" means strictly after the snapshot's capture moment and in a
   * status the patient would actually attend; a cancelled or no-show
   * appointment is not a booked visit.
   */
  private async fetchPatientsWithFutureAppointments(
    clinicId: string,
    asOf: string,
  ): Promise<Set<string>> {
    const data = await readAll<{ patient_id: string }>(
      "appointments (future)",
      (from, to) =>
        this.db
          .from("appointments")
          .select("patient_id")
          .eq("clinic_id", clinicId)
          .is("deleted_at", null)
          .gt("scheduled_at", asOf)
          .in("status", LIVE_APPOINTMENT_STATUSES)
          .order("id", { ascending: true })
          .range(from, to),
      MAX_SNAPSHOT_ROWS,
    );

    return new Set(data.map((a) => a.patient_id));
  }

  /**
   * Clinic-wide payments — cumulative, for the same reason as treatments, and
   * bounded by the same moment.
   *
   * Exact, unlike treatments: `payment_date` records when the money arrived, so
   * "payments received on or before D" needs no reconstruction. The bound is on
   * the calendar date rather than a timestamp because that is the column's
   * granularity.
   */
  private async fetchPayments(clinicId: string, date: string): Promise<PaymentSnapshot[]> {
    const data = await readAll<PaymentRow>(
      "payments",
      (from, to) =>
        this.db
          .from("payments")
          .select("id, amount, payment_date, patient_id")
          .eq("clinic_id", clinicId)
          .is("deleted_at", null)
          .lte("payment_date", date)
          .order("id", { ascending: true })
          .range(from, to),
      MAX_SNAPSHOT_ROWS,
    );

    return data.map((p) => ({
      id: p.id,
      amount: Number(p.amount ?? 0),
      paymentDate: p.payment_date,
      patientId: p.patient_id,
    }));
  }

  /**
   * Today's queue. `queue_entries` has no `deleted_at` and is already scoped by
   * `queue_date`, which is the clinic-local business date — so it is compared
   * directly rather than through UTC boundaries.
   */
  /**
   * Queue entries across the trailing window, reduced to the two timestamps that
   * bound a visit.
   *
   * Scoped by `queue_date`, which is already the clinic's business date, so no
   * timezone conversion is needed or wanted here — converting an
   * already-local date through the clinic offset a second time would shift the
   * window edges.
   *
   * `queue_entries` has no `deleted_at`: it is not a soft-deletable table (see
   * CLAUDE.md 5.11), so no filter belongs here.
   */
  private async fetchVisitDurations(
    clinicId: string,
    from: string,
    to: string,
    knowledge: SnapshotKnowledge,
  ): Promise<QueueDurationRow[]> {
    // Ordered by check-in so "first entry wins" in the join below is the first
    // entry in time, not whichever row the server happened to return first.
    const rows = await readAll<QueueDurationRow>(
      "queue_entries (durations)",
      (start, end) =>
        this.db
          .from("queue_entries")
          .select("appointment_id, called_at, completed_at")
          .eq("clinic_id", clinicId)
          .gte("queue_date", from)
          .lte("queue_date", to)
          .order("checked_in_at", { ascending: true })
          .order("id", { ascending: true })
          .range(start, end),
      MAX_SNAPSHOT_ROWS,
    );
    // Queue entries are not versioned, but their timestamps are stamped by the
    // server as each step happens: a step stamped after the snapshot's moment had
    // not happened then.
    return knowledge.mode === "point_in_time"
      ? rows.map((r) => ({ ...r, called_at: notAfter(r.called_at, knowledge.knownAt), completed_at: notAfter(r.completed_at, knowledge.knownAt) }))
      : rows;
  }

  private async fetchQueue(clinicId: string, date: string, knowledge: SnapshotKnowledge): Promise<QueueEntrySnapshot[]> {
    const data = await readAll<QueueRow>(
      "queue_entries",
      (from, to) =>
        this.db
          .from("queue_entries")
          .select("id, status, checked_in_at, called_at, completed_at")
          .eq("clinic_id", clinicId)
          .eq("queue_date", date)
          .order("id", { ascending: true })
          .range(from, to),
      MAX_SNAPSHOT_ROWS,
    );

    if (knowledge.mode === "point_in_time") {
      // Status as the stamped steps show it at the snapshot's moment. An entry
      // checked in after that moment was not in the queue yet. A status with no
      // stamp to date it (completed without completed_at) is left as recorded:
      // queue entries are an unversioned input, and every reading says so.
      return data
        .filter((q) => Date.parse(q.checked_in_at) <= Date.parse(knowledge.knownAt))
        .map((q) => {
          const called = notAfter(q.called_at, knowledge.knownAt);
          const completed = notAfter(q.completed_at, knowledge.knownAt);
          const stamped = q.called_at !== null || q.completed_at !== null;
          const status = completed !== null ? "completed" : called !== null ? "in_progress" : stamped ? "waiting" : q.status;
          return { id: q.id, status, checkedInAt: q.checked_in_at, startedAt: called };
        });
    }
    return data.map((q) => ({
      id: q.id,
      status: q.status,
      checkedInAt: q.checked_in_at,
      // `called_at` is when waiting ended; null means the patient is still waiting.
      startedAt: q.called_at,
    }));
  }

  /**
   * Pending follow-ups due on or before the target date — exactly the set the
   * due-today and overdue calculators need, and nothing more.
   */
  private async fetchFollowUps(clinicId: string, date: string): Promise<FollowUpSnapshot[]> {
    const data = await readAll<FollowUpRow>(
      "follow_ups",
      (from, to) =>
        this.db
          .from("follow_ups")
          .select("id, due_date, status")
          .eq("clinic_id", clinicId)
          .is("deleted_at", null)
          .eq("status", "pending")
          .lte("due_date", date)
          .order("id", { ascending: true })
          .range(from, to),
      MAX_SNAPSHOT_ROWS,
    );

    return data.map((f) => ({ id: f.id, dueDate: f.due_date, status: f.status }));
  }
}

/**
 * Pair each trailing appointment's BOOKED length with the DELIVERED length its
 * queue entry recorded.
 *
 * Exported for its tests: this is the one place two ledgers are joined, and the
 * join is where the measurement can quietly go wrong.
 *
 * Three rules, each guarding a way the figure could lie:
 *
 * 1. Only appointments the patient actually attended contribute. A cancelled or
 *    no-show appointment has a booked length and no delivered one, and including
 *    it would read as an appointment that took zero minutes.
 * 2. A visit with no queue entry, or a queue entry missing either timestamp,
 *    yields `actualMinutes: null` — never a zero. The calculator drops those
 *    rather than treating an unmeasured visit as a punctual one.
 * 3. A negative interval (a `completed_at` before its `called_at`, which only
 *    bad data produces) is discarded rather than clamped. Clamping to zero would
 *    silently pull the clinic's average down using a row that means nothing.
 */
export function joinVisitDurations(
  appointments: readonly AppointmentSnapshot[],
  queueRows: readonly { appointment_id: string; called_at: string | null; completed_at: string | null }[],
): VisitDurationSnapshot[] {
  const byAppointment = new Map<string, { called: string | null; completed: string | null }>();
  for (const row of queueRows) {
    // First entry wins. A patient re-queued on the same appointment is a rare
    // correction; taking the first keeps the join deterministic either way.
    if (byAppointment.has(row.appointment_id)) continue;
    byAppointment.set(row.appointment_id, {
      called: row.called_at,
      completed: row.completed_at,
    });
  }

  const attended = new Set<string>(["checked_in", "in_progress", "completed"]);

  return appointments
    .filter((a) => attended.has(a.status))
    .map((a) => {
      const entry = byAppointment.get(a.id);
      return {
        appointmentId: a.id,
        scheduledMinutes: a.durationMinutes,
        actualMinutes: measuredMinutes(entry?.called ?? null, entry?.completed ?? null),
      };
    });
}

/** Whole minutes between two timestamps, or null when either is absent or invalid. */
function measuredMinutes(called: string | null, completed: string | null): number | null {
  if (called === null || completed === null) return null;
  const start = Date.parse(called);
  const end = Date.parse(completed);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const minutes = (end - start) / 60_000;
  return minutes < 0 ? null : Math.round(minutes);
}
