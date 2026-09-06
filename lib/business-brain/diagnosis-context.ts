/**
 * Supabase adapter for the Diagnosis Engine's entity-level context port.
 *
 * The Diagnosis Engine reasons over daily aggregates, which is enough to notice
 * that something is wrong but often not enough to say WHICH of several
 * explanations fits. Ten of its twenty-seven discriminators are catalogued as
 * `requires_entity_data`, and this is the data they require: individual
 * cancellations, individual unpaid balances, individual overdue recalls.
 *
 * Same split as the other adapters — the port lives in `business-brain/` and
 * knows nothing about Postgres; this is the only place these tables are read.
 *
 * ## What this deployment can and cannot answer
 *
 * Six of the seven methods are answerable from DentGrow's schema. One is not,
 * and it returns `null` rather than an empty array, because `[]` would claim the
 * clinic has no overdue recalls rather than admitting nothing records the
 * answer. See `listRecallContactAttempts`.
 *
 * Two of the six rest on documented approximations, noted at each method. Both
 * are the same shape as the approximation already accepted for `isScheduled`:
 * the direction of the error is known and stated, rather than the reading being
 * presented as exact.
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
  RecallContactAttemptRow,
} from "@/business-brain";
import { MetricUnit } from "@/business-brain";
import type { Database } from "@/types/database.types";
import { getUtcBoundariesForLocalDate } from "@/lib/utils";
import { treatmentTotalCharge } from "@/lib/billing/balance";
import {
  allocateCollectionsToTreatments,
  type PayoutPaymentLike,
  type PayoutTreatmentLike,
} from "@/lib/billing/payout";

/** Narrow `unknown` PostgREST payloads to the row shape a query selected. */
function rows<T>(data: unknown): T[] {
  return (data ?? []) as T[];
}

/** The "YYYY-MM-DD" part of an ISO timestamp. */
function datePart(iso: string): string {
  return iso.slice(0, 10);
}

/** Whole days between two "YYYY-MM-DD" dates, never negative. */
function ageInDays(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.max(0, Math.round(ms / 86_400_000));
}

