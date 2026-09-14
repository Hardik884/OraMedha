/**
 * lib/business-brain/clinic-ledger.ts
 *
 * The Supabase adapter for `ClinicLedgerPort` — the relational half of the
 * Business Brain's data access.
 *
 * Extends `SupabaseDiagnosisContext`, so one instance serves the Diagnosis
 * Engine's entity questions AND the general ledger reads. Nothing about the
 * diagnosis methods changes.
 *
 * ## Tenant isolation, stated once
 *
 * Every table read carries an explicit `clinic_id` predicate, even though the
 * dashboard runs on the dentist's own session and RLS already scopes it. The
 * adapter must stay correct under the service role, and an `in (ids)` without a
 * clinic predicate is a cross-tenant join waiting for the day someone passes one.
 *
 * `appointment_history` is the exception the schema forces: it has no
 * `clinic_id`. It is read ONLY for appointment ids this adapter has already
 * loaded under a clinic predicate, and each event inherits its clinic from that
 * appointment. `buildLedgerGraph` re-checks that every event hangs from a loaded
 * appointment.
 *
 * ## Soft deletes
 *
 * Every soft-deletable table is filtered on `deleted_at IS NULL`. Three tables
 * have no `deleted_at` — `queue_entries`, `appointment_history`,
 * `treatment_history` — and their rows outlive the parent they describe, so
 * liveness is PROPAGATED: a queue entry for a deleted appointment, or a history
 * event for a deleted treatment, is dropped. When the parent read was truncated
 * the adapter cannot tell a deleted parent from a cut one, so it marks the child
 * kind truncated too rather than presenting the survivors as complete.
 *
 * ## What is never selected
 *
 * Column lists are explicit. No names, phone numbers, emails, dates of birth,
 * addresses, `internal_notes`, `patient_visible_notes`, medications, prescription
 * or document fields, notes of any kind, and never a whole jsonb audit value —
 * the status fields are extracted inside the query with `->>`.
 *
 * ## Failures throw
 *
 * A failed query is not an empty ledger. Returning an empty slice would read as
 * "this patient has no appointments", which is exactly the silent zero the rest
 * of the Business Brain refuses to produce.
 */

import "server-only";

import { readAll, readUpTo, type PageQuery } from "./paged-read";

import {
  LedgerFactKind,
  type ActionCompletionFact,
  type AppointmentEventFact,
  type AppointmentFact,
  type AppointmentWindowScope,
  type CapacityWindowFact,
  type CapacityWindowScope,
  type OpenWorkScope,
  type ClinicLedgerPort,
  type ClinicLedgerSlice,
  type FollowUpFact,
  type LedgerAppointmentStatus,
  type LedgerFollowUpStatus,
  type LedgerQueueStatus,
  type LedgerScope,
  type LedgerTreatmentStatus,
  type PatientFact,
  type PatientLedgerScope,
  type PaymentFact,
  type QueueVisitFact,
  type ReminderSendFact,
  type TreatmentEventFact,
  type TreatmentFact,
} from "@/business-brain";
import {
  isBillableTreatment,
  opdChargeFor,
  treatmentTotalCharge,
  xrayChargeFor,
} from "@/lib/billing/balance";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database.types";
import { dateRange } from "@/business-brain";
import { isWhatsAppReachable } from "@/lib/messaging/eligibility";
import { getUtcBoundariesForLocalDate, zonedDateToUTC } from "@/lib/utils";

import { fetchScheduleInputs, openSpansOnDate } from "./schedule-inputs";

import { SupabaseDiagnosisContext } from "./diagnosis-context";

/**
 * Most patients one patient-scoped read may name. A guard on URL length and on
 * the idea of a "bounded" read — callers page rather than exporting a roster.
 */
export const MAX_LEDGER_PATIENTS = 200;

/** Ids per `in (...)` filter, so a large parent set never builds an oversized URL. */
const ID_CHUNK = 100;

function distinct(ids: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const id of ids) if (typeof id === "string" && id.length > 0) seen.add(id);
  return [...seen];
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Clinic-local "YYYY-MM-DD" of an instant. */
function localDateOf(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

type QueryResult = PromiseLike<{ data: unknown; error: { message: string } | null }>;

/**
 * Up to `fetchLimit` rows of an ordered query, paged under the PostgREST row cap.
 *
 * Callers ask for `limit + 1` and pass the result to `capped`, which marks the
 * kind truncated when more than `limit` came back. Before paging, the server's
 * 1000-row cap stopped every read at 1000 first, so a window of 1200
 * appointments came back as 1000 and was reported complete.
 */
async function readWindow<T>(label: string, page: PageQuery, fetchLimit: number): Promise<T[]> {
  return (await readUpTo<T>(`clinic ledger (${label})`, page, fetchLimit)).rows;
}

/** Most rows a whole-clinic open-work read may return before the read is refused. */
const MAX_OPEN_WORK_ROWS = 250_000;

/** Cap a merged result at `limit`, reporting whether anything was cut. */
function capped<T>(all: readonly T[], limit: number): { rows: T[]; truncated: boolean } {
  return all.length > limit
    ? { rows: all.slice(0, limit), truncated: true }
    : { rows: [...all], truncated: false };
}

function uniqueById<T extends { id: string }>(items: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of items) if (!byId.has(item.id)) byId.set(item.id, item);
  return [...byId.values()];
}

function distinctKinds(kinds: readonly LedgerFactKind[]): LedgerFactKind[] {
  return [...new Set(kinds)];
}

/**
 * Concatenate patient-scope pages into one slice. Pages hold disjoint patients,
 * so every patient-bearing row appears once; action completions can target
 * patients on two pages and are de-duplicated by id.
 */
