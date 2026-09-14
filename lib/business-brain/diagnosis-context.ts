/**
 * Supabase adapter for the Diagnosis Engine's entity-level context port.
 *
 * The Diagnosis Engine reasons over daily aggregates, which is enough to notice
 * that something is wrong but often not enough to say WHICH of several
 * explanations fits. Its `requires_entity_data` discriminators need exactly this:
 * individual cancellations, individual unpaid balances, individual visits.
 *
 * Same split as the other adapters — the port lives in `business-brain/` and
 * knows nothing about Postgres; this is the only place these tables are read.
 *
 * ## What this deployment can and cannot answer
 *
 * All six methods are answerable from DentGrow's schema. A seventh,
 * `listRecallContactAttempts`, was removed in the ledger tranche: it could only
 * ever return `null`, because nothing records a contact attempt against a
 * follow-up, and its discriminator is now catalogued as data capture.
 *
 * `SupabaseClinicLedger` extends this class with the general relational reads.
 *
 * Two of the six rest on documented approximations, noted at each method. Both
 * are the same shape as the approximation already accepted for `isScheduled`:
 * the direction of the error is known and stated, rather than the reading being
 * presented as exact.
 *
 * ## Whole windows or nothing
 *
 * Each method answers about its WHOLE window or refuses. When more rows exist
 * than `window.limit`, it throws an `EntityWindowTooLargeError` rather than
 * answering from the first N — an earliest-first (or newest-first) sample makes
 * a timing, ageing or concentration reading look complete while describing part
 * of the window. The service treats a refusal as "could not answer", which
 * leaves the discriminator undetermined: honest, and exactly what it was before
 * entity resolution existed. Every follow-up read (history, refills, prior
 * attendance, collections) is paged whole, under the PostgREST row cap.
 *
 * ## Clinic-local time
 *
 * Every date and hour handed to the engine is in the clinic's timezone. The
 * timestamps PostgREST returns are UTC instants; their date and hour digits are
 * the clinic's only when the clinic is in UTC.
 *
 * ## Read-only
 *
 * Every method here is a SELECT. The Diagnosis Engine is downstream of Metrics
 * and Signals, all of which are read-only, and nothing about explaining a
 * finding requires changing the clinic.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  AppointmentArrivalRow,
  CancellationEvent,
  CompletedTreatmentRow,
  DiagnosisContextPort,
  EntityWindow,
  NoShowHistoryRow,
  OutstandingBalanceRow,
  PendingTreatmentRow,
} from "@/business-brain";
import {
  MetricUnit,
  arrivalRecorded,
  canonicalTreatmentType,
  cancellationSide,
  groupableTreatmentType,
  noShowBasis,
  treatmentPerformedAt,
} from "@/business-brain";
import type { Database } from "@/types/database.types";
import { getUtcBoundariesForLocalDate } from "@/lib/utils";
import { treatmentTotalCharge } from "@/lib/billing/balance";
import {
  allocateCollectionsToTreatments,
  type PayoutPaymentLike,
  type PayoutTreatmentLike,
} from "@/lib/billing/payout";
import { readAll, readUpTo, type PageQuery } from "./paged-read";

/** Ids per `in (...)` list: long lists put the whole query in the URL. */
const ID_CHUNK = 100;
/** Most rows a whole follow-up read may return before it is refused. */
const MAX_FOLLOW_UP_ROWS = 250_000;

/** A window with more rows than its limit: answered about none of it rather than part of it. */
export class EntityWindowTooLargeError extends Error {
  constructor(label: string, limit: number) {
    super(`${label}: more than ${limit} rows in the window; not answered from part of it.`);
    this.name = "EntityWindowTooLargeError";
  }
}

/** Whole days between two "YYYY-MM-DD" dates, never negative. */
function ageInDays(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.max(0, Math.round(ms / 86_400_000));
}