function currency(value: number): { value: number; unit: MetricUnit } {
  return { value, unit: MetricUnit.CURRENCY };
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
  private readonly db: SupabaseClient<Database>;
  private readonly timezone: string;

  /**
   * @param timezone Clinic IANA timezone for the business-date window bounds.
   *   Defaults to "UTC" so callers/tests that don't supply it keep the old
   *   UTC-midnight boundaries exactly; production passes the real clinic tz.
   */
  constructor(db: SupabaseClient<Database>, timezone: string = "UTC") {
    this.db = db;
    this.timezone = timezone;
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
   * `asOfDate` — not just the ones inside the caller's page or window — because
   * allocation is oldest-first across a patient's WHOLE ledger; allocating
   * against a partial treatment set could credit the wrong treatment.
   */
  private async collectedByTreatment(
    clinicId: string,
    patientIds: readonly string[],
    asOfDate: string,
  ): Promise<Map<string, number>> {
    const collected = new Map<string, number>();
    if (patientIds.length === 0) return collected;

    const endOfDay = getUtcBoundariesForLocalDate(asOfDate, this.timezone).end;
    const [treatmentsRes, paymentsRes] = await Promise.all([
      this.db
        .from("treatments")
        .select(
          "id, patient_id, cost, status, opd_charged, opd_fee, xray_taken, xray_cost, performed_at, created_at",
        )
        .eq("clinic_id", clinicId)
        .is("deleted_at", null)
        .in("status", ["completed", "in_progress"])
        .in("patient_id", patientIds as string[])
        .lte("created_at", endOfDay),
      this.db
        .from("payments")
        .select("patient_id, treatment_id, amount")
        .eq("clinic_id", clinicId)
        .is("deleted_at", null)
        .in("patient_id", patientIds as string[])
        .lte("payment_date", asOfDate),
    ]);
    if (treatmentsRes.error) {
      throw new Error(`collections (treatments): ${treatmentsRes.error.message}`);
    }
    if (paymentsRes.error) {
      throw new Error(`collections (payments): ${paymentsRes.error.message}`);
    }

    const treatmentsByPatient = new Map<string, (PayoutTreatmentLike & { patient_id: string })[]>();
    for (const t of rows<
      PayoutTreatmentLike & { patient_id: string }
    >(treatmentsRes.data)) {
      const list = treatmentsByPatient.get(t.patient_id) ?? [];
      list.push(t);
      treatmentsByPatient.set(t.patient_id, list);
    }

    const paymentsByPatient = new Map<string, PayoutPaymentLike[]>();
    for (const p of rows<PayoutPaymentLike & { patient_id: string | null }>(paymentsRes.data)) {
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
    const { data, error } = await this.db
      .from("appointments")
      .select("id, patient_id, dentist_id, scheduled_at, status")
      .eq("clinic_id", window.clinicId)
      .is("deleted_at", null)
      .in("status", ["cancelled", "no_show"])
      .gte("scheduled_at", start)
      .lte("scheduled_at", end)
      .order("scheduled_at", { ascending: true })
      .limit(window.limit);
    if (error) throw new Error(`cancellation events: ${error.message}`);

    const lost = rows<{
      id: string;
      patient_id: string;
      dentist_id: string;
      scheduled_at: string;
      status: string;
    }>(data);
    if (lost.length === 0) return [];

    const ids = lost.map((a) => a.id);

    const [historyResult, treatmentResult, refillResult] = await Promise.all([
      this.db
        .from("appointment_history")
        .select("appointment_id, action, new_value, timestamp")
        .in("appointment_id", ids)
        .order("timestamp", { ascending: true }),
      this.db
        .from("treatments")
        .select("appointment_id, treatment_type")
        .eq("clinic_id", window.clinicId)
        .is("deleted_at", null)
        .in("appointment_id", ids),
      // Anything still live in the same slot, for the same dentist. If one
      // exists, the capacity was recovered and the cancellation cost nothing.
      this.db
        .from("appointments")
        .select("dentist_id, scheduled_at, status")
        .eq("clinic_id", window.clinicId)
        .is("deleted_at", null)
        .not("status", "in", "(cancelled,no_show)")
        .gte("scheduled_at", start)
        .lte("scheduled_at", end),
    ]);
    if (historyResult.error) throw new Error(`cancellation history: ${historyResult.error.message}`);
    if (treatmentResult.error) throw new Error(`cancellation treatments: ${treatmentResult.error.message}`);
    if (refillResult.error) throw new Error(`slot refill: ${refillResult.error.message}`);

    // Earliest recorded cancellation per appointment: a record reopened and
    // re-cancelled should be dated from when the clinic first lost the slot.
    const cancelledAt = new Map<string, string>();
    for (const h of rows<{
      appointment_id: string;
      action: string;
      new_value: unknown;
      timestamp: string;
    }>(historyResult.data)) {
      const status = (h.new_value as { status?: string } | null)?.status;
      if (status !== "cancelled" && h.action !== "cancelled") continue;
      if (!cancelledAt.has(h.appointment_id)) cancelledAt.set(h.appointment_id, h.timestamp);
    }

    const treatmentType = new Map<string, string>();
    for (const t of rows<{ appointment_id: string | null; treatment_type: string }>(
      treatmentResult.data,
    )) {
      if (t.appointment_id && !treatmentType.has(t.appointment_id)) {
        treatmentType.set(t.appointment_id, t.treatment_type);
      }
    }

    const filledSlots = new Set(
      rows<{ dentist_id: string; scheduled_at: string }>(refillResult.data).map(
        (a) => `${a.dentist_id}|${a.scheduled_at}`,
      ),
    );

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
        date: datePart(a.scheduled_at),
        scheduledStart: a.scheduled_at,
        cancelledAt: cancelled,
        noticeHours,
        outcome: a.status === "no_show" ? ("no_show" as const) : ("cancelled" as const),
        treatmentType: treatmentType.get(a.id) ?? null,
        slotRefilled: filledSlots.has(`${a.dentist_id}|${a.scheduled_at}`),
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
    const { data, error } = await this.db
      .from("appointments")
      .select("id, patient_id, scheduled_at")
      .eq("clinic_id", window.clinicId)
      .is("deleted_at", null)
      .eq("status", "no_show")
      .gte("scheduled_at", start)
      .lte("scheduled_at", end)
      .order("scheduled_at", { ascending: true })
      .limit(window.limit);
    if (error) throw new Error(`no-show history: ${error.message}`);

    const missed = rows<{ id: string; patient_id: string; scheduled_at: string }>(data);
    if (missed.length === 0) return [];

    const patientIds = [...new Set(missed.map((m) => m.patient_id))];
    const { data: priorData, error: priorError } = await this.db
      .from("appointments")
      .select("patient_id, scheduled_at, status")
      .eq("clinic_id", window.clinicId)
      .is("deleted_at", null)
      .in("patient_id", patientIds)
      .in("status", ["completed", "no_show"])
      .order("scheduled_at", { ascending: true });
    if (priorError) throw new Error(`no-show prior history: ${priorError.message}`);

    const byPatient = new Map<string, { scheduled_at: string; status: string }[]>();
    for (const a of rows<{ patient_id: string; scheduled_at: string; status: string }>(priorData)) {
      const list = byPatient.get(a.patient_id) ?? [];
      list.push({ scheduled_at: a.scheduled_at, status: a.status });
      byPatient.set(a.patient_id, list);
    }

    return missed.map((m) => {
      const history = (byPatient.get(m.patient_id) ?? []).filter(
        (a) => a.scheduled_at < m.scheduled_at,
      );
      const attended = history.filter((a) => a.status === "completed");
      return {
        patientId: m.patient_id,
        appointmentId: m.id,
        date: datePart(m.scheduled_at),
        priorAttended: attended.length,
        priorMissed: history.length - attended.length,
        lastAttendedDate:
          attended.length > 0 ? datePart(attended[attended.length - 1].scheduled_at) : null,
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
   * upcoming visit — because no treatment-to-appointment link exists. This is
   * the same approximation the `isScheduled` snapshot field already documents,
   * and it errs the same way: it UNDER-reports. Everything returned is genuinely
   * unbooked; some genuinely unbooked work is missed because the patient happens
   * to have an unrelated appointment.
   *
   * Ordered NEWEST first: the `limit` cap should drop the OLDEST candidates, not
   * the most recent — a plan sitting unaddressed for years is far more likely to
   * have already been resolved, cancelled off-record, or forgotten than one from
   * last week, so keeping the newest under the cap surfaces the genuinely acute
   * backlog (audit: row-limit truncation bias).
   */
  async listPendingTreatments(window: EntityWindow): Promise<readonly PendingTreatmentRow[]> {
    const endOfWindow = getUtcBoundariesForLocalDate(window.to, this.timezone).end;
    const { data, error } = await this.db
      .from("treatments")
      .select("id, patient_id, treatment_type, cost, created_at")
      .eq("clinic_id", window.clinicId)
      .is("deleted_at", null)
      .eq("status", "planned")
      .lte("created_at", endOfWindow)
      .order("created_at", { ascending: false })
      .limit(window.limit);
    if (error) throw new Error(`pending treatments: ${error.message}`);

    const planned = rows<{
      id: string;
      patient_id: string;
      treatment_type: string;
      cost: number | string | null;
      created_at: string;
    }>(data);
    if (planned.length === 0) return [];

    const { data: bookedData, error: bookedError } = await this.db
      .from("appointments")
      .select("patient_id")
      .eq("clinic_id", window.clinicId)
      .is("deleted_at", null)
      .in("patient_id", [...new Set(planned.map((t) => t.patient_id))])
      .in("status", ["scheduled", "checked_in", "in_progress"])
      .gt("scheduled_at", endOfWindow);
    if (bookedError) throw new Error(`pending treatments (booked): ${bookedError.message}`);

    const booked = new Set(rows<{ patient_id: string }>(bookedData).map((a) => a.patient_id));

    return planned
      .filter((t) => !booked.has(t.patient_id))
      .map((t) => ({
        treatmentId: t.id,
        patientId: t.patient_id,
        acceptedOn: datePart(t.created_at),
        ageDays: ageInDays(datePart(t.created_at), window.to),
        treatmentType: t.treatment_type,
        quotedValue: currency(Number(t.cost ?? 0)),
      }));
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
   * Ordered NEWEST first: the `limit` cap should drop the OLDEST candidates —
   * the ones most likely already settled — not the most recent, which are the
   * ones most likely still genuinely owed (audit: row-limit truncation bias).
   *
   * Fully-paid treatments are omitted — an outstanding balance of zero is not
   * outstanding.
   */
  async listOutstandingBalances(window: EntityWindow): Promise<readonly OutstandingBalanceRow[]> {
    const endOfWindow = getUtcBoundariesForLocalDate(window.to, this.timezone).end;
    const { data, error } = await this.db
      .from("treatments")
      .select(
        "id, patient_id, cost, status, opd_charged, opd_fee, xray_taken, xray_cost, performed_at, created_at",
      )
      .eq("clinic_id", window.clinicId)
      .is("deleted_at", null)
      .in("status", ["completed", "in_progress"])
      .lte("created_at", endOfWindow)
      .order("created_at", { ascending: false })
      .limit(window.limit);
    if (error) throw new Error(`outstanding balances: ${error.message}`);

    const billable = rows<
      PayoutTreatmentLike & {
        patient_id: string;
        performed_at: string | null;
        created_at: string;
      }
    >(data);
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
        const raisedOn = datePart(t.performed_at ?? t.created_at);
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
    const { data, error } = await this.db
      .from("appointments")
      .select("id, scheduled_at, duration_minutes")
      .eq("clinic_id", window.clinicId)
      .is("deleted_at", null)
      .not("status", "in", "(cancelled)")
      .gte("scheduled_at", start)
      .lte("scheduled_at", end)
      .order("scheduled_at", { ascending: true })
      .limit(window.limit);
    if (error) throw new Error(`appointment arrivals: ${error.message}`);

    const appointments = rows<{
      id: string;
      scheduled_at: string;
      duration_minutes: number;
    }>(data);
    if (appointments.length === 0) return [];

    const { data: queueData, error: queueError } = await this.db
      .from("queue_entries")
      .select("appointment_id, checked_in_at, called_at, completed_at")
      .eq("clinic_id", window.clinicId)
      .in("appointment_id", appointments.map((a) => a.id));
    if (queueError) throw new Error(`appointment arrivals (queue): ${queueError.message}`);

    const arrivals = new Map<
      string,
      { checked_in_at: string; called_at: string | null; completed_at: string | null }
    >();
    for (const q of rows<{
      appointment_id: string;
      checked_in_at: string;
      called_at: string | null;
      completed_at: string | null;
    }>(queueData)) {
      arrivals.set(q.appointment_id, q);
    }

    return appointments.map((a) => {
      const entry = arrivals.get(a.id);
      const arrivedAt = entry?.checked_in_at ?? null;
      return {
        appointmentId: a.id,
        date: datePart(a.scheduled_at),
        scheduledStart: a.scheduled_at,
        arrivedAt,
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
        // duration, and inventing one would fabricate the measurement.
        actualMinutes:
          entry?.called_at && entry.completed_at
            ? Math.max(
                0,
                Math.round(
                  (Date.parse(entry.completed_at) - Date.parse(entry.called_at)) / 60_000,
                ),
              )
            : null,
      };
    });
  }

  /**
   * NOT ANSWERABLE by this deployment — returns `null`, never `[]`.
   *
   * The discriminator this serves separates "the recall was never attempted"
   * from "it was attempted and the patient could not be reached". DentGrow
   * records neither. `follow_ups` has a due date, a status and a
   * `confirmation_status`, but nothing counts contact attempts or timestamps the
   * last one, and no communications log exists.
   *
   * Returning an empty list would assert that no attempts were made, which is
   * precisely one of the two answers the discriminator is trying to choose
   * between — it would resolve the question by accident, in the direction that
   * blames the clinic. `null` leaves the hypothesis `undetermined`, which is the
   * honest outcome and what the Diagnosis Engine is built to handle.
   *
   * Closing this needs a table recording contact attempts against a follow-up
   * (channel, moment, outcome). That is a product decision about what staff are
   * asked to record, not something an adapter can infer.
   */
  async listRecallContactAttempts(
    _window: EntityWindow,
  ): Promise<readonly RecallContactAttemptRow[] | null> {
    return null;
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
    const { data, error } = await this.db
      .from("treatments")
      .select(
        "id, patient_id, treatment_type, cost, status, opd_charged, opd_fee, xray_taken, xray_cost, performed_at",
      )
      .eq("clinic_id", window.clinicId)
      .is("deleted_at", null)
      .eq("status", "completed")
      .not("performed_at", "is", null)
      .gte("performed_at", start)
      .lte("performed_at", end)
      .order("performed_at", { ascending: true })
      .limit(window.limit);
    if (error) throw new Error(`completed treatments: ${error.message}`);

    const completed = rows<
      PayoutTreatmentLike & {
        patient_id: string;
        treatment_type: string;
        performed_at: string;
      }
    >(data);
    if (completed.length === 0) return [];

    const patientIds = [...new Set(completed.map((t) => t.patient_id))];
    const collected = await this.collectedByTreatment(window.clinicId, patientIds, window.to);

    return completed.map((t) => ({
      treatmentId: t.id,
      patientId: t.patient_id,
      date: datePart(t.performed_at),
      treatmentType: t.treatment_type,
      billedValue: currency(treatmentTotalCharge(t)),
      collectedValue: currency(collected.get(t.id) ?? 0),
    }));
  }
}