function mergeSlices(scope: PatientLedgerScope, pages: readonly ClinicLedgerSlice[]): ClinicLedgerSlice {
  return {
    clinicId: scope.clinicId,
    scope,
    patients: pages.flatMap((p) => p.patients),
    appointments: pages.flatMap((p) => p.appointments),
    appointmentEvents: pages.flatMap((p) => p.appointmentEvents),
    treatments: pages.flatMap((p) => p.treatments),
    treatmentEvents: pages.flatMap((p) => p.treatmentEvents),
    queueVisits: pages.flatMap((p) => p.queueVisits),
    followUps: pages.flatMap((p) => p.followUps),
    payments: pages.flatMap((p) => p.payments),
    reminderSends: pages.flatMap((p) => p.reminderSends),
    actionCompletions: uniqueById(pages.flatMap((p) => p.actionCompletions)),
    truncated: distinctKinds(pages.flatMap((p) => p.truncated)),
    withheld: distinctKinds(pages.flatMap((p) => p.withheld)),
    unresolvedPatientIds: pages.flatMap((p) => p.unresolvedPatientIds),
  };
}

function assertScope(scope: LedgerScope): void {
  if (!Number.isInteger(scope.limit) || scope.limit < 1) {
    throw new RangeError(`Ledger limit must be a positive integer, got ${scope.limit}.`);
  }
  if (Number.isNaN(Date.parse(scope.asOf))) {
    throw new RangeError(`Ledger asOf is not a valid timestamp: "${scope.asOf}".`);
  }
}

function emptySlice(scope: LedgerScope, unresolvedPatientIds: readonly string[] = []): ClinicLedgerSlice {
  return {
    clinicId: scope.clinicId,
    scope,
    patients: [],
    appointments: [],
    appointmentEvents: [],
    treatments: [],
    treatmentEvents: [],
    queueVisits: [],
    followUps: [],
    payments: [],
    reminderSends: [],
    actionCompletions: [],
    truncated: [],
    withheld: [],
    unresolvedPatientIds,
  };
}

// ── Row shapes, exactly as selected ─────────────────────────────────────────

/**
 * `phone` is selected only to be reduced to a boolean in {@link readPatients};
 * the number never reaches a fact, a slice or a log.
 */
const PATIENT_COLUMNS = "id, created_at, payment_plan_until, phone";
interface PatientQueryRow {
  id: string;
  created_at: string;
  payment_plan_until: string | null;
  phone: string | null;
}
interface PatientRow {
  id: string;
  created_at: string;
  payment_plan_until: string | null;
  reachable_by_phone: boolean;
  communications_withdrawn: boolean;
}

const APPOINTMENT_COLUMNS =
  "id, patient_id, dentist_id, scheduled_at, created_at, duration_minutes, status, source, follow_up_id";
interface AppointmentRow {
  id: string;
  patient_id: string;
  dentist_id: string;
  scheduled_at: string;
  created_at: string;
  duration_minutes: number;
  status: string;
  source: string;
  follow_up_id: string | null;
}

const APPOINTMENT_EVENT_COLUMNS =
  "id, appointment_id, action, timestamp, status_after:new_value->>status, previous_scheduled_at:old_value->>scheduled_at";
interface AppointmentEventRow {
  id: string;
  appointment_id: string;
  action: AppointmentEventFact["action"];
  timestamp: string;
  status_after: string | null;
  previous_scheduled_at: string | null;
}

const TREATMENT_COLUMNS =
  "id, patient_id, appointment_id, treatment_type, status, cost, opd_charged, opd_fee, xray_taken, xray_cost, performed_at, created_at, consultant_id";
interface TreatmentRow {
  id: string;
  patient_id: string;
  appointment_id: string;
  treatment_type: string;
  status: string;
  cost: number | string | null;
  opd_charged: boolean | null;
  opd_fee: number | string | null;
  xray_taken: boolean | null;
  xray_cost: number | string | null;
  performed_at: string | null;
  created_at: string;
  consultant_id: string | null;
}

const TREATMENT_EVENT_COLUMNS =
  "id, treatment_id, patient_id, action, timestamp, status_after:new_value->>status";
interface TreatmentEventRow {
  id: string;
  treatment_id: string;
  patient_id: string;
  action: TreatmentEventFact["action"];
  timestamp: string;
  status_after: string | null;
}

const QUEUE_COLUMNS = "id, appointment_id, patient_id, queue_date, status, checked_in_at, called_at, completed_at";
interface QueueRow {
  id: string;
  appointment_id: string;
  patient_id: string;
  queue_date: string;
  status: string;
  checked_in_at: string;
  called_at: string | null;
  completed_at: string | null;
}

const FOLLOW_UP_COLUMNS =
  "id, patient_id, appointment_id, treatment_id, due_date, status, confirmation_status, follow_up_type, created_at, updated_at";
interface FollowUpRow {
  id: string;
  patient_id: string;
  appointment_id: string | null;
  treatment_id: string | null;
  due_date: string;
  status: string;
  confirmation_status: "tentative" | "confirmed";
  follow_up_type: string;
  created_at: string;
  updated_at: string;
}

const PAYMENT_COLUMNS = "id, patient_id, appointment_id, treatment_id, amount, payment_date, method";
interface PaymentRow {
  id: string;
  patient_id: string;
  appointment_id: string | null;
  treatment_id: string | null;
  amount: number | string;
  payment_date: string;
  method: string;
}

const REMINDER_COLUMNS = "id, patient_id, kind, sent_at";
interface ReminderRow {
  id: string;
  patient_id: string;
  kind: string;
  sent_at: string;
}