function currency(value: number): { value: number; unit: MetricUnit } {
  return { value, unit: MetricUnit.CURRENCY };
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Inclusive UTC bounds for a window of CLINIC-LOCAL business dates.
 *
 * `window.from`/`window.to` are clinic-local dates, so the day boundaries must be
 * converted from the clinic's calendar, not UTC midnight — otherwise the window
 * edges shift by the clinic's offset and rows within ~offset hours of the
 * boundary are mis-included/excluded (audit: diagnosis-context UTC window). With
 * `timezone === "UTC"` this reproduces the previous byte-for-byte behaviour.
 */
function bounds(window: EntityWindow, timezone: string): { start: string; end: string } {
  return {
    start: getUtcBoundariesForLocalDate(window.from, timezone).start,
    end: getUtcBoundariesForLocalDate(window.to, timezone).end,
  };
}

export class SupabaseDiagnosisContext implements DiagnosisContextPort {
  protected readonly db: SupabaseClient<Database>;
  protected readonly timezone: string;
  private readonly dateFormat: Intl.DateTimeFormat;
  private readonly hourFormat: Intl.DateTimeFormat;

  /**
   * @param timezone Clinic IANA timezone for the business-date window bounds and
   *   every date and hour handed to the engine. Defaults to "UTC" so callers and
   *   tests that don't supply it keep UTC behaviour; production passes the real
   *   clinic timezone.
   */
  constructor(db: SupabaseClient<Database>, timezone: string = "UTC") {
    this.db = db;
    this.timezone = timezone;
    this.dateFormat = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    this.hourFormat = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" });
  }

  /** The clinic-local "YYYY-MM-DD" of an instant. */
  protected localDate(iso: string): string {
    return this.dateFormat.format(new Date(iso));
  }

  /** The clinic-local "HH:00" of an instant. */
  protected localHour(iso: string): string {
    return `${this.hourFormat.format(new Date(iso)).padStart(2, "0")}:00`;
  }

  /** The window's rows, whole, or a refusal when there are more than its limit. */
  private async windowRows<T>(label: string, page: PageQuery, limit: number): Promise<T[]> {
    const { rows, truncated } = await readUpTo<T>(label, page, limit);
    if (truncated) throw new EntityWindowTooLargeError(label, limit);
    return rows;
  }

  /** An ordered query over ids, chunked and paged whole. */
  private async byIds<T>(label: string, ids: readonly string[], page: (chunk: string[], from: number, to: number) => ReturnType<PageQuery>): Promise<T[]> {
    const out: T[] = [];
    for (const chunk of chunks([...new Set(ids)], ID_CHUNK)) {
      out.push(...(await readAll<T>(label, (from, to) => page(chunk, from, to), MAX_FOLLOW_UP_ROWS)));
    }
    return out;
  }

  /**
   * Money collected against each of a set of patients' billable treatments, as
   * of `asOfDate` — via the SAME oldest-first pooled allocation
   * `lib/billing/payout.ts` uses for consultant payouts, DentGrow's one
   * canonical answer to "which payments cover which treatment" when a payment
   * isn't linked to one.
   *
   * Reusing it here (instead of a `payments.treatment_id`-only join) is what
   * makes this adapter's per-treatment figures reconcile with the patient-level
   * `computeOutstandingBalance` (`lib/billing/balance.ts`) the rest of the app
   * uses: a lump-sum or appointment-level payment now settles a patient's
   * treatments the same way everywhere, instead of showing as collected in
   * `revenue.outstanding` but "unpaid" in this diagnosis evidence (audit:
   * diagnosis-context outstanding/collected mismatch).
   *
   * Loads EVERY billable treatment and payment the given patients have as of
   * `asOfDate` — paged whole, because allocation is oldest-first across a
   * patient's WHOLE ledger and allocating against a partial set could credit the
   * wrong treatment.
   */
  private async collectedByTreatment(
    clinicId: string,
    patientIds: readonly string[],
    asOfDate: string,
  ): Promise<Map<string, number>> {
    const collected = new Map<string, number>();
    if (patientIds.length === 0) return collected;

    const endOfDay = getUtcBoundariesForLocalDate(asOfDate, this.timezone).end;
    const [treatments, payments] = await Promise.all([
      this.byIds<PayoutTreatmentLike & { patient_id: string }>("collections (treatments)", patientIds, (chunk, from, to) =>
        this.db
          .from("treatments")
          .select("id, patient_id, cost, status, opd_charged, opd_fee, xray_taken, xray_cost, performed_at, created_at")
          .eq("clinic_id", clinicId)
          .is("deleted_at", null)
          .in("status", ["completed", "in_progress"])
          .in("patient_id", chunk)
          .lte("created_at", endOfDay)
          .order("id", { ascending: true })
          .range(from, to),
      ),
      this.byIds<PayoutPaymentLike & { patient_id: string | null }>("collections (payments)", patientIds, (chunk, from, to) =>
        this.db
          .from("payments")
          .select("id, patient_id, treatment_id, amount")
          .eq("clinic_id", clinicId)
          .is("deleted_at", null)
          .in("patient_id", chunk)
          .lte("payment_date", asOfDate)
          .order("id", { ascending: true })
          .range(from, to),
      ),
    ]);

    const treatmentsByPatient = new Map<string, (PayoutTreatmentLike & { patient_id: string })[]>();
    for (const t of treatments) {
      const list = treatmentsByPatient.get(t.patient_id) ?? [];
      list.push(t);
      treatmentsByPatient.set(t.patient_id, list);
    }

    const paymentsByPatient = new Map<string, PayoutPaymentLike[]>();
    for (const p of payments) {
      if (!p.patient_id) continue;
      const list = paymentsByPatient.get(p.patient_id) ?? [];
      list.push(p);
      paymentsByPatient.set(p.patient_id, list);
    }

    for (const [patientId, patientTreatments] of treatmentsByPatient) {
      const patientPayments = paymentsByPatient.get(patientId) ?? [];
      const allocation = allocateCollectionsToTreatments(patientTreatments, patientPayments);
      for (const [treatmentId, amount] of allocation) {
        collected.set(treatmentId, amount);
      }
    }
    return collected;
  }

  /**
   * Appointments booked and then lost, with how much notice was given and
   * whether the slot was recovered.
   *
   * `cancelledAt` comes from `appointment_history`, not from the appointment
   * row — there is no `cancelled_at` column, and the audit trail is the only
   * place the MOMENT of cancellation is recorded. That is exactly what
   * `cancellation_timing` needs: an appointment cancelled three weeks ahead and
   * one cancelled an hour before are the same row afterwards, and completely
   * different problems.
   *
   * A cancellation with no history row keeps `cancelledAt: null` rather than
   * falling back to the appointment's own timestamps. Guessing the notice period
   * would fabricate the exact quantity the discriminator exists to measure.
   *
   * No-shows carry no notice by definition — the patient simply did not arrive —
   * so `noticeHours` stays null for them rather than being reported as zero.
   */
  async listCancellationEvents(window: EntityWindow): Promise<readonly CancellationEvent[]> {
    const { start, end } = bounds(window, this.timezone);
    const lost = await this.windowRows<{ id: string; patient_id: string; dentist_id: string; scheduled_at: string; status: string }>(
      "cancellation events",
      (from, to) =>
        this.db
          .from("appointments")
          .select("id, patient_id, dentist_id, scheduled_at, status")
          .eq("clinic_id", window.clinicId)
          .is("deleted_at", null)
          .in("status", ["cancelled", "no_show"])
          .gte("scheduled_at", start)
          .lte("scheduled_at", end)
          .order("scheduled_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      window.limit,
    );
    if (lost.length === 0) return [];

    const ids = lost.map((a) => a.id);
    const [history, treatmentRows, refills, closures] = await Promise.all([
      this.byIds<{ id: string; appointment_id: string; action: string; new_value: unknown; timestamp: string; performed_by: string | null; performed_by_role: string | null }>(
        "cancellation history",
        ids,
        (chunk, from, to) =>
          this.db
            .from("appointment_history")
            .select("id, appointment_id, action, new_value, timestamp, performed_by, performed_by_role")
            .in("appointment_id", chunk)
            .order("timestamp", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to),
      ),
      this.byIds<{ id: string; appointment_id: string | null; treatment_type: string }>("cancellation treatments", ids, (chunk, from, to) =>
        this.db
          .from("treatments")
          .select("id, appointment_id, treatment_type")
          .eq("clinic_id", window.clinicId)
          .is("deleted_at", null)
          .in("appointment_id", chunk)
          .order("id", { ascending: true })
          .range(from, to),
      ),
      // Anything still live in the same slot, for the same dentist. If one
      // exists, the capacity was recovered and the cancellation cost nothing.
      // Read whole: a capped read made refilled slots look lost.
      readAll<{ dentist_id: string; scheduled_at: string }>(
        "slot refill",
        (from, to) =>
          this.db
            .from("appointments")
            .select("dentist_id, scheduled_at")
            .eq("clinic_id", window.clinicId)
            .is("deleted_at", null)
            .not("status", "in", "(cancelled,no_show)")
            .gte("scheduled_at", start)
            .lte("scheduled_at", end)
            .order("id", { ascending: true })
            .range(from, to),
        MAX_FOLLOW_UP_ROWS,
      ),
      // Days the clinic had marked closed: a staff cancellation on one is the
      // clinic's, not the patient's.
      readAll<{ date: string }>(
        "cancellation closures",
        (from, to) =>
          this.db
            .from("unavailable_dates")
            .select("date")
            .eq("clinic_id", window.clinicId)
            .gte("date", window.from)
            .lte("date", window.to)
            .order("date", { ascending: true })
            .range(from, to),
        MAX_FOLLOW_UP_ROWS,
      ),
    ]);
    const closedDays = new Set(closures.map((c) => c.date));

    // Earliest recorded cancellation per appointment: a record reopened and
    // re-cancelled should be dated from when the clinic first lost the slot —
    // and the side is read from that same row.
    const cancelledAt = new Map<string, string>();
    const cancelledByRole = new Map<string, string | null>();
    const statusChanges = new Map<string, { statusAfter: string | null; at: string; byPerson: boolean | null }[]>();
    for (const h of history) {
      const status = (h.new_value as { status?: string } | null)?.status;
      const changes = statusChanges.get(h.appointment_id) ?? [];
      changes.push({ statusAfter: status ?? null, at: h.timestamp, byPerson: h.performed_by !== null });
      statusChanges.set(h.appointment_id, changes);
      if (status !== "cancelled" && h.action !== "cancelled") continue;
      if (!cancelledAt.has(h.appointment_id)) {
        cancelledAt.set(h.appointment_id, h.timestamp);
        cancelledByRole.set(h.appointment_id, h.performed_by_role);
      }
    }

    // First recorded treatment type per appointment, by id order so the choice
    // is stable. Spellings of one type are one type; a consultation-only record
    // names no treatment.
    const treatmentType = new Map<string, string>();
    for (const t of treatmentRows) {
      const type = groupableTreatmentType(t.treatment_type);
      if (t.appointment_id && type !== null && !treatmentType.has(t.appointment_id)) {
        treatmentType.set(t.appointment_id, type);
      }
    }

    // Instants compared by value: the same moment can be spelled two ways.
    const filledSlots = new Set(refills.map((a) => `${a.dentist_id}|${Date.parse(a.scheduled_at)}`));

    return lost.map((a) => {
      const cancelled = a.status === "cancelled" ? (cancelledAt.get(a.id) ?? null) : null;
      const noticeHours =
        cancelled === null
          ? null
          : Math.max(
              0,
              Math.round(
                ((Date.parse(a.scheduled_at) - Date.parse(cancelled)) / 3_600_000) * 10,
              ) / 10,
            );
      return {
        appointmentId: a.id,
        date: this.localDate(a.scheduled_at),
        scheduledStart: a.scheduled_at,
        localHour: this.localHour(a.scheduled_at),
        cancelledAt: cancelled,
        noticeHours,
        outcome: a.status === "no_show" ? ("no_show" as const) : ("cancelled" as const),
        treatmentType: treatmentType.get(a.id) ?? null,
        slotRefilled: filledSlots.has(`${a.dentist_id}|${Date.parse(a.scheduled_at)}`),
        ...(a.status === "no_show"
          ? { noShowBasis: noShowBasis(statusChanges.get(a.id) ?? []) }
          : {
              side: cancellationSide({
                actorRole: cancelledByRole.get(a.id) ?? null,
                onClosedDay: closedDays.has(this.localDate(a.scheduled_at)),
              }),
            }),
      };
    });
  }

  /**
   * Prior attendance for each patient who failed to attend in the window.
   *
   * Counted STRICTLY BEFORE each missed appointment, not before the window. A
   * patient who missed twice this week should read as a first-time non-attender
   * on the first occasion and a repeat one on the second; counting from the
   * window's edge would make both look identical.
   */
  async listNoShowHistory(window: EntityWindow): Promise<readonly NoShowHistoryRow[]> {
    const { start, end } = bounds(window, this.timezone);
    const missed = await this.windowRows<{ id: string; patient_id: string; scheduled_at: string }>(
      "no-show history",
      (from, to) =>
        this.db
          .from("appointments")
          .select("id, patient_id, scheduled_at")
          .eq("clinic_id", window.clinicId)
          .is("deleted_at", null)
          .eq("status", "no_show")
          .gte("scheduled_at", start)
          .lte("scheduled_at", end)
          .order("scheduled_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      window.limit,
    );
    if (missed.length === 0) return [];

    const prior = await this.byIds<{ patient_id: string; scheduled_at: string; status: string }>(
      "no-show prior history",
      missed.map((m) => m.patient_id),
      (chunk, from, to) =>
        this.db
          .from("appointments")
          .select("patient_id, scheduled_at, status")
          .eq("clinic_id", window.clinicId)
          .is("deleted_at", null)
          .in("patient_id", chunk)
          .in("status", ["completed", "no_show"])
          .order("scheduled_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
    );

    const byPatient = new Map<string, { scheduledMs: number; status: string; scheduled_at: string }[]>();
    for (const a of prior) {
      const list = byPatient.get(a.patient_id) ?? [];
      list.push({ scheduledMs: Date.parse(a.scheduled_at), status: a.status, scheduled_at: a.scheduled_at });
      byPatient.set(a.patient_id, list);
    }

    return missed.map((m) => {
      const missedMs = Date.parse(m.scheduled_at);
      const history = (byPatient.get(m.patient_id) ?? [])
        .filter((a) => a.scheduledMs < missedMs)
        .sort((a, b) => a.scheduledMs - b.scheduledMs);
      const attended = history.filter((a) => a.status === "completed");
      return {
        patientId: m.patient_id,
        appointmentId: m.id,
        date: this.localDate(m.scheduled_at),
        priorAttended: attended.length,
        priorMissed: history.length - attended.length,
        lastAttendedDate:
          attended.length > 0 ? this.localDate(attended[attended.length - 1].scheduled_at) : null,
      };
    });
  }

  /**
   * Planned treatments whose patient has no next visit booked at the end of the
   * window.
   *
   * APPROXIMATION, in two places, both stated rather than hidden:
   *
   * `acceptedOn` is the treatment's `created_at`. DentGrow records no separate
   * date, and a planned treatment row is created when the clinic records the
   * plan, so the two coincide in ordinary use but are not the same field. This
   * is a recorded date, not a record that the patient agreed to anything.
   *
   * "Unscheduled" is resolved at the PATIENT level — does this patient have any
   * upcoming visit — because nothing links a planned treatment to the future
   * visit booked to deliver it (`treatments.appointment_id` is the visit the plan
   * was RECORDED at, not a booking). This is
   * the same approximation the `isScheduled` snapshot field already documents,
   * and it errs the same way: it UNDER-reports. Everything returned is genuinely
   * unbooked; some genuinely unbooked work is missed because the patient happens
   * to have an unrelated appointment.
   *
   * The whole planned book or nothing: an ageing distribution read from only the
   * newest plans would understate how old the backlog is.
   */
  async listPendingTreatments(window: EntityWindow): Promise<readonly PendingTreatmentRow[]> {
    const endOfWindow = getUtcBoundariesForLocalDate(window.to, this.timezone).end;
    const planned = await this.windowRows<{ id: string; patient_id: string; treatment_type: string; cost: number | string | null; created_at: string }>(
      "pending treatments",
      (from, to) =>
        this.db
          .from("treatments")
          .select("id, patient_id, treatment_type, cost, created_at")
          .eq("clinic_id", window.clinicId)
          .is("deleted_at", null)
          .eq("status", "planned")
          .lte("created_at", endOfWindow)
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to),
      window.limit,
    );
    if (planned.length === 0) return [];

    const bookedRows = await this.byIds<{ patient_id: string }>("pending treatments (booked)", planned.map((t) => t.patient_id), (chunk, from, to) =>
      this.db
        .from("appointments")
        .select("patient_id")
        .eq("clinic_id", window.clinicId)
        .is("deleted_at", null)
        .in("patient_id", chunk)
        .in("status", ["scheduled", "checked_in", "in_progress"])
        .gt("scheduled_at", endOfWindow)
        .order("id", { ascending: true })
        .range(from, to),
    );
    const booked = new Set(bookedRows.map((a) => a.patient_id));

    return planned
      .filter((t) => !booked.has(t.patient_id))
      .flatMap((t) => {
        // A planned consultation charge is not treatment work awaiting a visit.
        const treatmentType = groupableTreatmentType(t.treatment_type);
        if (treatmentType === null) return [];
        const acceptedOn = this.localDate(t.created_at);
        return [
          {
            treatmentId: t.id,
            patientId: t.patient_id,
            acceptedOn,
            ageDays: ageInDays(acceptedOn, window.to),
            treatmentType,
            quotedValue: currency(Number(t.cost ?? 0)),
          },
        ];
      });
  }

  /**
   * Unpaid balances outstanding at the end of the window.
   *
   * DentGrow has no invoices — billing and invoice generation are an explicit
   * MVP non-goal — so the TREATMENT is the billable unit and `invoiceId` is the
   * treatment's id. That is not a workaround: a treatment is what the patient
   * owes for, and inventing an invoice layer to satisfy a field name would add
   * a concept the product does not have.
   *
   * Billable is `completed` or `in_progress`, and the charge is cost + OPD +
   * X-ray via the shared `treatmentTotalCharge`, matching `lib/billing/balance.ts`
   * exactly (this file, unlike the pure metrics engine, is free to import it).
   * Payments are pooled per patient via `collectedByTreatment`, not restricted
   * to `payments.treatment_id`, so a lump-sum or appointment-level payment
   * settles the same way it does everywhere else in the app. Aligning with the
   * app's own definition matters more than any local choice: two screens
   * disagreeing about what a patient owes is worse than either definition being
   * wrong (audit: diagnosis-context outstanding formula).
   *
   * The whole billable book or nothing: ageing read from only the newest
   * treatments would understate how old the receivables are.
   *
   * Fully-paid treatments are omitted — an outstanding balance of zero is not
   * outstanding.
   */
  async listOutstandingBalances(window: EntityWindow): Promise<readonly OutstandingBalanceRow[]> {
    const endOfWindow = getUtcBoundariesForLocalDate(window.to, this.timezone).end;
    const billable = await this.windowRows<PayoutTreatmentLike & { patient_id: string; performed_at: string | null; created_at: string }>(
      "outstanding balances",
      (from, to) =>
        this.db
          .from("treatments")
          .select("id, patient_id, cost, status, opd_charged, opd_fee, xray_taken, xray_cost, performed_at, created_at")
          .eq("clinic_id", window.clinicId)
          .is("deleted_at", null)
          .in("status", ["completed", "in_progress"])
          .lte("created_at", endOfWindow)
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to),
      window.limit,
    );
    if (billable.length === 0) return [];

    const patientIds = [...new Set(billable.map((t) => t.patient_id))];
    const collected = await this.collectedByTreatment(window.clinicId, patientIds, window.to);

    return billable
      .map((t) => {
        const charge = treatmentTotalCharge(t);
        const amountPaid = collected.get(t.id) ?? 0;
        const outstanding = charge - amountPaid;
        // Dated from when the work was done, falling back to when the record was
        // raised for work still in progress.
        const raisedOn = this.localDate(t.performed_at ?? t.created_at);
        return {
          invoiceId: t.id,
          patientId: t.patient_id,
          raisedOn,
          ageDays: ageInDays(raisedOn, window.to),
          amountOutstanding: currency(outstanding),
          amountPaid: currency(amountPaid),
        };
      })
      .filter((row) => row.amountOutstanding.value > 0);
  }

  /**
   * Scheduled versus actual arrival for the window's appointments.
   *
   * Arrival is the queue check-in and "seen" is the moment the patient was
   * called; those are the only arrival facts DentGrow records. An appointment
   * that was never checked in keeps `arrivedAt: null` — it may have been a
   * no-show, or the front desk may simply not have used the queue, and the two
   * are indistinguishable from here. Reporting a null rather than choosing keeps
   * that ambiguity visible to the discriminator instead of resolving it wrongly.
   */
  async listAppointmentArrivals(window: EntityWindow): Promise<readonly AppointmentArrivalRow[]> {
    const { start, end } = bounds(window, this.timezone);
    const appointments = await this.windowRows<{ id: string; scheduled_at: string; duration_minutes: number }>(
      "appointment arrivals",
      (from, to) =>
        this.db
          .from("appointments")
          .select("id, scheduled_at, duration_minutes")
          .eq("clinic_id", window.clinicId)
          .is("deleted_at", null)
          .not("status", "in", "(cancelled)")
          .gte("scheduled_at", start)
          .lte("scheduled_at", end)
          .order("scheduled_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      window.limit,
    );
    if (appointments.length === 0) return [];

    const queue = await this.byIds<{ appointment_id: string; checked_in_at: string; called_at: string | null; completed_at: string | null }>(
      "appointment arrivals (queue)",
      appointments.map((a) => a.id),
      (chunk, from, to) =>
        this.db
          .from("queue_entries")
          .select("appointment_id, checked_in_at, called_at, completed_at")
          .eq("clinic_id", window.clinicId)
          .in("appointment_id", chunk)
          .order("checked_in_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
    );

    // First check-in wins, matching the metrics join: a re-queued patient arrived
    // when they first arrived.
    const arrivals = new Map<string, { checked_in_at: string; called_at: string | null; completed_at: string | null }>();
    for (const q of queue) {
      if (!arrivals.has(q.appointment_id)) arrivals.set(q.appointment_id, q);
    }

    return appointments.map((a) => {
      const entry = arrivals.get(a.id);
      // A visit clicked through to completion within a minute of its "check-in",
      // never called in, records no arrival: that timestamp is a button press.
      const arrived =
        entry !== undefined &&
        arrivalRecorded({ checkedInAt: entry.checked_in_at, calledAt: entry.called_at, completedAt: entry.completed_at });
      const arrivedAt = arrived ? entry.checked_in_at : null;
      return {
        appointmentId: a.id,
        date: this.localDate(a.scheduled_at),
        scheduledStart: a.scheduled_at,
        arrivedAt,
        arrivalLocalHour: arrivedAt === null ? null : this.localHour(arrivedAt),
        // Positive is late, negative is early.
        arrivalDeltaMinutes:
          arrivedAt === null
            ? null
            : Math.round((Date.parse(arrivedAt) - Date.parse(a.scheduled_at)) / 60_000),
        seenAt: entry?.called_at ?? null,
        finishedAt: entry?.completed_at ?? null,
        scheduledMinutes: a.duration_minutes,
        // Seen to finished. Null unless BOTH ends were recorded — an appointment
        // still in the chair, or one whose queue entry was never closed, has no
        // duration, and inventing one would fabricate the measurement. A negative
        // interval is bad data and is not clamped to a zero-minute visit.
        actualMinutes: (() => {
          if (!entry?.called_at || !entry.completed_at) return null;
          const minutes = Math.round((Date.parse(entry.completed_at) - Date.parse(entry.called_at)) / 60_000);
          return minutes < 0 ? null : minutes;
        })(),
      };
    });
  }

  /**
   * Treatments completed in the window, with what they billed and collected.
   *
   * Discriminates low revenue caused by a cheaper case mix from low revenue
   * caused by work that was done and not paid for — two problems with opposite
   * responses that look identical in a daily revenue total.
   *
   * Billed value is cost + OPD + X-ray via `treatmentTotalCharge`, matching
   * `lib/billing/balance.ts`. Collected value comes from `collectedByTreatment`,
   * which pools a patient's payments oldest-first the same way
   * `lib/billing/payout.ts` already does for consultant payouts — a clinic that
   * records a payment against the appointment rather than the treatment now
   * shows it collected, instead of every such payment reading as uncollected
   * here regardless of the clinic's real collection rate (audit:
   * diagnosis-context outstanding/collected mismatch).
   */
  async listCompletedTreatments(window: EntityWindow): Promise<readonly CompletedTreatmentRow[]> {
    const { start, end } = bounds(window, this.timezone);
    type CompletedRow = PayoutTreatmentLike & { patient_id: string; treatment_type: string; performed_at: string | null };
    const columns = "id, patient_id, treatment_type, cost, status, opd_charged, opd_fee, xray_taken, xray_cost, performed_at";
    const [performed, undated] = await Promise.all([
      this.windowRows<CompletedRow>(
        "completed treatments",
        (from, to) =>
          this.db
            .from("treatments")
            .select(columns)
            .eq("clinic_id", window.clinicId)
            .is("deleted_at", null)
            .eq("status", "completed")
            .not("performed_at", "is", null)
            .gte("performed_at", start)
            .lte("performed_at", end)
            .order("performed_at", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to),
        window.limit,
      ),
      // Completed with no performed_at: dated by when the completion was
      // RECORDED — an observed state-history version, never a baseline written
      // when history capture began, which would date old work to that day.
      this.undatedCompletions(window, start, end),
    ]);
    const completed = [
      ...performed.map((t) => ({ row: t, dated: treatmentPerformedAt({ performedAt: t.performed_at, completionRecordedAt: null }) })),
      ...undated,
    ].filter((c) => c.dated.at !== null);
    if (completed.length === 0) return [];

    const patientIds = [...new Set(completed.map((c) => c.row.patient_id))];
    const collected = await this.collectedByTreatment(window.clinicId, patientIds, window.to);

    return completed.map(({ row: t, dated }) => ({
      treatmentId: t.id,
      patientId: t.patient_id,
      date: this.localDate(dated.at as string),
      dateBasis: dated.basis,
      // Consultations stay in: this is what was billed, and a cheap consultation
      // is exactly the case mix this row exists to show. Spellings are folded.
      treatmentType: canonicalTreatmentType(t.treatment_type),
      billedValue: currency(treatmentTotalCharge(t)),
      collectedValue: currency(collected.get(t.id) ?? 0),
    }));
  }

  /** Completed treatments with no performed_at whose completion was recorded inside the window. */
  private async undatedCompletions(
    window: EntityWindow,
    start: string,
    end: string,
  ): Promise<Array<{ row: PayoutTreatmentLike & { patient_id: string; treatment_type: string; performed_at: string | null }; dated: ReturnType<typeof treatmentPerformedAt> }>> {
    const marks = await this.windowRows<{ treatment_id: string; recorded_at: string }>(
      "completed treatments (recorded completions)",
      (from, to) =>
        this.db
          .from("treatment_status_history")
          .select("treatment_id, recorded_at")
          .eq("clinic_id", window.clinicId)
          .eq("provenance", "observed")
          .eq("new_status", "completed")
          .is("performed_at", null)
          .lte("recorded_at", end)
          .order("recorded_at", { ascending: true })
          .order("treatment_id", { ascending: true })
          .range(from, to),
      window.limit,
    );
    if (marks.length === 0) return [];
    // The first recorded completion per treatment — read from before the window
    // too, so a treatment completed earlier, reopened and completed again inside
    // the window is dated from the first time and stays out of this window.
    const firstMark = new Map<string, string>();
    for (const m of marks) if (!firstMark.has(m.treatment_id)) firstMark.set(m.treatment_id, m.recorded_at);
    for (const [id, at] of firstMark) if (Date.parse(at) < Date.parse(start)) firstMark.delete(id);
    if (firstMark.size === 0) return [];

    const rows = await this.byIds<PayoutTreatmentLike & { patient_id: string; treatment_type: string; performed_at: string | null }>(
      "completed treatments (undated)",
      [...firstMark.keys()],
      (chunk, from, to) =>
        this.db
          .from("treatments")
          .select("id, patient_id, treatment_type, cost, status, opd_charged, opd_fee, xray_taken, xray_cost, performed_at")
          .eq("clinic_id", window.clinicId)
          .is("deleted_at", null)
          .eq("status", "completed")
          .is("performed_at", null)
          .in("id", chunk)
          .order("id", { ascending: true })
          .range(from, to),
    );
    return rows.map((t) => ({ row: t, dated: treatmentPerformedAt({ performedAt: null, completionRecordedAt: firstMark.get(t.id) ?? null }) }));
  }
}
