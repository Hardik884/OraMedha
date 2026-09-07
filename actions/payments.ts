"use server";

import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { resolveSession as resolveCachedSession } from "@/lib/auth/session";
import { getTodayInTimezone } from "@/lib/utils";
import { computeOutstandingBalance, treatmentTotalCharge } from "@/lib/billing/balance";
import { recordPhiAccess } from "@/lib/audit/phi-access";
import {
  allocateCollectionsToTreatments,
  type PayoutPaymentLike,
  type PayoutTreatmentLike,
} from "@/lib/billing/payout";
import {
  RecordPaymentSchema,
  type ActionResult,
  type Payment,
  type Patient,
} from "@/types";

/**
 * Payment Server Actions
 *
 * Security rules (enforced in every action):
 * - clinic_id is ALWAYS sourced from the server session.
 * - Outstanding balance is ALWAYS computed server-side via
 *   lib/billing/balance.ts (single shared implementation).
 *   Formula: SUM(billable treatments.cost WHERE deleted_at IS NULL)
 *            - SUM(payments.amount WHERE deleted_at IS NULL)
 *   Billable = status in ('completed','in_progress'). Cancelled and planned
 *   treatments never contribute.
 * - Only staff (dentist + receptionist) can record payments.
 * - Patients can read their own payment history via portal link.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = any;

type ResolvedProfile = {
  id: string;
  clinic_id: string;
  role: "dentist" | "receptionist" | "patient";
};

async function resolveSession(): Promise<{
  db: DbClient;
  profile: ResolvedProfile | null;
}> {
  const { db, profile } = await resolveCachedSession();
  return { db, profile };
}

// =============================================================================
// recordPayment — staff only (dentist + receptionist)
// =============================================================================

export async function recordPayment(
  input: unknown
): Promise<ActionResult<Payment>> {
  try {
    const parsed = RecordPaymentSchema.safeParse(input);
    if (!parsed.success) {
      return {
        data: null,
        error: parsed.error.errors[0]?.message ?? "Invalid input",
      };
    }

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };

    if (profile.role === "patient") {
      return { data: null, error: "Forbidden: patients cannot record payments." };
    }

    // Verify patient belongs to clinic
    const { data: patient } = await db
      .from("patients")
      .select("id")
      .eq("id", parsed.data.patient_id)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null)
      .single();

    if (!patient) {
      return { data: null, error: "Patient not found." };
    }

    // Default the payment date to the clinic's local "today", not the server's
    // UTC date, so a payment recorded near midnight in a clinic ahead of UTC is
    // attributed to the correct business day. An explicit date (a backdated
    // entry the receptionist picked) is respected as-is.
    let paymentDate = parsed.data.payment_date;
    if (!paymentDate) {
      const { data: settings } = await db
        .from("clinic_settings")
        .select("timezone")
        .eq("clinic_id", profile.clinic_id)
        .maybeSingle();
      const tz = (settings as { timezone?: string } | null)?.timezone ?? "Asia/Kolkata";
      paymentDate = getTodayInTimezone(tz);
    }

    const { data, error } = await db
      .from("payments")
      .insert({
        clinic_id: profile.clinic_id,
        patient_id: parsed.data.patient_id,
        appointment_id: parsed.data.appointment_id ?? null,
        treatment_id: parsed.data.treatment_id ?? null,
        amount: parsed.data.amount,
        method: parsed.data.method,
        payment_type: parsed.data.payment_type ?? "treatment",
        payment_date: paymentDate,
        notes: parsed.data.notes ?? null,
        created_by: profile.id,
      })
      .select()
      .single();

    if (error) {
      console.error("[recordPayment]", error);
      return { data: null, error: "Failed to record payment." };
    }

    revalidatePath(`/dentist/patients/${parsed.data.patient_id}`);
    revalidatePath("/dentist/payments");
    revalidatePath("/receptionist/payments");
    if (parsed.data.appointment_id) {
      revalidatePath(`/dentist/appointments/${parsed.data.appointment_id}`);
    }

    return { data: data as Payment, error: null };
  } catch (err) {
    console.error("[recordPayment] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getPaymentsForAppointment — payments linked to a specific appointment (staff)
// =============================================================================

export async function getPaymentsForAppointment(
  appointmentId: string
): Promise<ActionResult<Payment[]>> {
  try {
    if (!appointmentId) return { data: [], error: null };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role === "patient") return { data: null, error: "Forbidden" };

    const { data, error } = await db
      .from("payments")
      .select("*")
      .eq("appointment_id", appointmentId)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null)
      .order("payment_date", { ascending: false });

    if (error) {
      console.error("[getPaymentsForAppointment]", error);
      return { data: null, error: "Failed to fetch payments." };
    }

    return { data: (data ?? []) as Payment[], error: null };
  } catch (err) {
    console.error("[getPaymentsForAppointment] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getPatientPayments — full ledger for a patient (staff path)
// =============================================================================

export async function getPatientPayments(
  patientId: string
): Promise<ActionResult<Payment[]>> {
  try {
    if (!patientId) return { data: [], error: null };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };

    // Staff path: verify patient belongs to clinic
    if (profile.role !== "patient") {
      const { data, error } = await db
        .from("payments")
        .select("*")
        .eq("patient_id", patientId)
        .eq("clinic_id", profile.clinic_id)
        .is("deleted_at", null)
        .order("payment_date", { ascending: false });

      if (error) {
        console.error("[getPatientPayments]", error);
        return { data: null, error: "Failed to fetch payments." };
      }

      const rows = (data ?? []) as Payment[];

      // A patient's payment ledger is financial data about a named person, so a
      // staff read of one patient's ledger is recorded. Amounts are not: the
      // log stores that the ledger was opened, never what it said.
      await recordPhiAccess(profile, {
        event: "PAYMENT_VIEWED",
        resourceType: "patient",
        resourceId: patientId,
        patientId,
        context: { surface: "patient-payments", count: rows.length },
      });

      return { data: rows, error: null };
    }

    // Patient portal path: resolve via portal link
    const supabase = await createServerClient();
    const portalDb: DbClient = supabase;

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { data: null, error: "Unauthorized" };

    const { data: link } = await portalDb
      .from("patient_portal_links")
      .select("patient_id")
      .eq("user_id", user.id)
      .single();

    if (!link?.patient_id) {
      return { data: null, error: "Portal account not linked." };
    }

    const { data, error } = await portalDb
      .from("payments")
      .select("*")
      .eq("patient_id", link.patient_id)
      .is("deleted_at", null)
      .order("payment_date", { ascending: false });

    if (error) {
      console.error("[getPatientPayments portal]", error);
      return { data: null, error: "Failed to fetch payments." };
    }

    return { data: (data ?? []) as Payment[], error: null };
  } catch (err) {
    console.error("[getPatientPayments] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getPortalPayments — patient portal path (uses portal link resolution)
// =============================================================================

export async function getPortalPayments(): Promise<ActionResult<Payment[]>> {
  try {
    const supabase = await createServerClient();
    const db: DbClient = supabase;

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { data: null, error: "Unauthorized" };

    const { data: link } = await db
      .from("patient_portal_links")
      .select("patient_id")
      .eq("user_id", user.id)
      .single();

    if (!link?.patient_id) {
      return { data: null, error: "Portal account not linked." };
    }

    const { data, error } = await db
      .from("payments")
      .select("*")
      .eq("patient_id", link.patient_id)
      .is("deleted_at", null)
      .order("payment_date", { ascending: false });

    if (error) {
      console.error("[getPortalPayments]", error);
      return { data: null, error: "Failed to fetch payments." };
    }

    return { data: (data ?? []) as Payment[], error: null };
  } catch (err) {
    console.error("[getPortalPayments] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getOutstandingBalance — computed server-side, never trusted from client
// =============================================================================

export async function getOutstandingBalance(
  patientId: string
): Promise<ActionResult<number>> {
  try {
    // Portal path: resolve patient from link when patientId is empty
    let resolvedPatientId = patientId;
    let clinicId: string | null = null;

    const supabase = await createServerClient();
    const db: DbClient = supabase;

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { data: null, error: "Unauthorized" };

    // Resolve role
    const { data: profileData } = await db
      .from("profiles")
      .select("id, clinic_id, role")
      .eq("id", user.id)
      .single();

    if (profileData) {
      clinicId = profileData.clinic_id;
    } else {
      // Portal user — resolve via link
      const { data: link } = await db
        .from("patient_portal_links")
        .select("patient_id, patients(clinic_id)")
        .eq("user_id", user.id)
        .single();

      if (!link?.patient_id) {
        return { data: 0, error: null };
      }
      resolvedPatientId = link.patient_id;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clinicId = (link as any).patients?.clinic_id ?? null;
    }

    if (!resolvedPatientId) return { data: 0, error: null };

    let treatmentQuery = db
      .from("treatments")
      .select("cost, opd_charged, opd_fee, xray_taken, xray_cost, status")
      .eq("patient_id", resolvedPatientId)
      .is("deleted_at", null);

    let paymentQuery = db
      .from("payments")
      .select("amount")
      .eq("patient_id", resolvedPatientId)
      .is("deleted_at", null);

    if (clinicId) {
      treatmentQuery = treatmentQuery.eq("clinic_id", clinicId);
      paymentQuery = paymentQuery.eq("clinic_id", clinicId);
    }

    const [{ data: treatmentRows }, { data: paymentRows }] = await Promise.all([
      treatmentQuery,
      paymentQuery,
    ]);

    return {
      data: computeOutstandingBalance(
        (treatmentRows ?? []) as { cost: number; status: string }[],
        (paymentRows ?? []) as { amount: number }[]
      ),
      error: null,
    };
  } catch (err) {
    console.error("[getOutstandingBalance] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getPatientTreatmentCollections — per-treatment money actually collected
// =============================================================================

/**
 * Money collected against each of a patient's billable treatments, via the
 * same oldest-first pooled allocation `lib/billing/payout.ts` already uses
 * for consultant payouts — DentGrow's one canonical answer to "which payments
 * cover which treatment" when a payment isn't linked to one (audit B8).
 *
 * Staff-only. Loads the patient's ENTIRE billable-treatment and payment
 * history (not just one visit's), because allocation is oldest-first across
 * the whole ledger — a lump-sum payment recorded against one treatment can
 * settle an older one too, and allocating against a partial set would credit
 * the wrong treatment. Callers filter the returned map down to whichever
 * treatments they're displaying (e.g. one appointment's).
 *
 * Never crosses patients: everything is scoped to the single `patientId`
 * passed in, plus the caller's own clinic.
 */