const COMPLETION_COLUMNS = "id, category, constraint_id, completed_at, source, target_patient_ids";
interface CompletionRow {
  id: string;
  category: string;
  constraint_id: string;
  completed_at: string;
  source: string;
  target_patient_ids: string[] | null;
}

// ── Row → fact ──────────────────────────────────────────────────────────────

function patientFact(clinicId: string, r: PatientRow): PatientFact {
  return {
    clinicId,
    id: r.id,
    registeredAt: r.created_at,
    paymentPlanUntil: r.payment_plan_until,
    reachableByPhone: r.reachable_by_phone,
    communicationsWithdrawn: r.communications_withdrawn,
  };
}

function appointmentFact(clinicId: string, r: AppointmentRow): AppointmentFact {
  return {
    clinicId,
    id: r.id,
    patientId: r.patient_id,
    dentistId: r.dentist_id,
    scheduledAt: r.scheduled_at,
    bookedAt: r.created_at,
    durationMinutes: r.duration_minutes,
    status: r.status as LedgerAppointmentStatus,
    source: r.source,
    originFollowUpId: r.follow_up_id,
  };
}

function appointmentEventFact(clinicId: string, r: AppointmentEventRow): AppointmentEventFact {
  return {
    clinicId,
    id: r.id,
    appointmentId: r.appointment_id,
    action: r.action,
    at: r.timestamp,
    statusAfter: r.status_after,
    previousScheduledAt: r.previous_scheduled_at,
  };
}

function treatmentFact(clinicId: string, r: TreatmentRow): TreatmentFact {
  const like = {
    status: r.status,
    cost: Number(r.cost ?? 0),
    opd_charged: r.opd_charged ?? false,
    opd_fee: Number(r.opd_fee ?? 0),
    xray_taken: r.xray_taken ?? false,
    xray_cost: r.xray_cost === null ? null : Number(r.xray_cost),
  };
  return {
    clinicId,
    id: r.id,
    patientId: r.patient_id,
    recordedAtAppointmentId: r.appointment_id,
    treatmentType: r.treatment_type,
    status: r.status as LedgerTreatmentStatus,
    // Every figure comes from lib/billing/balance, so a charge read through the
    // ledger can never disagree with the balance shown anywhere else in the app.
    charge: {
      treatment: isBillableTreatment(r.status) ? like.cost : 0,
      consultation: opdChargeFor(like),
      radiograph: xrayChargeFor(like),
      total: treatmentTotalCharge(like),
      quoted: like.cost,
    },
    performedAt: r.performed_at,
    recordedAt: r.created_at,
    consultantId: r.consultant_id,
  };
}

function treatmentEventFact(clinicId: string, r: TreatmentEventRow): TreatmentEventFact {
  return {
    clinicId,
    id: r.id,
    treatmentId: r.treatment_id,
    patientId: r.patient_id,
    action: r.action,
    at: r.timestamp,
    statusAfter: r.status_after,
  };
}

function queueFact(clinicId: string, r: QueueRow): QueueVisitFact {
  return {
    clinicId,
    id: r.id,
    appointmentId: r.appointment_id,
    patientId: r.patient_id,
    queueDate: r.queue_date,
    status: r.status as LedgerQueueStatus,
    checkedInAt: r.checked_in_at,
    calledAt: r.called_at,
    completedAt: r.completed_at,
  };
}

function followUpFact(clinicId: string, r: FollowUpRow): FollowUpFact {
  return {
    clinicId,
    id: r.id,
    patientId: r.patient_id,
    originAppointmentId: r.appointment_id,
    treatmentId: r.treatment_id,
    dueDate: r.due_date,
    status: r.status as LedgerFollowUpStatus,
    confirmation: r.confirmation_status,
    followUpType: r.follow_up_type,
    recordedAt: r.created_at,
    lastChangedAt: r.updated_at,
  };
}

function paymentFact(clinicId: string, r: PaymentRow): PaymentFact {
  return {
    clinicId,
    id: r.id,
    patientId: r.patient_id,
    appointmentId: r.appointment_id,
    treatmentId: r.treatment_id,
    amount: Number(r.amount),
    paymentDate: r.payment_date,
    method: r.method,
  };
}

function reminderFact(clinicId: string, r: ReminderRow): ReminderSendFact {
  return { clinicId, id: r.id, patientId: r.patient_id, kind: r.kind, sentAt: r.sent_at };
}

function completionFact(clinicId: string, r: CompletionRow): ActionCompletionFact {
  return {
    clinicId,
    id: r.id,
    category: r.category,
    constraintId: r.constraint_id,
    completedAt: r.completed_at,
    source: r.source === "inferred" ? "inferred" : "declared",
    targetPatientIds: r.target_patient_ids ?? [],
  };
}

export interface ClinicLedgerOptions {
  /**
   * Fact kinds this session must not be asked for, and must report as
   * withheld rather than empty. Pass `action_completion` for any non-dentist
   * session: RLS returns zero rows rather than an error, and zero rows would
   * read as "no action ever targeted this patient".
   *
   * Only kinds whose absence breaks no other read may be withheld; a withheld
   * patient or appointment would leave nothing to anchor the slice to.
   */
  readonly withhold?: readonly WithholdableKind[];
}

/** Kinds that can be left unread without invalidating the rest of a slice. */
export type WithholdableKind =
  | typeof LedgerFactKind.ACTION_COMPLETION
  | typeof LedgerFactKind.REMINDER_SEND
  | typeof LedgerFactKind.TREATMENT_EVENT;

export class SupabaseClinicLedger extends SupabaseDiagnosisContext implements ClinicLedgerPort {
  private readonly withhold: ReadonlySet<LedgerFactKind>;

