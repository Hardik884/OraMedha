"use server";

import { createServerClient } from "@/lib/supabase/server";
import { resolveSession as resolveCachedSession } from "@/lib/auth/session";
import { resolveSignatureUrl } from "@/lib/signatures/resolve";
import { getTodayInTimezone } from "@/lib/utils";
import {
  allocateCollectionsToTreatments,
  type PayoutPaymentLike,
  type PayoutTreatmentLike,
} from "@/lib/billing/payout";
import {
  buildAppointmentBillSummary,
  buildBill,
  buildBillSummaries,
  buildInvoiceNumber,
  sumPaidForAppointment,
  type AttributablePayment,
  type Bill,
  type BillStatus,
  type BillSummary,
  type BillableTreatmentLike,
} from "@/lib/billing/invoice";
import type { ActionResult } from "@/types";
import { resolveDentistIdentities } from "@/lib/staff/dentist-directory";

/**
 * Billing (Bill / Invoice) Server Actions
 *
 * Reads only — nothing here creates, edits or deletes a treatment or a
 * payment. Every figure on a bill is computed from `lib/billing/balance.ts`
 * and `lib/billing/payout.ts`, the same canonical helpers
 * `actions/payments.ts`, `PatientPaymentsTab` and `AppointmentPaymentsSection`
 * already use — see `lib/billing/invoice.ts` for the assembly layer.
 *
 * Security rules (enforced in every action):
 * - Staff actions: clinic_id ALWAYS from the server session; forbidden to the
 *   `patient` role.
 * - Portal actions: patient_id is ALWAYS resolved from
 *   `patient_portal_links.user_id = auth.uid()` — never from a client-
 *   supplied id — and every subsequent query (including the ownership check
 *   on a single treatment/appointment) is scoped to that resolved id.
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

const TREATMENT_BILLING_FIELDS =
  "id, patient_id, appointment_id, treatment_type, cost, status, opd_charged, opd_fee, xray_taken, xray_cost, performed_at, created_at";

export type BillClinicInfo = {
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  registrationNumber: string | null;
};

export type BillDentistInfo = {
  name: string;
  signatureUrl: string | null;
};

export type BillPatientInfo = {
  id: string;
  name: string;
  phone: string | null;
};

export type BillAppointmentInfo = {
  id: string;
  scheduledAt: string;
};

/** Everything the invoice renderer needs, in one shape — the ONE canonical bill document. */
export interface BillDocument {
  bill: Bill;
  patient: BillPatientInfo;
  appointment: BillAppointmentInfo;
  clinic: BillClinicInfo;
  dentist: BillDentistInfo;
  /** Clinic's IANA timezone, for rendering the invoice date the same way it
   * was computed (getTodayInTimezone). */
  timezone: string;
}

async function fetchClinicInfo(
  db: DbClient,
  clinicId: string
): Promise<{ info: BillClinicInfo; timezone: string }> {
  const { data } = await db
    .from("clinic_settings")
    .select("clinic_name, address, phone, email, registration_number, timezone")
    .eq("clinic_id", clinicId)
    .maybeSingle();

  return {
    info: {
      name: (data?.clinic_name as string | undefined) ?? "Dental Clinic",
      address: (data?.address as string | null | undefined) ?? null,
      phone: (data?.phone as string | null | undefined) ?? null,
      email: (data?.email as string | null | undefined) ?? null,
      registrationNumber:
        (data?.registration_number as string | null | undefined) ?? null,
    },
    timezone: (data?.timezone as string | undefined) ?? "Asia/Kolkata",
  };
}

/**
 * The dentist named on a bill.
 *
 * The identity is read through the dentist directory (service role) because
 * this runs for the PORTAL bill as well as the staff one, and a portal patient
 * no longer has any read on a staff profiles row (migration 20260905090000).
 * `dentistId` always comes from an appointment the caller has already been
 * authorised for. `db` stays the caller's client — it is used only to sign the
 * signature object, which is a storage operation, not a profiles read.
 */