export async function getPatientTreatmentCollections(
  patientId: string
): Promise<ActionResult<Record<string, number>>> {
  try {
    if (!patientId) return { data: {}, error: null };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role === "patient") {
      return { data: null, error: "Forbidden" };
    }

    const [{ data: treatmentRows, error: treatmentError }, { data: paymentRows, error: paymentError }] =
      await Promise.all([
        db
          .from("treatments")
          .select("id, cost, status, opd_charged, opd_fee, xray_taken, xray_cost, performed_at, created_at")
          .eq("patient_id", patientId)
          .eq("clinic_id", profile.clinic_id)
          .is("deleted_at", null)
          .in("status", ["completed", "in_progress"]),
        db
          .from("payments")
          .select("amount, treatment_id")
          .eq("patient_id", patientId)
          .eq("clinic_id", profile.clinic_id)
          .is("deleted_at", null),
      ]);

    if (treatmentError || paymentError) {
      console.error("[getPatientTreatmentCollections]", treatmentError ?? paymentError);
      return { data: null, error: "Failed to fetch payment allocation." };
    }

    const treatments = (treatmentRows ?? []) as PayoutTreatmentLike[];
    const payments = (paymentRows ?? []) as PayoutPaymentLike[];
    const allocation = allocateCollectionsToTreatments(treatments, payments);

    const result: Record<string, number> = {};
    for (const [treatmentId, amount] of allocation) {
      result[treatmentId] = amount;
    }
    return { data: result, error: null };
  } catch (err) {
    console.error("[getPatientTreatmentCollections] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getPortalOutstandingBalance — portal path (no patientId needed)
// =============================================================================

export async function getPortalOutstandingBalance(): Promise<ActionResult<number>> {
  try {
    const supabase = await createServerClient();
    const db: DbClient = supabase;

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { data: null, error: "Unauthorized" };

    const { data: link } = await db
      .from("patient_portal_links")
      .select("patient_id, patients(clinic_id)")
      .eq("user_id", user.id)
      .single();

    if (!link?.patient_id) return { data: 0, error: null };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clinicId = (link as any).patients?.clinic_id;

    const [{ data: treatmentRows }, { data: paymentRows }] = await Promise.all([
      db
        .from("treatments")
        .select("cost, opd_charged, opd_fee, xray_taken, xray_cost, status")
        .eq("patient_id", link.patient_id)
        .eq("clinic_id", clinicId)
        .is("deleted_at", null),
      db
        .from("payments")
        .select("amount")
        .eq("patient_id", link.patient_id)
        .eq("clinic_id", clinicId)
        .is("deleted_at", null),
    ]);

    return {
      data: computeOutstandingBalance(
        (treatmentRows ?? []) as { cost: number; status: string }[],
        (paymentRows ?? []) as { amount: number }[]
      ),
      error: null,
    };
  } catch (err) {
    console.error("[getPortalOutstandingBalance] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getPaymentsToday — revenue today for dashboard KPI
// =============================================================================

export async function getPaymentsToday(): Promise<ActionResult<number>> {
  try {
    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };

    if (profile.role === "patient") {
      return { data: null, error: "Forbidden" };
    }

    // Use the clinic's local "today" so a clinic in Asia/Kolkata at 01:00 IST
    // doesn't query against the previous calendar day.
    const { data: settings } = await db
      .from("clinic_settings")
      .select("timezone")
      .eq("clinic_id", profile.clinic_id)
      .maybeSingle();
    const tz = (settings as { timezone?: string } | null)?.timezone ?? "Asia/Kolkata";
    const today = getTodayInTimezone(tz);

    const { data, error } = await db
      .from("payments")
      .select("amount")
      .eq("clinic_id", profile.clinic_id)
      .eq("payment_date", today)
      .is("deleted_at", null);

    if (error) {
      console.error("[getPaymentsToday]", error);
      return { data: null, error: "Failed to fetch today's revenue." };
    }

    const total = ((data ?? []) as { amount: number }[]).reduce(
      (sum, p) => sum + Number(p.amount ?? 0),
      0
    );

    return { data: total, error: null };
  } catch (err) {
    console.error("[getPaymentsToday] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getPatientsWithOutstandingBalance — for receptionist pending payments list
// Returns patients with outstanding balance > 0
// =============================================================================

export async function getPatientsWithOutstandingBalance(): Promise<
  ActionResult<
    Array<{
      id: string;
      name: string;
      phone: string | null;
      balance: number;
      /** Set and today-or-later: this balance is under an agreed payment plan. */
      paymentPlanUntil: string | null;
    }>
  >
> {
  try {
    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };

    if (profile.role === "patient") {
      return { data: null, error: "Forbidden" };
    }

    /*
     * One aggregate in the database, not three unbounded table reads.
     *
     * This used to fetch every patient, every treatment and every payment in
     * the clinic and reduce them in JavaScript. PostgREST caps a response at
     * max_rows (1000 in supabase/config.toml) and TRUNCATES SILENTLY past it —
     * no error, no signal — so once a clinic passed a thousand treatments or
     * payments the balances here started coming out wrong, in whichever
     * direction the truncation fell. actions/messaging.ts builds the payment
     * reminder list from this function, so the visible failure would have been
     * chasing patients who had already paid.
     *
     * clinic_outstanding_balances() (20260907000200) mirrors
     * lib/billing/balance.ts term for term and returns one row per patient who
     * owes something, so there is nothing left to truncate. Its clinic comes
     * from auth_clinic_id() inside the function and its role check is its own —
     * no clinic id is passed from here.
     */
    const { data, error } = await db.rpc("clinic_outstanding_balances");

    if (error) {
      console.error("[getPatientsWithOutstandingBalance]", error);
      return { data: null, error: "Failed to load outstanding balances." };
    }

    const rows = (data ?? []) as Array<{
      patient_id: string;
      name: string;
      phone: string | null;
      payment_plan_until: string | null;
      balance: number | string;
    }>;

    return {
      data: rows.map((r) => ({
        id: r.patient_id,
        name: r.name,
        phone: r.phone,
        // numeric arrives as a string over PostgREST; every caller does
        // arithmetic and formatting on it.
        balance: Number(r.balance ?? 0),
        paymentPlanUntil: r.payment_plan_until,
      })),
      error: null,
    };
  } catch (err) {
    console.error("[getPatientsWithOutstandingBalance] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getAllPayments — paginated payment list with search and filters (staff)
// =============================================================================

type PaymentWithPatient = Payment & {
  patient: Pick<Patient, "id" | "name" | "phone">;
};

export async function getAllPayments(params: {
  page?: number;
  limit?: number;
  search?: string;
  method?: string;
  paymentType?: string;
  dateFrom?: string;
  dateTo?: string;
}): Promise<ActionResult<{ payments: PaymentWithPatient[]; total: number }>> {
  try {
    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };

    if (profile.role === "patient") {
      return { data: null, error: "Forbidden" };
    }

    const page = Math.max(1, params.page ?? 1);
    const limit = Math.max(1, Math.min(100, params.limit ?? 20));
    const offset = (page - 1) * limit;

    let query = db
      .from("payments")
      .select("*, patient:patients!inner(id, name, phone)", { count: "exact" })
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null);

    // Search by patient name or phone
    if (params.search) {
      const searchTerm = `%${params.search}%`;
      query = query.or(`name.ilike.${searchTerm},phone.ilike.${searchTerm}`, {
        referencedTable: "patients",
      });
    }

    // Filter by payment method
    if (params.method) {
      query = query.eq("method", params.method);
    }

    // Filter by payment type (treatment vs OPD)
    if (params.paymentType) {
      query = query.eq("payment_type", params.paymentType);
    }

    // Filter by date range
    if (params.dateFrom) {
      query = query.gte("payment_date", params.dateFrom);
    }
    if (params.dateTo) {
      query = query.lte("payment_date", params.dateTo);
    }

    query = query
      .order("payment_date", { ascending: false })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    const { data, error, count } = await query;

    if (error) {
      console.error("[getAllPayments]", error);
      return { data: null, error: "Failed to fetch payments." };
    }

    return {
      data: {
        payments: (data ?? []) as PaymentWithPatient[],
        total: count ?? 0,
      },
      error: null,
    };
  } catch (err) {
    console.error("[getAllPayments] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getAppointmentPaymentStatuses — batched payment-status derivation (staff)
//
// For a set of appointment ids, derives a payment status badge:
//   - "paid"    → billable treatment cost > 0 and fully covered
//   - "partial" → some payment recorded but less than the billable cost
//   - "pending" → billable treatment cost > 0 and nothing paid
//   - "none"    → no billable treatment cost for the appointment
//
// Reuses the shared billing rules (isBillableTreatment). One query per table,
// no per-row work, so it is safe to call once for a whole page of appointments.
// =============================================================================

export type AppointmentPaymentStatus = "paid" | "partial" | "pending" | "none";

export async function getAppointmentPaymentStatuses(
  appointmentIds: string[]
): Promise<ActionResult<Record<string, AppointmentPaymentStatus>>> {
  try {
    if (!appointmentIds || appointmentIds.length === 0) {
      return { data: {}, error: null };
    }

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role === "patient") return { data: null, error: "Forbidden" };

    const ids = Array.from(new Set(appointmentIds));

    const [{ data: treatmentRows }, { data: paymentRows }] = await Promise.all([
      db
        .from("treatments")
        .select("appointment_id, cost, opd_charged, opd_fee, xray_taken, xray_cost, status")
        .eq("clinic_id", profile.clinic_id)
        .in("appointment_id", ids)
        .is("deleted_at", null),
      db
        .from("payments")
        .select("appointment_id, amount")
        .eq("clinic_id", profile.clinic_id)
        .in("appointment_id", ids)
        .is("deleted_at", null),
    ]);

    const costMap = new Map<string, number>();
    const paidMap = new Map<string, number>();

    // Same correction as getPatientsWithOutstandingBalance above: the per-visit
    // charge is cost + OPD + X-ray, not cost alone, or a visit shows "Paid"
    // while a consultation or radiograph on it is still owed.
    for (const t of (treatmentRows ?? []) as {
      appointment_id: string | null;
      cost: number;
      status: string;
      opd_charged: boolean | null;
      opd_fee: number | null;
      xray_taken: boolean | null;
      xray_cost: number | null;
    }[]) {
      if (!t.appointment_id) continue;
      costMap.set(t.appointment_id, (costMap.get(t.appointment_id) ?? 0) + treatmentTotalCharge(t));
    }

    for (const p of (paymentRows ?? []) as {
      appointment_id: string | null;
      amount: number;
    }[]) {
      if (!p.appointment_id) continue;
      paidMap.set(p.appointment_id, (paidMap.get(p.appointment_id) ?? 0) + Number(p.amount ?? 0));
    }

    const result: Record<string, AppointmentPaymentStatus> = {};
    for (const id of ids) {
      const cost = costMap.get(id) ?? 0;
      const paid = paidMap.get(id) ?? 0;
      if (cost <= 0) {
        // No billable treatment cost — flag any standalone payment as paid,
        // otherwise there is nothing to collect yet.
        result[id] = paid > 0 ? "paid" : "none";
      } else if (paid >= cost) {
        result[id] = "paid";
      } else if (paid > 0) {
        result[id] = "partial";
      } else {
        result[id] = "pending";
      }
    }

    return { data: result, error: null };
  } catch (err) {
    console.error("[getAppointmentPaymentStatuses] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getPaymentRecorderNames — resolve staff display names for "Recorded By"
// =============================================================================

export async function getPaymentRecorderNames(
  ids: string[]
): Promise<ActionResult<Record<string, string>>> {
  try {
    const clean = Array.from(new Set((ids ?? []).filter(Boolean)));
    if (clean.length === 0) return { data: {}, error: null };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role === "patient") return { data: {}, error: null };

    const { data, error } = await db
      .from("profiles")
      .select("id, full_name")
      .eq("clinic_id", profile.clinic_id)
      .in("id", clean);

    if (error) {
      console.error("[getPaymentRecorderNames]", error);
      return { data: {}, error: null };
    }

    const map: Record<string, string> = {};
    for (const p of (data ?? []) as { id: string; full_name: string | null }[]) {
      if (p.full_name) map[p.id] = p.full_name;
    }
    return { data: map, error: null };
  } catch (err) {
    console.error("[getPaymentRecorderNames] unexpected:", err);
    return { data: {}, error: null };
  }
}

// =============================================================================
// setPaymentPlan — mark a patient's outstanding balance as under an agreed plan
// =============================================================================

/**
 * Record (or clear) that a patient's outstanding balance is under an agreed
 * payment plan with the clinic.
 *
 * The balance itself is never touched — `getOutstandingBalance` and every other
 * screen keep reporting the same figure, because the money is still genuinely
 * owed. This only tells the Business Brain that some or all of it is already
 * being collected on schedule, so `revenue.high_outstanding` and the clinic
 * health score can size how much is actually unmanaged (see
 * `revenue.outstanding_on_payment_plan`).
 *
 * `until: null` clears the plan immediately. A past date is rejected rather than
 * silently accepted-and-ignored: a plan that already expired is not a
 * meaningful thing to record, and the honest options are "set a real future
 * date" or "clear it".
 */
export async function setPaymentPlan(
  patientId: string,
  until: string | null,
): Promise<ActionResult<{ paymentPlanUntil: string | null }>> {
  try {
    const { db, profile } = await resolveCachedSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist" && profile.role !== "receptionist") {
      return { data: null, error: "Forbidden" };
    }

    if (until !== null) {
      const parsed = ISO_DATE_REGEX.test(until) ? new Date(`${until}T00:00:00Z`) : null;
      if (parsed === null || Number.isNaN(parsed.getTime())) {
        return { data: null, error: "Invalid date." };
      }
      const { timezone } = await getClinicConfigFor(profile.clinic_id, db);
      if (until < getTodayInTimezone(timezone)) {
        return { data: null, error: "The payment plan date must be today or later." };
      }
    }

    const { error } = await db
      .from("patients")
      .update({ payment_plan_until: until })
      .eq("id", patientId)
      .eq("clinic_id", profile.clinic_id);

    if (error) {
      console.error("[setPaymentPlan]", error.message);
      return { data: null, error: "Could not update the payment plan." };
    }

    revalidatePath(`/${profile.role}/payments`);
    revalidatePath(`/${profile.role}/patients/${patientId}`);
    return { data: { paymentPlanUntil: until }, error: null };
  } catch (err) {
    console.error("[setPaymentPlan] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** Clinic timezone, without pulling in the full clinic-config module here. */
async function getClinicConfigFor(
  clinicId: string,
  db: Awaited<ReturnType<typeof resolveCachedSession>>["db"],
): Promise<{ timezone: string }> {
  const { data } = await db
    .from("clinic_settings")
    .select("timezone")
    .eq("clinic_id", clinicId)
    .maybeSingle();
  return { timezone: data?.timezone ?? "Asia/Kolkata" };
}