  constructor(db: SupabaseClient<Database>, timezone: string = "UTC", options: ClinicLedgerOptions = {}) {
    super(db, timezone);
    this.withhold = new Set(options.withhold ?? []);
  }

  /** Run a read unless its kind is withheld, in which case it is not sent at all. */
  private unlessWithheld<T>(kind: LedgerFactKind, readRows: () => Promise<T[]>): Promise<T[]> {
    return this.withhold.has(kind) ? Promise.resolve([]) : readRows();
  }

  /**
   * Everything the ledger holds for a bounded set of patients, as of `asOf`.
   *
   * Membership bounds per kind — each the ECONOMIC moment, matching the
   * aggregate snapshot where the two overlap, so the two paths cannot disagree
   * about what existed:
   *
   *   appointments      booked (`created_at`) by asOf
   *   treatments        performed by asOf, or recorded by asOf (backdating)
   *   payments          `payment_date` on or before asOf's clinic-local date
   *   everything else   created / sent / checked in / completed by asOf
   */
  async readPatientLedger(scope: PatientLedgerScope): Promise<ClinicLedgerSlice> {
    assertScope(scope);
    const requested = distinct(scope.patientIds);
    if (requested.length > MAX_LEDGER_PATIENTS) {
      throw new RangeError(
        `A patient ledger read may name at most ${MAX_LEDGER_PATIENTS} patients; got ${requested.length}.`,
      );
    }
    if (requested.length === 0) return { ...emptySlice(scope), withheld: [...this.withhold] };

    const { clinicId, asOf, limit } = scope;
    const fetchLimit = limit + 1;

    const patientRows = await this.readPatients(clinicId, requested, asOf);
    const live = patientRows.map((p) => p.id);
    const liveSet = new Set(live);
    const unresolvedPatientIds = requested.filter((id) => !liveSet.has(id));
    if (live.length === 0) return { ...emptySlice(scope, unresolvedPatientIds), withheld: [...this.withhold] };

    const asOfDate = localDateOf(asOf, this.timezone);

    const [
      appointmentRows,
      treatmentRows,
      queueRows,
      followUpRows,
      paymentRows,
      reminderRows,
      treatmentEventRows,
      completionRows,
    ] = await Promise.all([
      readWindow<AppointmentRow>(
        "appointments",
        (from, to) =>
          this.db
          .from("appointments")
          .select(APPOINTMENT_COLUMNS)
          .eq("clinic_id", clinicId)
          .is("deleted_at", null)
          .in("patient_id", live)
          .lte("created_at", asOf)
          .order("scheduled_at", { ascending: true })
          .order("id", { ascending: true })
          
            .range(from, to),
        fetchLimit,
      ),
      readWindow<TreatmentRow>(
        "treatments",
        (from, to) =>
          this.db
          .from("treatments")
          .select(TREATMENT_COLUMNS)
          .eq("clinic_id", clinicId)
          .is("deleted_at", null)
          .in("patient_id", live)
          .or(`performed_at.lte.${asOf},created_at.lte.${asOf}`)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          
            .range(from, to),
        fetchLimit,
      ),
      readWindow<QueueRow>(
        "queue_entries",
        (from, to) =>
          this.db
          .from("queue_entries")
          .select(QUEUE_COLUMNS)
          .eq("clinic_id", clinicId)
          .in("patient_id", live)
          .lte("checked_in_at", asOf)
          .order("checked_in_at", { ascending: true })
          .order("id", { ascending: true })
          
            .range(from, to),
        fetchLimit,
      ),
      readWindow<FollowUpRow>(
        "follow_ups",
        (from, to) =>
          this.db
          .from("follow_ups")
          .select(FOLLOW_UP_COLUMNS)
          .eq("clinic_id", clinicId)
          .is("deleted_at", null)
          .in("patient_id", live)
          .lte("created_at", asOf)
          .order("due_date", { ascending: true })
          .order("id", { ascending: true })
          
            .range(from, to),
        fetchLimit,
      ),
      readWindow<PaymentRow>(
        "payments",
        (from, to) =>
          this.db
          .from("payments")
          .select(PAYMENT_COLUMNS)
          .eq("clinic_id", clinicId)
          .is("deleted_at", null)
          .in("patient_id", live)
          .lte("payment_date", asOfDate)
          .order("payment_date", { ascending: true })
          .order("id", { ascending: true })
          
            .range(from, to),
        fetchLimit,
      ),
      this.unlessWithheld(LedgerFactKind.REMINDER_SEND, () =>
        readWindow<ReminderRow>(
          "reminder_logs",
          (from, to) =>
            this.db
            .from("reminder_logs")
            .select(REMINDER_COLUMNS)
            .eq("clinic_id", clinicId)
            .in("patient_id", live)
            .lte("sent_at", asOf)
            .order("sent_at", { ascending: true })
            .order("id", { ascending: true })
            
              .range(from, to),
          fetchLimit,
        ),
      ),
      this.unlessWithheld(LedgerFactKind.TREATMENT_EVENT, () =>
        readWindow<TreatmentEventRow>(
          "treatment_history",
          (from, to) =>
            this.db
            .from("treatment_history")
            .select(TREATMENT_EVENT_COLUMNS)
            .eq("clinic_id", clinicId)
            .in("patient_id", live)
            .lte("timestamp", asOf)
            .order("timestamp", { ascending: true })
            .order("id", { ascending: true })
            
              .range(from, to),
          fetchLimit,
        ),
      ),
      this.unlessWithheld(LedgerFactKind.ACTION_COMPLETION, () =>
        readWindow<CompletionRow>(
          "action_completions",
          (from, to) =>
            this.db
            .from("action_completions")
            .select(COMPLETION_COLUMNS)
            .eq("clinic_id", clinicId)
            .overlaps("target_patient_ids", live)
            .lte("completed_at", asOf)
            .order("completed_at", { ascending: true })
            .order("id", { ascending: true })
            
              .range(from, to),
          fetchLimit,
        ),
      ),
    ]);

    const appointments = capped(appointmentRows, limit);
    const treatments = capped(treatmentRows, limit);

    const eventRows = await this.readAppointmentEvents(
      appointments.rows.map((a) => a.id),
      asOf,
      fetchLimit,
    );

    return this.assemble(scope, {
      patients: patientRows,
      appointments,
      appointmentEvents: capped(eventRows, limit),
      treatments,
      treatmentEvents: capped(treatmentEventRows, limit),
      queueVisits: capped(queueRows, limit),
      followUps: capped(followUpRows, limit),
      payments: capped(paymentRows, limit),
      reminderSends: capped(reminderRows, limit),
      actionCompletions: capped(completionRows, limit),
      unresolvedPatientIds,
    });
  }

