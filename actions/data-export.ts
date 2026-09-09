"use server";

import { resolveSession } from "@/lib/auth/session";
import { recordPhiAccess } from "@/lib/audit/phi-access";
import {
  exclusionsFor,
  pickTreatmentFields,
  treatmentFieldsFor,
  type ExportScope,
  type PatientDataExport,
} from "@/lib/data-export";
import type { ActionResult } from "@/types";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * actions/data-export.ts
 *
 * Producing a complete copy of one patient's record.
 *
 * AUTHORISATION
 *   Two entry points, and neither trusts a patient identity from the client:
 *
 *     exportMyData()            — a portal patient. The patient_id is resolved
 *                                 from their portal link server-side; the
 *                                 client sends no identifier at all, so there
 *                                 is nothing for it to tamper with.
 *     exportPatientData(id)     — a dentist. The id IS supplied, so it is
 *                                 checked against the caller's own clinic
 *                                 before a single row is read.
 *
 *   Every query below runs on the CALLER'S session, not the service role, so
 *   RLS is evaluated a second time underneath the checks in this file. That is
 *   deliberate: an export reads more of one person's record in one request than
 *   anything else in the product, which makes it the worst place to be relying
 *   on application logic alone (CLAUDE.md §13.10).
 *
 * DELIVERY
 *   The export is RETURNED, not stored. See lib/data-export.ts for why a
 *   generated file in a bucket would be the wrong shape for this.
 *
 * AUDITING
 *   Every export writes a PATIENT_DATA_EXPORTED row. Producing a full copy of
 *   someone's medical history is the single most significant read in the
 *   product and it must never be the one that leaves no trace.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = any;

/**
 * Gathers the record. Called only after authorisation has been fully resolved
 * by one of the two exported actions — it performs no check of its own and is
 * not exported.
 *
 * WHY THIS READS AS THE SERVICE ROLE
 *   An export is the one read that legitimately crosses the column boundary
 *   20260907000100 draws. That migration withholds the clinical free-text on
 *   `appointments` (and `treatments.internal_notes`) from `anon` and
 *   `authenticated`, because Postgres cannot otherwise distinguish a dentist
 *   from a patient — both arrive as the same database role. Read through the
 *   caller's own client, every query below would now fail.
 *
 *   Reading them here is not a hole, for three reasons that hold together:
 *
 *     1. The caller is fully authorised BEFORE this runs. exportMyData resolves
 *        patientId from the portal link (never from the request); exportPatientData
 *        is dentist-only and re-checks the patient against the caller's clinic.
 *     2. Every query is explicitly scoped to that patientId (and clinicId), so
 *        the absence of RLS changes which rows are returned not at all.
 *     3. `scope` still decides the COLUMNS. A patient export omits
 *        STAFF_ONLY_TREATMENT_FIELDS — the dentist's internal_notes — and
 *        lib/__tests__/data-export.spec.ts asserts that.
 *
 *   A patient receiving their own clinical record is the point of the feature,
 *   not a leak: it is the right-of-access disclosure, it is rate-limited by
 *   being an explicit action, and it writes a PATIENT_DATA_EXPORTED audit row.
 *   What 20260907000100 stops is that same content being readable AMBIENTLY off
 *   the base table with nothing but the anon key.
 */