async function fetchDentistInfo(
  db: DbClient,
  dentistId: string
): Promise<BillDentistInfo> {
  const data = (await resolveDentistIdentities([dentistId])).get(dentistId);

  return {
    name: (data?.full_name as string | undefined) ?? "Dentist",
    // The stored value is an object path in a private bucket (or, on rows
    // written before 20260903000400, a legacy public URL). Either way it has to
    // be signed before a browser can render it.
    signatureUrl: await resolveSignatureUrl(
      db,
      data?.signature_url as string | null | undefined
    ),
  };
}

/**
 * Pooled collections for a patient, scoped to the caller's clinic. Runs the
 * canonical allocator over the patient's ENTIRE billable-treatment and
 * payment history — the same requirement `getPatientTreatmentCollections`
 * documents — so a bill's "Paid" figure always matches what the payments
 * panel shows for the same treatments, regardless of which visit they're
 * being viewed from.
 */
async function fetchPatientCollections(
  db: DbClient,
  clinicId: string,
  patientId: string
): Promise<Record<string, number>> {
  const [{ data: treatmentRows }, { data: paymentRows }] = await Promise.all([
    db
      .from("treatments")
      .select(
        "id, cost, status, opd_charged, opd_fee, xray_taken, xray_cost, performed_at, created_at"
      )
      .eq("patient_id", patientId)
      .eq("clinic_id", clinicId)
      .is("deleted_at", null)
      .in("status", ["completed", "in_progress"]),
    db
      .from("payments")
      .select("amount, treatment_id")
      .eq("patient_id", patientId)
      .eq("clinic_id", clinicId)
      .is("deleted_at", null),
  ]);

  const allocation = allocateCollectionsToTreatments(
    (treatmentRows ?? []) as PayoutTreatmentLike[],
    (paymentRows ?? []) as PayoutPaymentLike[]
  );
  const result: Record<string, number> = {};
  for (const [id, amount] of allocation) result[id] = amount;
  return result;
}

/**
 * A patient's non-deleted payments carrying just the fields the bill layer
 * needs to attribute each one to an appointment. Used to compute a bill's
 * "Paid" via `sumPaidForAppointment` — the single source of truth shared with
 * the clinic-wide Billing list.
 */
async function fetchPatientAttributablePayments(
  db: DbClient,
  clinicId: string,
  patientId: string
): Promise<AttributablePayment[]> {
  const { data } = await db
    .from("payments")
    .select("amount, appointment_id, treatment_id")
    .eq("patient_id", patientId)
    .eq("clinic_id", clinicId)
    .is("deleted_at", null);
  return (data ?? []) as AttributablePayment[];
}

// =============================================================================
// getStaffBill — dentist + receptionist, clinic-scoped
//
// appointmentId is required (a bill is always anchored to a visit). Pass
// treatmentId to scope the bill to a single treatment recorded on that visit
// — the SAME data path, just filtered to one line, which is how a per-
// treatment bill and a whole-visit bill stay one canonical renderer rather
// than two.
// =============================================================================