  /**
   * Appointments scheduled in a clinic-local date window, and everything
   * attached to them: their patients, queue visits, history, the treatments
   * recorded at them (with those treatments' payments, follow-ups and history),
   * the follow-ups they came from, and reminders and completions inside the
   * window for the same patients / clinic.
   *
   * An appointment whose patient is no longer live is dropped with everything
   * hanging from it. The patient cascade soft-deletes those appointments anyway;
   * this is the guard for a row the cascade missed, because a window read is
   * exactly where a deleted patient's visit would otherwise resurface.
   */
  async readAppointmentWindow(scope: AppointmentWindowScope): Promise<ClinicLedgerSlice> {
    assertScope(scope);
    if (scope.from > scope.to) {
      throw new RangeError(`Ledger window starts after it ends: ${scope.from} > ${scope.to}.`);
    }
    const { clinicId, asOf, limit } = scope;
    const fetchLimit = limit + 1;
    const start = getUtcBoundariesForLocalDate(scope.from, this.timezone).start;
    const end = getUtcBoundariesForLocalDate(scope.to, this.timezone).end;

    const windowAppointments = capped(
      await readWindow<AppointmentRow>(
        "appointments",
        (from, to) =>
          this.db
          .from("appointments")
          .select(APPOINTMENT_COLUMNS)
          .eq("clinic_id", clinicId)
          .is("deleted_at", null)
          .gte("scheduled_at", start)
          .lte("scheduled_at", end)
          .lte("created_at", asOf)
          .order("scheduled_at", { ascending: true })
          .order("id", { ascending: true })
          
            .range(from, to),
        fetchLimit,
      ),
      limit,
    );
    if (windowAppointments.rows.length === 0) {
      return {
      ...emptySlice(scope),
      truncated: windowAppointments.truncated ? [LedgerFactKind.APPOINTMENT] : [],
      withheld: [...this.withhold],
    };
    }

    const patientRows = await this.readPatients(
      clinicId,
      distinct(windowAppointments.rows.map((a) => a.patient_id)),
      null,
    );
    const livePatients = new Set(patientRows.map((p) => p.id));
    const appointmentRows = windowAppointments.rows.filter((a) => livePatients.has(a.patient_id));
    const appointmentIds = appointmentRows.map((a) => a.id);
    const patientIds = [...livePatients];

    const [queueRows, eventRows, treatmentRows] = await Promise.all([
      this.readByIds<QueueRow>("queue_entries", appointmentIds, (ids, from, to) =>
        this.db
          .from("queue_entries")
          .select(QUEUE_COLUMNS)
          .eq("clinic_id", clinicId)
          .in("appointment_id", ids)
          .lte("checked_in_at", asOf)
          .order("checked_in_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
        fetchLimit,
      ),
      this.readAppointmentEvents(appointmentIds, asOf, fetchLimit),
      this.readByIds<TreatmentRow>("treatments", appointmentIds, (ids, from, to) =>
        this.db
          .from("treatments")
          .select(TREATMENT_COLUMNS)
          .eq("clinic_id", clinicId)
          .is("deleted_at", null)
          .in("appointment_id", ids)
          .or(`performed_at.lte.${asOf},created_at.lte.${asOf}`)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
        fetchLimit,
      ),
    ]);

    const treatments = capped(treatmentRows, limit);
    const treatmentIds = treatments.rows.map((t) => t.id);
    const originFollowUpIds = distinct(appointmentRows.map((a) => a.follow_up_id));

    const followUpQuery = (column: "id" | "appointment_id" | "treatment_id", ids: readonly string[]) =>
      this.readByIds<FollowUpRow>(`follow_ups by ${column}`, ids, (chunk, from, to) =>
        this.db
          .from("follow_ups")
          .select(FOLLOW_UP_COLUMNS)
          .eq("clinic_id", clinicId)
          .is("deleted_at", null)
          .in(column, chunk)
          .lte("created_at", asOf)
          .order("id", { ascending: true })
          .range(from, to),
        fetchLimit,
      );
    const paymentQuery = (column: "appointment_id" | "treatment_id", ids: readonly string[]) =>
      this.readByIds<PaymentRow>(`payments by ${column}`, ids, (chunk, from, to) =>
        this.db
          .from("payments")
          .select(PAYMENT_COLUMNS)
          .eq("clinic_id", clinicId)
          .is("deleted_at", null)
          .in(column, chunk)
          .lte("payment_date", localDateOf(asOf, this.timezone))
          .order("id", { ascending: true })
          .range(from, to),
        fetchLimit,
      );

    const [
      followUpsById,
      followUpsByAppointment,
      followUpsByTreatment,
      paymentsByAppointment,
      paymentsByTreatment,
      treatmentEventRows,
      reminderRows,
      completionRows,
    ] = await Promise.all([
      followUpQuery("id", originFollowUpIds),
      followUpQuery("appointment_id", appointmentIds),
      followUpQuery("treatment_id", treatmentIds),
      paymentQuery("appointment_id", appointmentIds),
      paymentQuery("treatment_id", treatmentIds),
      this.unlessWithheld(LedgerFactKind.TREATMENT_EVENT, () =>
        this.readByIds<TreatmentEventRow>("treatment_history", treatmentIds, (ids, from, to) =>
          this.db
            .from("treatment_history")
            .select(TREATMENT_EVENT_COLUMNS)
            .eq("clinic_id", clinicId)
            .in("treatment_id", ids)
            .lte("timestamp", asOf)
            .order("timestamp", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to),
          fetchLimit,
        ),
      ),
      this.unlessWithheld(LedgerFactKind.REMINDER_SEND, () =>
        this.readByIds<ReminderRow>("reminder_logs", patientIds, (ids, from, to) =>
          this.db
            .from("reminder_logs")
            .select(REMINDER_COLUMNS)
            .eq("clinic_id", clinicId)
            .in("patient_id", ids)
            .gte("sent_at", start)
            .lte("sent_at", end)
            .lte("sent_at", asOf)
            .order("sent_at", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to),
          fetchLimit,
        ),
      ),
      this.unlessWithheld(LedgerFactKind.ACTION_COMPLETION, () =>
        readWindow<CompletionRow>(
          "action_completions",
          (from, to) =>
            this.db
            .from("action_completions")
            .select(COMPLETION_COLUMNS)
            .eq("clinic_id", clinicId)
            .gte("completed_at", start)
            .lte("completed_at", end)
            .lte("completed_at", asOf)
            .order("completed_at", { ascending: true })
            .order("id", { ascending: true })
              .range(from, to),
          fetchLimit,
        ),
      ),
    ]);

    const sortById = <T extends { id: string }>(items: T[]) =>
      items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    // A follow-up or payment reached through an appointment or treatment can
    // still belong to a patient outside the window's live set only through bad
    // data; keep the slice self-contained rather than carrying a dangling patient.
    const inSlice = <T extends { patient_id: string }>(items: T[]) =>
      items.filter((row) => livePatients.has(row.patient_id));

    return this.assemble(scope, {
      patients: patientRows,
      appointments: { rows: appointmentRows, truncated: windowAppointments.truncated },
      appointmentEvents: capped(eventRows, limit),
      treatments,
      treatmentEvents: capped(treatmentEventRows, limit),
      queueVisits: capped(queueRows, limit),
      followUps: capped(
        inSlice(sortById(uniqueById([...followUpsById, ...followUpsByAppointment, ...followUpsByTreatment]))),
        limit,
      ),
      payments: capped(inSlice(sortById(uniqueById([...paymentsByAppointment, ...paymentsByTreatment]))), limit),
      reminderSends: capped(reminderRows, limit),
      actionCompletions: capped(completionRows, limit),
      unresolvedPatientIds: [],
    });
  }

  /**
   * Live patients among `ids`, with contactability reduced to two booleans.
   *
   * Communications consent is read from `patient_data_consent_state` — the
   * latest decision per patient and category — exactly as the reminder send list
   * reads it. A patient whose latest decision is `withdrawn` is flagged, and
   * every outreach population leaves them out.
   */
  private async readPatients(
    clinicId: string,
    ids: readonly string[],
    asOf: string | null,
  ): Promise<PatientRow[]> {
    if (ids.length === 0) return [];
    const [patients, withdrawals] = await Promise.all([
      this.readByIds<PatientQueryRow>("patients", ids, (chunk, from, to) => {
        const query = this.db
          .from("patients")
          .select(PATIENT_COLUMNS)
          .eq("clinic_id", clinicId)
          .is("deleted_at", null)
          .in("id", chunk);
        return (asOf === null ? query : query.lte("created_at", asOf)).order("id", { ascending: true }).range(from, to);
      }),
      this.readByIds<{ patient_id: string }>("patient_data_consent_state", ids, (chunk, from, to) =>
        this.db
          .from("patient_data_consent_state")
          .select("patient_id")
          .eq("clinic_id", clinicId)
          .eq("category", "communications")
          .eq("decision", "withdrawn")
          .in("patient_id", chunk)
          .order("patient_id", { ascending: true })
          .range(from, to),
      ),
    ]);
    const withdrawn = new Set(withdrawals.map((w) => w.patient_id));
    return patients.map((p) => ({
      id: p.id,
      created_at: p.created_at,
      payment_plan_until: p.payment_plan_until,
      reachable_by_phone: isWhatsAppReachable(p.phone),
      communications_withdrawn: withdrawn.has(p.id),
    }));
  }

  /**
   * When the clinic is open, per clinic-local date, for a range.
   *
   * Spans come from `openSpansOnDate`, the same helper whose minute totals every
   * utilization metric divides by, and are converted to UTC instants in the
   * clinic's timezone. The typical appointment length is reported as configured
   * or null — never silently defaulted.
   */
  async readCapacityWindow(scope: CapacityWindowScope): Promise<CapacityWindowFact> {
    if (scope.from > scope.to) {
      throw new RangeError(`Capacity window starts after it ends: ${scope.from} > ${scope.to}.`);
    }
    const [settingsResult, inputs] = await Promise.all([
      this.db
        .from("clinic_settings")
        .select("chair_count, average_appointment_duration")
        .eq("clinic_id", scope.clinicId)
        .maybeSingle(),
      fetchScheduleInputs(this.db, scope.clinicId, scope.from, scope.to),
    ]);
    if (settingsResult.error) {
      throw new Error(`clinic ledger (clinic_settings): ${settingsResult.error.message}`);
    }
    const settings = settingsResult.data as { chair_count: number | null; average_appointment_duration: number | null } | null;
    const hhmm = (minutes: number) =>
      `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    const instant = (date: string, minutes: number) =>
      zonedDateToUTC(`${date}T${hhmm(minutes)}:00`, this.timezone).toISOString();

    return {
      clinicId: scope.clinicId,
      from: scope.from,
      to: scope.to,
      timezone: this.timezone,
      chairCount: Math.max(1, settings?.chair_count ?? 1),
      typicalAppointmentMinutes:
        settings?.average_appointment_duration && settings.average_appointment_duration > 0
          ? settings.average_appointment_duration
          : null,
      availabilityConfigured: inputs.rulesByDow.size > 0,
      days: dateRange(scope.from, scope.to).map((date) => {
        const spans = openSpansOnDate(date, inputs);
        const bounds = getUtcBoundariesForLocalDate(date, this.timezone);
        return {
          date,
          startsAt: bounds.start,
          endsAt: bounds.end,
          openSpans: spans.map(([start, end]) => ({ start: instant(date, start), end: instant(date, end) })),
          openMinutesPerChair: spans.reduce((sum, [start, end]) => sum + (end - start), 0),
        };
      }),
    };
  }

  /**
   * Patients with open work, loaded whole. See {@link OpenWorkScope} for the
   * three rules; each is a plain read of the patient's own rows.
   *
   * The balance rule loads every live charge and payment in the clinic — the
   * same unbounded read the aggregate snapshot already makes for
   * `revenue.outstanding` — because a balance cannot be judged from part of a
   * ledger. Only patient ids leave that computation.
   */
  async readOpenWorkLedger(scope: OpenWorkScope): Promise<ClinicLedgerSlice> {
    if (!Number.isInteger(scope.maxPatients) || scope.maxPatients < 1) {
      throw new RangeError(`Open-work maxPatients must be a positive integer, got ${scope.maxPatients}.`);
    }
    const { clinicId, asOf } = scope;
    const asOfDate = localDateOf(asOf, this.timezone);

    const [planned, overdue, charges, payments] = await Promise.all([
      // Whole or refused: a balance judged from part of a ledger is a wrong balance.
      readAll<{ patient_id: string }>(
        "clinic ledger (open work: planned treatments)",
        (from, to) =>
          this.db
            .from("treatments")
            .select("patient_id")
            .eq("clinic_id", clinicId)
            .is("deleted_at", null)
            .eq("status", "planned")
            .lte("created_at", asOf)
            .order("id", { ascending: true })
            .range(from, to),
        MAX_OPEN_WORK_ROWS,
      ),
      readAll<{ patient_id: string }>(
        "clinic ledger (open work: overdue follow-ups)",
        (from, to) =>
          this.db
            .from("follow_ups")
            .select("patient_id")
            .eq("clinic_id", clinicId)
            .is("deleted_at", null)
            .eq("status", "pending")
            .lt("due_date", asOfDate)
            .lte("created_at", asOf)
            .order("id", { ascending: true })
            .range(from, to),
        MAX_OPEN_WORK_ROWS,
      ),
      readAll<Omit<TreatmentRow, "id" | "appointment_id" | "treatment_type" | "created_at" | "consultant_id" | "performed_at">>(
        "clinic ledger (open work: charges)",
        (from, to) =>
          this.db
            .from("treatments")
            .select("patient_id, status, cost, opd_charged, opd_fee, xray_taken, xray_cost")
            .eq("clinic_id", clinicId)
            .is("deleted_at", null)
            .or(`performed_at.lte.${asOf},created_at.lte.${asOf}`)
            .order("id", { ascending: true })
            .range(from, to),
        MAX_OPEN_WORK_ROWS,
      ),
      readAll<{ patient_id: string; amount: number | string }>(
        "clinic ledger (open work: payments)",
        (from, to) =>
          this.db
            .from("payments")
            .select("patient_id, amount")
            .eq("clinic_id", clinicId)
            .is("deleted_at", null)
            .lte("payment_date", asOfDate)
            .order("id", { ascending: true })
            .range(from, to),
        MAX_OPEN_WORK_ROWS,
      ),
    ]);

    const charged = new Map<string, number>();
    for (const t of charges) {
      const total = treatmentTotalCharge({
        status: t.status,
        cost: Number(t.cost ?? 0),
        opd_charged: t.opd_charged ?? false,
        opd_fee: Number(t.opd_fee ?? 0),
        xray_taken: t.xray_taken ?? false,
        xray_cost: t.xray_cost === null ? null : Number(t.xray_cost),
      });
      if (total > 0) charged.set(t.patient_id, (charged.get(t.patient_id) ?? 0) + total);
    }
    const paid = new Map<string, number>();
    for (const p of payments) paid.set(p.patient_id, (paid.get(p.patient_id) ?? 0) + Number(p.amount));
    const owing = [...charged].filter(([id, total]) => total - (paid.get(id) ?? 0) > 0).map(([id]) => id);

    // Sorted so the cut, when it bites, is deterministic — and reported, never silent.
    const discovered = distinct([...planned.map((r) => r.patient_id), ...overdue.map((r) => r.patient_id), ...owing]).sort();
    const loaded = discovered.slice(0, scope.maxPatients);
    const patientScope: PatientLedgerScope = {
      kind: "patients",
      clinicId,
      patientIds: loaded,
      asOf,
      limit: scope.limit,
    };
    if (loaded.length === 0) return { ...emptySlice(patientScope), withheld: [...this.withhold] };

    const pages: ClinicLedgerSlice[] = [];
    for (const page of chunks(loaded, MAX_LEDGER_PATIENTS)) {
      pages.push(await this.readPatientLedger({ ...patientScope, patientIds: page }));
    }
    const merged = mergeSlices(patientScope, pages);
    return discovered.length > loaded.length
      ? { ...merged, truncated: distinctKinds([...merged.truncated, LedgerFactKind.PATIENT]) }
      : merged;
  }

  /** `appointment_history` for appointments already loaded under a clinic predicate. */
  private readAppointmentEvents(
    appointmentIds: readonly string[],
    asOf: string,
    fetchLimit: number,
  ): Promise<AppointmentEventRow[]> {
    return this.readByIds<AppointmentEventRow>(
      "appointment_history",
      appointmentIds,
      (ids, from, to) =>
        this.db
          .from("appointment_history")
          .select(APPOINTMENT_EVENT_COLUMNS)
          .in("appointment_id", ids)
          .lte("timestamp", asOf)
          .order("timestamp", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      fetchLimit,
    );
  }

  /**
   * Run an ordered query per id chunk, paged, and concatenate. Returns [] for no
   * ids without a round-trip. Each chunk returns at most `perChunkLimit` rows; a
   * caller that caps the total passes its own fetch limit, so a cut chunk still
   * surfaces as more than the caller's limit.
   */
  private async readByIds<T>(
    label: string,
    ids: readonly string[],
    query: (chunk: string[], from: number, to: number) => QueryResult,
    perChunkLimit: number = MAX_OPEN_WORK_ROWS,
  ): Promise<T[]> {
    if (ids.length === 0) return [];
    const parts = await Promise.all(
      chunks(ids, ID_CHUNK).map(
        async (chunk) => (await readUpTo<T>(`clinic ledger (${label})`, (from, to) => query(chunk, from, to), perChunkLimit)).rows,
      ),
    );
    return parts.flat();
  }

  /**
   * Turn capped rows into a slice, propagating liveness to the tables that have
   * no `deleted_at` and marking a child kind truncated whenever its parent was —
   * a child whose parent may have been cut cannot be told apart from a child
   * whose parent was deleted.
   */
  private assemble(
    scope: LedgerScope,
    input: {
      patients: PatientRow[];
      appointments: { rows: AppointmentRow[]; truncated: boolean };
      appointmentEvents: { rows: AppointmentEventRow[]; truncated: boolean };
      treatments: { rows: TreatmentRow[]; truncated: boolean };
      treatmentEvents: { rows: TreatmentEventRow[]; truncated: boolean };
      queueVisits: { rows: QueueRow[]; truncated: boolean };
      followUps: { rows: FollowUpRow[]; truncated: boolean };
      payments: { rows: PaymentRow[]; truncated: boolean };
      reminderSends: { rows: ReminderRow[]; truncated: boolean };
      actionCompletions: { rows: CompletionRow[]; truncated: boolean };
      unresolvedPatientIds: readonly string[];
    },
  ): ClinicLedgerSlice {
    const { clinicId } = scope;
    const liveAppointments = new Set(input.appointments.rows.map((a) => a.id));
    const liveTreatments = new Set(input.treatments.rows.map((t) => t.id));

    const queueVisits = input.queueVisits.rows.filter((q) => liveAppointments.has(q.appointment_id));
    const appointmentEvents = input.appointmentEvents.rows.filter((e) => liveAppointments.has(e.appointment_id));
    const treatmentEvents = input.treatmentEvents.rows.filter((e) => liveTreatments.has(e.treatment_id));

    const truncated: LedgerFactKind[] = [];
    const flag = (kind: LedgerFactKind, when: boolean) => {
      if (when) truncated.push(kind);
    };
    flag(LedgerFactKind.APPOINTMENT, input.appointments.truncated);
    flag(
      LedgerFactKind.APPOINTMENT_EVENT,
      input.appointmentEvents.truncated || input.appointments.truncated,
    );
    flag(LedgerFactKind.TREATMENT, input.treatments.truncated);
    flag(LedgerFactKind.TREATMENT_EVENT, input.treatmentEvents.truncated || input.treatments.truncated);
    flag(LedgerFactKind.QUEUE_VISIT, input.queueVisits.truncated || input.appointments.truncated);
    flag(LedgerFactKind.FOLLOW_UP, input.followUps.truncated);
    flag(LedgerFactKind.PAYMENT, input.payments.truncated);
    flag(LedgerFactKind.REMINDER_SEND, input.reminderSends.truncated);
    flag(LedgerFactKind.ACTION_COMPLETION, input.actionCompletions.truncated);

    return {
      clinicId,
      scope,
      patients: input.patients.map((r) => patientFact(clinicId, r)),
      appointments: input.appointments.rows.map((r) => appointmentFact(clinicId, r)),
      appointmentEvents: appointmentEvents.map((r) => appointmentEventFact(clinicId, r)),
      treatments: input.treatments.rows.map((r) => treatmentFact(clinicId, r)),
      treatmentEvents: treatmentEvents.map((r) => treatmentEventFact(clinicId, r)),
      queueVisits: queueVisits.map((r) => queueFact(clinicId, r)),
      followUps: input.followUps.rows.map((r) => followUpFact(clinicId, r)),
      payments: input.payments.rows.map((r) => paymentFact(clinicId, r)),
      reminderSends: input.reminderSends.rows.map((r) => reminderFact(clinicId, r)),
      actionCompletions: input.actionCompletions.rows.map((r) => completionFact(clinicId, r)),
      truncated: truncated.filter((kind) => !this.withhold.has(kind)),
      withheld: [...this.withhold],
      unresolvedPatientIds: input.unresolvedPatientIds,
    };
  }
}