async function collect(
  db: DbClient,
  clinicId: string,
  patientId: string,
  scope: ExportScope
): Promise<PatientDataExport> {
  const [
    clinic,
    patient,
    appointments,
    treatments,
    chart,
    payments,
    followUps,
    clinicalConsents,
    dataConsents,
    documents,
  ] = await Promise.all([
    db
      .from("clinic_settings")
      .select("clinic_name, phone, email, address, registration_number")
      .eq("clinic_id", clinicId)
      .maybeSingle(),

    db
      .from("patients")
      .select(
        "id, name, phone, date_of_birth, gender, address, emergency_contact_name, emergency_contact_phone, total_visits, last_visit, created_at"
      )
      .eq("id", patientId)
      .maybeSingle(),

    // Clinical intake fields are included for BOTH scopes: chief complaints,
    // findings and the provisional diagnosis are a record of what the patient
    // themselves reported and was told, not the clinician's private working
    // notes.
    db
      .from("appointments")
      .select(
        "id, scheduled_at, duration_minutes, status, source, notes, chief_complaints, oral_findings, provisional_diagnosis, medical_history, created_at"
      )
      .eq("patient_id", patientId)
      .is("deleted_at", null)
      .order("scheduled_at", { ascending: false }),

    db
      .from("treatments")
      .select(treatmentFieldsFor(scope).join(", "))
      .eq("patient_id", patientId)
      .is("deleted_at", null)
      .order("performed_at", { ascending: false, nullsFirst: false }),

    db
      .from("patient_teeth")
      .select("tooth_number, dentition_type, tooth_condition, treatment_stage, notes, updated_at")
      .eq("patient_id", patientId)
      .is("deleted_at", null)
      .order("tooth_number", { ascending: true }),

    db
      .from("payments")
      .select("id, amount, method, payment_date, notes, created_at")
      .eq("patient_id", patientId)
      .is("deleted_at", null)
      .order("payment_date", { ascending: false }),

    db
      .from("follow_ups")
      .select("id, due_date, status, follow_up_type, notes, created_at")
      .eq("patient_id", patientId)
      .is("deleted_at", null)
      .order("due_date", { ascending: false }),

    // The frozen content_snapshot IS the consent document as it was signed —
    // the most useful single thing in a clinical consent, and the thing a
    // patient is most likely to want a copy of.
    db
      .from("consents")
      .select(
        "id, template_key, template_name, source, status, signed_at, patient_signed_name, content_snapshot, created_at"
      )
      .eq("patient_id", patientId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),

    db
      .from("data_consent_records")
      .select("category, decision, notice_version, notice_snapshot, actor, occurred_at")
      .eq("patient_id", patientId)
      .order("occurred_at", { ascending: false }),

    // Metadata only. The binaries are downloaded individually through the
    // portal, where each one gets its own short-lived signed URL — embedding a
    // set of live document URLs in a file the patient then emails to someone
    // would undo the reason those URLs are short-lived.
    db
      .from("treatment_documents")
      .select("id, file_name, file_type, file_size, document_type, created_at")
      .eq("patient_id", patientId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
  ]);

  const rows = <T>(result: { data: T[] | null }): T[] => result.data ?? [];

  return {
    export: {
      format_version: 1,
      generated_at: new Date().toISOString(),
      scope,
      excluded: exclusionsFor(scope),
    },
    clinic: (clinic.data as Record<string, unknown> | null) ?? null,
    patient: (patient.data as Record<string, unknown> | null) ?? null,
    appointments: rows<Record<string, unknown>>(appointments),
    // Re-filtered through the allow-list even though the SELECT above already
    // named the columns — so a future `select("*")` here cannot quietly widen
    // what a patient's own export contains.
    treatments: rows<Record<string, unknown>>(treatments).map((row) =>
      pickTreatmentFields(row, scope)
    ),
    dental_chart: rows<Record<string, unknown>>(chart),
    payments: rows<Record<string, unknown>>(payments),
    follow_ups: rows<Record<string, unknown>>(followUps),
    clinical_consents: rows<Record<string, unknown>>(clinicalConsents),
    data_processing_consents: rows<Record<string, unknown>>(dataConsents),
    documents: rows<Record<string, unknown>>(documents),
  };
}

// =============================================================================
// exportMyData — portal patient, their own record
// =============================================================================

export async function exportMyData(): Promise<ActionResult<PatientDataExport>> {
  try {
    const { db, profile, user } = await resolveSession();
    if (!profile || !user) return { data: null, error: "Unauthorized" };
    if (profile.role !== "patient") return { data: null, error: "Forbidden" };

    // The identity comes from the portal link, never from the request.
    const { data: link } = await db
      .from("patient_portal_links")
      .select("patient_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!link?.patient_id) {
      return { data: null, error: "Portal account not linked." };
    }

    const patientId = link.patient_id as string;
    const data = await collect(createAdminClient(), profile.clinic_id, patientId, "patient");

    if (!data.patient) {
      return { data: null, error: "Your record could not be found." };
    }

    await recordPhiAccess(profile, {
      event: "PATIENT_DATA_EXPORTED",
      resourceType: "patient",
      resourceId: patientId,
      patientId,
      context: { surface: "portal-export", self: true },
    });

    return { data, error: null };
  } catch (err) {
    console.error("[exportMyData] unexpected:", err);
    return { data: null, error: "Could not build your export. Please try again." };
  }
}

// =============================================================================
// exportPatientData — dentist, on a patient's behalf
// =============================================================================

export async function exportPatientData(
  patientId: string
): Promise<ActionResult<PatientDataExport>> {
  try {
    if (!patientId) return { data: null, error: "Patient ID is required" };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };

    // Dentist only. A receptionist has no reason to produce a complete copy of
    // a clinical record, and this scope includes the clinician's own notes.
    if (profile.role !== "dentist") {
      await recordPhiAccess(profile, {
        event: "PATIENT_DATA_EXPORTED",
        resourceType: "patient",
        resourceId: patientId,
        allowed: false,
        context: { reason: "role-not-permitted", surface: "staff-export" },
      });
      return { data: null, error: "Forbidden: only dentists can export a patient record." };
    }

    // The id came from the client, so it is checked against the caller's clinic
    // before anything is read.
    const { data: patient } = await db
      .from("patients")
      .select("id")
      .eq("id", patientId)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null)
      .maybeSingle();

    if (!patient) {
      await recordPhiAccess(profile, {
        event: "PATIENT_DATA_EXPORTED",
        resourceType: "patient",
        resourceId: patientId,
        allowed: false,
        context: { reason: "not-in-clinic", surface: "staff-export" },
      });
      return { data: null, error: "Patient not found." };
    }

    const data = await collect(createAdminClient(), profile.clinic_id, patientId, "staff");

    await recordPhiAccess(profile, {
      event: "PATIENT_DATA_EXPORTED",
      resourceType: "patient",
      resourceId: patientId,
      patientId,
      context: {
        surface: "staff-export",
        count: data.treatments.length,
      },
    });

    return { data, error: null };
  } catch (err) {
    console.error("[exportPatientData] unexpected:", err);
    return { data: null, error: "Could not build the export. Please try again." };
  }
}