export async function getStaffBill(
  appointmentId: string,
  treatmentId?: string
): Promise<ActionResult<BillDocument>> {
  try {
    if (!appointmentId) return { data: null, error: "Appointment ID is required" };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role === "patient") return { data: null, error: "Forbidden" };

    const { data: appt } = await db
      .from("appointments")
      .select("id, patient_id, dentist_id, scheduled_at")
      .eq("id", appointmentId)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null)
      .single();

    if (!appt) return { data: null, error: "Appointment not found." };

    const { data: patient } = await db
      .from("patients")
      .select("id, name, phone")
      .eq("id", appt.patient_id)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null)
      .single();

    if (!patient) return { data: null, error: "Patient not found." };

    const { data: apptTreatmentRows, error: treatmentsError } = await db
      .from("treatments")
      .select(TREATMENT_BILLING_FIELDS)
      .eq("appointment_id", appointmentId)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null);

    if (treatmentsError) {
      console.error("[getStaffBill]", treatmentsError);
      return { data: null, error: "Failed to load the visit's treatments." };
    }

    const allApptTreatments = (apptTreatmentRows ?? []) as BillableTreatmentLike[];
    // The full appointment's treatment ids — used to attribute payments to the
    // visit even when the bill is later filtered to a single treatment.
    const allApptTreatmentIds = new Set(allApptTreatments.map((t) => t.id));

    let treatments = allApptTreatments;
    if (treatmentId) {
      treatments = allApptTreatments.filter((t) => t.id === treatmentId);
      if (treatments.length === 0) {
        return { data: null, error: "Treatment not found on this visit." };
      }
    }

    const { info: clinic, timezone } = await fetchClinicInfo(db, profile.clinic_id);
    const dentist = await fetchDentistInfo(db, appt.dentist_id);

    // "Paid" derivation, scoped to what the bill covers:
    //  - Whole-visit bill: the canonical per-appointment sum shared with the
    //    Billing list (sumPaidForAppointment) — counts every attributed
    //    payment exactly once and surfaces overpayment.
    //  - Single-treatment bill (?treatment=): the pooled per-treatment
    //    collected figure, so a treatment bill matches the per-treatment lists
    //    (PatientBillListView / portal) that use the same pooled allocation.
    let paid: number;
    if (treatmentId) {
      const collectedByTreatment = await fetchPatientCollections(
        db,
        profile.clinic_id,
        appt.patient_id
      );
      paid = collectedByTreatment[treatmentId] ?? 0;
    } else {
      const payments = await fetchPatientAttributablePayments(
        db,
        profile.clinic_id,
        appt.patient_id
      );
      paid = sumPaidForAppointment(payments, appointmentId, allApptTreatmentIds);
    }

    const invoiceIdSource = treatmentId ?? appointmentId;
    const bill = buildBill(treatments, paid, {
      invoiceNumber: buildInvoiceNumber("INV", invoiceIdSource),
      invoiceDate: getTodayInTimezone(timezone),
    });

    return {
      data: {
        bill,
        patient: { id: patient.id, name: patient.name, phone: patient.phone },
        appointment: { id: appt.id, scheduledAt: appt.scheduled_at },
        clinic,
        dentist,
        timezone,
      },
      error: null,
    };
  } catch (err) {
    console.error("[getStaffBill] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getPatientBillsList — every treatment-with-a-charge for a patient, across
// all their visits. Staff only, clinic-scoped. Powers the "Bill" list inside
// the patient profile's Billing & Payments tab.
// =============================================================================

export async function getPatientBillsList(
  patientId: string
): Promise<ActionResult<BillSummary[]>> {
  try {
    if (!patientId) return { data: [], error: null };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role === "patient") return { data: null, error: "Forbidden" };

    const { data: treatmentRows, error } = await db
      .from("treatments")
      .select(TREATMENT_BILLING_FIELDS)
      .eq("patient_id", patientId)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null)
      .order("performed_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[getPatientBillsList]", error);
      return { data: null, error: "Failed to load bills." };
    }

    const treatments = (treatmentRows ?? []) as (BillableTreatmentLike & {
      appointment_id: string | null;
    })[];

    const collectedByTreatment = await fetchPatientCollections(
      db,
      profile.clinic_id,
      patientId
    );

    const summaries = buildBillSummaries(treatments, collectedByTreatment).map(
      (s) => ({
        ...s,
        appointmentId:
          treatments.find((t) => t.id === s.treatmentId)?.appointment_id ??
          null,
      })
    );

    return { data: summaries, error: null };
  } catch (err) {
    console.error("[getPatientBillsList] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getClinicBillsList — clinic-wide, one row per APPOINTMENT with billable
// financial activity. Staff only, clinic-scoped. Powers the "Billing" view
// inside /dentist/payments and /receptionist/payments (Payments remains the
// default view on both pages — this is an additional panel, not a
// replacement).
// =============================================================================

export interface ClinicBillListItem {
  appointmentId: string;
  patientId: string;
  patientName: string;
  patientPhone: string | null;
  appointmentDate: string;
  treatmentDescription: string;
  total: number;
  paid: number;
  balanceDue: number;
  overpayment: number;
  status: BillStatus;
}

export async function getClinicBillsList(params?: {
  page?: number;
  limit?: number;
  search?: string;
}): Promise<ActionResult<{ bills: ClinicBillListItem[]; total: number }>> {
  try {
    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role === "patient") return { data: null, error: "Forbidden" };

    const cid = profile.clinic_id;
    const page = Math.max(1, params?.page ?? 1);
    const limit = Math.max(1, Math.min(100, params?.limit ?? 20));

    // Clinic-wide treatments + payments, loaded once and aggregated in
    // memory — the same unpaginated-fetch-then-aggregate pattern
    // `getPatientsWithOutstandingBalance` (actions/payments.ts) already uses
    // for a clinic-wide figure; nothing new architecturally.
    const [{ data: treatmentRows, error: treatmentsError }, { data: paymentRows, error: paymentsError }] =
      await Promise.all([
        db
          .from("treatments")
          .select(
            "id, patient_id, appointment_id, treatment_type, cost, status, opd_charged, opd_fee, xray_taken, xray_cost, performed_at, created_at"
          )
          .eq("clinic_id", cid)
          .is("deleted_at", null),
        db
          .from("payments")
          .select("amount, treatment_id, appointment_id, patient_id")
          .eq("clinic_id", cid)
          .is("deleted_at", null),
      ]);

    if (treatmentsError || paymentsError) {
      console.error("[getClinicBillsList]", treatmentsError ?? paymentsError);
      return { data: null, error: "Failed to load bills." };
    }

    type TreatmentRow = BillableTreatmentLike & {
      patient_id: string;
      appointment_id: string | null;
    };
    type PaymentRow = {
      amount: number;
      treatment_id: string | null;
      appointment_id: string | null;
      patient_id: string;
    };

    const treatments = (treatmentRows ?? []) as TreatmentRow[];
    const payments = (paymentRows ?? []) as PaymentRow[];

    // Group every (any-status) treatment by appointment — a planned
    // treatment contributes nothing to `total` itself, but an OPD/X-ray
    // charge recorded against it still does (treatmentTotalCharge), so it
    // must stay in the group for the aggregation to be complete. Also collect
    // each appointment's treatment ids, so a payment linked to a treatment can
    // be attributed to the right visit.
    const treatmentsByAppointment = new Map<string, TreatmentRow[]>();
    const treatmentIdsByAppointment = new Map<string, Set<string>>();
    const patientIdByAppointment = new Map<string, string>();
    for (const t of treatments) {
      if (!t.appointment_id) continue;
      const list = treatmentsByAppointment.get(t.appointment_id);
      if (list) list.push(t);
      else treatmentsByAppointment.set(t.appointment_id, [t]);
      const idSet = treatmentIdsByAppointment.get(t.appointment_id);
      if (idSet) idSet.add(t.id);
      else treatmentIdsByAppointment.set(t.appointment_id, new Set([t.id]));
      patientIdByAppointment.set(t.appointment_id, t.patient_id);
    }
    for (const p of payments) {
      if (p.appointment_id && !patientIdByAppointment.has(p.appointment_id)) {
        patientIdByAppointment.set(p.appointment_id, p.patient_id);
      }
    }

    // Every appointment with billable financial activity: has charged
    // treatments, OR has any payment recorded against it directly.
    const candidateAppointmentIds = new Set<string>([
      ...treatmentsByAppointment.keys(),
      ...payments.filter((p) => p.appointment_id).map((p) => p.appointment_id as string),
    ]);

    if (candidateAppointmentIds.size === 0) {
      return { data: { bills: [], total: 0 }, error: null };
    }

    const [{ data: apptRows }, { data: patientRows }] = await Promise.all([
      db
        .from("appointments")
        .select("id, patient_id, scheduled_at")
        .in("id", Array.from(candidateAppointmentIds))
        .eq("clinic_id", cid)
        .is("deleted_at", null),
      db
        .from("patients")
        .select("id, name, phone")
        .in("id", Array.from(new Set(patientIdByAppointment.values())))
        .eq("clinic_id", cid)
        .is("deleted_at", null),
    ]);

    const apptById = new Map(
      ((apptRows ?? []) as { id: string; patient_id: string; scheduled_at: string }[]).map(
        (a) => [a.id, a]
      )
    );
    const patientById = new Map(
      ((patientRows ?? []) as { id: string; name: string; phone: string | null }[]).map((p) => [
        p.id,
        p,
      ])
    );

    let rows: ClinicBillListItem[] = [];
    for (const appointmentId of candidateAppointmentIds) {
      const appt = apptById.get(appointmentId);
      if (!appt) continue; // soft-deleted / cross-clinic — excluded by the query filters above already

      const patient = patientById.get(appt.patient_id);
      if (!patient) continue;

      // Paid via the SAME canonical per-appointment sum the individual bill
      // detail (getStaffBill → buildBill) uses, so a row here and its opened
      // invoice are guaranteed identical. Each payment counted exactly once.
      const paid = sumPaidForAppointment(
        payments,
        appointmentId,
        treatmentIdsByAppointment.get(appointmentId) ?? new Set<string>()
      );

      const summary = buildAppointmentBillSummary(
        treatmentsByAppointment.get(appointmentId) ?? [],
        paid
      );

      // Nothing billable actually happened on this visit — exclude it.
      if (summary.total <= 0 && summary.paid <= 0) continue;

      rows.push({
        appointmentId,
        patientId: appt.patient_id,
        patientName: patient.name,
        patientPhone: patient.phone,
        appointmentDate: appt.scheduled_at,
        treatmentDescription: summary.treatmentDescription,
        total: summary.total,
        paid: summary.paid,
        balanceDue: summary.balanceDue,
        overpayment: summary.overpayment,
        status: summary.status,
      });
    }

    const search = params?.search?.trim().toLowerCase();
    if (search) {
      rows = rows.filter(
        (r) =>
          r.patientName.toLowerCase().includes(search) ||
          (r.patientPhone ?? "").toLowerCase().includes(search)
      );
    }

    rows.sort((a, b) => (a.appointmentDate < b.appointmentDate ? 1 : -1));

    const total = rows.length;
    const from = (page - 1) * limit;
    const paged = rows.slice(from, from + limit);

    return { data: { bills: paged, total }, error: null };
  } catch (err) {
    console.error("[getClinicBillsList] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// Patient portal — patient_id ALWAYS resolved via patient_portal_links,
// NEVER trusted from the client.
// =============================================================================

async function resolvePortalPatient(): Promise<
  | { ok: true; db: DbClient; patientId: string; clinicId: string }
  | { ok: false; error: string }
> {
  const supabase = await createServerClient();
  const db: DbClient = supabase;

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Unauthorized" };

  const { data: link } = await db
    .from("patient_portal_links")
    .select("patient_id, patients(clinic_id)")
    .eq("user_id", user.id)
    .single();

  if (!link?.patient_id) {
    return { ok: false, error: "Portal account not linked." };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clinicId = (link as any).patients?.clinic_id ?? null;
  if (!clinicId) return { ok: false, error: "Portal account not linked." };

  return { ok: true, db, patientId: link.patient_id, clinicId };
}

// =============================================================================
// getPortalBillsList — the authenticated patient's own bills only.
// =============================================================================

export async function getPortalBillsList(): Promise<ActionResult<BillSummary[]>> {
  try {
    const resolved = await resolvePortalPatient();
    if (!resolved.ok) return { data: null, error: resolved.error };
    const { db, patientId, clinicId } = resolved;

    // RLS additionally enforces patient_id = auth_patient_id() on this table;
    // the explicit filter here keeps the query self-describing and correct
    // even if RLS were ever misconfigured.
    const { data: treatmentRows, error } = await db
      .from("treatments")
      .select(TREATMENT_BILLING_FIELDS)
      .eq("patient_id", patientId)
      .is("deleted_at", null)
      .order("performed_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[getPortalBillsList]", error);
      return { data: null, error: "Failed to load your bills." };
    }

    const treatments = (treatmentRows ?? []) as (BillableTreatmentLike & {
      appointment_id: string | null;
    })[];

    const collectedByTreatment = await fetchPatientCollections(
      db,
      clinicId,
      patientId
    );

    const summaries = buildBillSummaries(treatments, collectedByTreatment).map(
      (s) => ({
        ...s,
        appointmentId:
          treatments.find((t) => t.id === s.treatmentId)?.appointment_id ??
          null,
      })
    );

    return { data: summaries, error: null };
  } catch (err) {
    console.error("[getPortalBillsList] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getPortalTreatmentBill — one treatment's bill, for the authenticated
// patient ONLY. Verifies the treatment belongs to the resolved patient_id
// before returning anything — a treatment id for another patient returns the
// same "not found" a missing id would, never leaking that the row exists.
// =============================================================================

export async function getPortalTreatmentBill(
  treatmentId: string
): Promise<ActionResult<BillDocument>> {
  try {
    if (!treatmentId) return { data: null, error: "Treatment ID is required" };

    const resolved = await resolvePortalPatient();
    if (!resolved.ok) return { data: null, error: resolved.error };
    const { db, patientId, clinicId } = resolved;

    const { data: treatmentRow } = await db
      .from("treatments")
      .select(TREATMENT_BILLING_FIELDS)
      .eq("id", treatmentId)
      .eq("patient_id", patientId)
      .is("deleted_at", null)
      .maybeSingle();

    if (!treatmentRow) {
      // Deliberately the same message whether the id doesn't exist or belongs
      // to a different patient — never confirms another patient's data exists.
      return { data: null, error: "Bill not found." };
    }

    const treatment = treatmentRow as BillableTreatmentLike & {
      appointment_id: string | null;
    };
    if (!treatment.appointment_id) {
      return { data: null, error: "Bill not found." };
    }

    const { data: appt } = await db
      .from("appointments")
      .select("id, patient_id, dentist_id, scheduled_at")
      .eq("id", treatment.appointment_id)
      .eq("patient_id", patientId)
      .is("deleted_at", null)
      .maybeSingle();

    if (!appt) return { data: null, error: "Bill not found." };

    const { data: patient } = await db
      .from("patients")
      .select("id, name, phone")
      .eq("id", patientId)
      .maybeSingle();

    if (!patient) return { data: null, error: "Bill not found." };

    const [collectedByTreatment, { info: clinic, timezone }, dentist] =
      await Promise.all([
        fetchPatientCollections(db, clinicId, patientId),
        fetchClinicInfo(db, clinicId),
        fetchDentistInfo(db, appt.dentist_id),
      ]);

    // A single-treatment (portal) bill reflects the pooled per-treatment
    // collected amount, so it matches the per-treatment "My Bills" list that
    // uses the same pooled allocation.
    const paid = collectedByTreatment[treatmentId] ?? 0;
    const bill = buildBill([treatment], paid, {
      invoiceNumber: buildInvoiceNumber("INV", treatmentId),
      invoiceDate: getTodayInTimezone(timezone),
    });

    return {
      data: {
        bill,
        patient: { id: patient.id, name: patient.name, phone: patient.phone },
        appointment: { id: appt.id, scheduledAt: appt.scheduled_at },
        clinic,
        dentist,
        timezone,
      },
      error: null,
    };
  } catch (err) {
    console.error("[getPortalTreatmentBill] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}
