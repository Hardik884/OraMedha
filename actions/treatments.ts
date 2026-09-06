"use server";

import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { resolveSession as resolveCachedSession } from "@/lib/auth/session";
import { recordPhiAccess, recordPhiAccessBatch } from "@/lib/audit/phi-access";
import { diffFields, writeTreatmentHistory } from "@/lib/treatments/history";
import { resolveSignatureUrls } from "@/lib/signatures/resolve";
import {
  actualContentType,
  assertContentMatchesType,
} from "@/lib/security/file-validation";
import { DOCUMENT_URL_TTL_SECONDS } from "@/lib/storage/signed-urls";
import {
  CreateTreatmentSchema,
  UpdateTreatmentSchema,
  CreateTreatmentDocumentSchema,
  type ActionResult,
  type Treatment,
  type TreatmentDocument,
  type TreatmentForReceptionist,
  type TreatmentForPatient,
  type TreatmentForPatientWithSignature,
  type TreatmentHistoryItem,
} from "@/types";
import { getUtcBoundariesForLocalDate } from "@/lib/utils";
import { DEFAULT_TIMEZONE } from "@/lib/clinic/constants";
import {
  DOCUMENT_BUCKET,
  ALLOWED_DOCUMENT_TYPES,
} from "@/lib/treatments/constants";
import { computeConsultantSplit } from "@/lib/billing/revenue";
import { syncToothForTreatment } from "@/lib/dental-chart/sync";
import { resolveDentistIdentities } from "@/lib/staff/dentist-directory";

/**
 * Revenue-distribution columns to persist on a treatment.
 * `clinic_share` is always populated (equals cost when no consultant), so
 * analytics can rely on it as the single source of truth for net revenue.
 */
interface ConsultantRevenueFields {
  consultant_id: string | null;
  commission_type: "percentage" | "fixed" | null;
  commission_value: number | null;
  consultant_share: number;
  clinic_share: number;
}

/**
 * Validate the consultant selection against the clinic directory and compute
 * the consultant / clinic split. Returns the DB fields to persist, or an error.
 */
async function resolveConsultantRevenue(
  db: DbClient,
  clinicId: string,
  gross: number,
  consultantId: string | undefined,
  commissionType: "percentage" | "fixed" | undefined,
  commissionValue: number | undefined
): Promise<{ ok: true; fields: ConsultantRevenueFields } | { ok: false; error: string }> {
  // No consultant → treating dentist; clinic keeps the full gross amount.
  if (!consultantId) {
    return {
      ok: true,
      fields: {
        consultant_id: null,
        commission_type: null,
        commission_value: null,
        consultant_share: 0,
        clinic_share: computeConsultantSplit(gross, null, null).clinicShare,
      },
    };
  }

  if (!commissionType) {
    return { ok: false, error: "Select a compensation type for the consultant." };
  }
  if (commissionValue == null || !Number.isFinite(commissionValue)) {
    return { ok: false, error: "Enter the consultant compensation value." };
  }
  if (commissionType === "percentage" && (commissionValue < 0 || commissionValue > 100)) {
    return { ok: false, error: "Consultant percentage must be between 0 and 100." };
  }
  if (commissionType === "fixed" && commissionValue > gross) {
    return { ok: false, error: "Consultant amount cannot exceed the treatment amount." };
  }

  // Consultant must belong to the caller's clinic and be active.
  const { data: consultant } = await db
    .from("consultants")
    .select("id")
    .eq("id", consultantId)
    .eq("clinic_id", clinicId)
    .eq("is_active", true)
    .maybeSingle();

  if (!consultant) {
    return { ok: false, error: "Selected consultant was not found." };
  }

  const split = computeConsultantSplit(gross, commissionType, commissionValue);
  return {
    ok: true,
    fields: {
      consultant_id: consultantId,
      commission_type: commissionType,
      commission_value: commissionValue,
      consultant_share: split.consultantShare,
      clinic_share: split.clinicShare,
    },
  };
}

/**
 * Treatment Server Actions
 *
 * Security rules (enforced in every action):
 * - clinic_id is ALWAYS sourced from the server session.
 * - internal_notes are NEVER returned in receptionist or patient paths.
 * - Dentist path: queries base treatments table (full record).
 * - Receptionist path: excludes internal_notes (applied in query).
 * - Patient path: patient_visible_notes only, via patient portal link.
 * - Only dentist can create / update / delete treatments.
 * - Soft-deleted treatments excluded from all default queries.
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
// createTreatment — dentist only
// =============================================================================

/**
 * The consultation fee to record on a treatment, resolved SERVER-SIDE.
 *
 * The receptionist ticks a box; they never type an amount. The fee comes from
 * the clinic's own setting, which is the whole point of the toggle — one less
 * number to get wrong at the front desk, and one less way for two visits on the
 * same day to be billed differently.
 *
 * Snapshotted rather than looked up at read time. `default_opd_fee` is the
 * CURRENT fee, so reading it live would re-price every past visit the moment a
 * clinic changed its rate — a bill from March silently becoming a different
 * number in August. A financial record keeps the price it was charged at.
 *
 * Returns 0 when OPD is off, and also when the clinic has configured no fee:
 * charging an amount nobody set would be inventing a price.
 */
async function resolveOpdFee(
  db: DbClient,
  clinicId: string,
  opdCharged: boolean,
): Promise<number> {
  if (!opdCharged) return 0;
  const { data } = await db
    .from("clinic_settings")
    .select("default_opd_fee")
    .eq("clinic_id", clinicId)
    .maybeSingle();
  const fee = Number((data as { default_opd_fee?: number | null } | null)?.default_opd_fee ?? 0);
  return Number.isFinite(fee) && fee > 0 ? fee : 0;
}

export async function createTreatment(
  input: unknown
): Promise<ActionResult<Treatment>> {
  try {
    const parsed = CreateTreatmentSchema.safeParse(input);
    if (!parsed.success) {
      return {
        data: null,
        error: parsed.error.errors[0]?.message ?? "Invalid input",
      };
    }

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist") {
      return { data: null, error: "Forbidden: only dentists can create treatments." };
    }

    // Normalise performed_at: "YYYY-MM-DD" and "YYYY-MM-DDTHH:mm" are both
    // valid user inputs, but Postgres requires a full timestamptz. We coerce
    // to ISO 8601 with seconds and UTC offset before inserting.
    let performedAt: string | null = null;
    if (parsed.data.performed_at) {
      const raw = parsed.data.performed_at.trim();
      if (raw.length > 0) {
        if (raw.length === 10) {
          // "YYYY-MM-DD" — treat as noon UTC to avoid day-shift issues
          performedAt = `${raw}T12:00:00.000Z`;
        } else {
          // "YYYY-MM-DDTHH:mm" or already a full ISO string
          const d = new Date(raw);
          performedAt = isNaN(d.getTime()) ? null : d.toISOString();
        }
      }
    }

    // OPD is a yes/no at the front desk; the amount is the clinic's own setting.
    const opdCharged = parsed.data.opd_charged ?? false;
    const opdFee = await resolveOpdFee(db, profile.clinic_id, opdCharged);

    // Resolve consultant revenue distribution (clinic_share always populated).
    const revenue = await resolveConsultantRevenue(
      db,
      profile.clinic_id,
      parsed.data.cost,
      parsed.data.consultant_id,
      parsed.data.commission_type,
      parsed.data.commission_value
    );
    if (!revenue.ok) return { data: null, error: revenue.error };

    const { data, error } = await db
      .from("treatments")
      .insert({
        clinic_id: profile.clinic_id,
        appointment_id: parsed.data.appointment_id,
        patient_id: parsed.data.patient_id,
        treatment_type: parsed.data.treatment_type,
        internal_notes: parsed.data.internal_notes ?? null,
        patient_visible_notes: parsed.data.patient_visible_notes ?? null,
        medications: parsed.data.medications ?? [],
        cost: parsed.data.cost,
        status: parsed.data.status ?? "planned",
        opd_charged: opdCharged,
        opd_fee: opdFee,
        xray_taken: parsed.data.xray_taken ?? false,
        xray_cost: parsed.data.xray_taken ? (parsed.data.xray_cost ?? null) : null,
        performed_at: performedAt,
        created_by: profile.id,
        tooth_number: parsed.data.tooth_number ?? null,
        dentition_type: parsed.data.dentition_type ?? null,
        ...revenue.fields,
      })
      .select()
      .single();

    if (error) {
      console.error("[createTreatment]", error);
      return { data: null, error: "Failed to create treatment." };
    }

    const treatment = data as Treatment;

    // The opening entry in this treatment's history. Records the clinically
    // meaningful fields as created — not the whole row, so the trail stays a
    // record of decisions rather than a second copy of the record.
    await writeTreatmentHistory({
      clinicId: profile.clinic_id,
      treatmentId: treatment.id,
      patientId: treatment.patient_id,
      action: "created",
      newValue: {
        treatment_type: treatment.treatment_type,
        status: treatment.status,
        cost: treatment.cost,
        tooth_number: treatment.tooth_number,
        performed_at: treatment.performed_at,
      },
      performedBy: profile.id,
    });

    await syncToothForTreatment(db, {
      clinicId: profile.clinic_id,
      performedBy: profile.id,
      treatmentId: treatment.id,
      patientId: treatment.patient_id,
      toothNumber: treatment.tooth_number,
      dentitionType: treatment.dentition_type,
      treatmentStatus: treatment.status,
    });

    revalidatePath("/dentist/treatments");
    revalidatePath(`/dentist/patients/${parsed.data.patient_id}`);
    revalidatePath(`/dentist/patients/${parsed.data.patient_id}/treatments`);
    revalidatePath(`/dentist/appointments/${parsed.data.appointment_id}`);

    return { data: treatment, error: null };
  } catch (err) {
    console.error("[createTreatment] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// updateTreatment — dentist only
// =============================================================================

export async function updateTreatment(
  id: string,
  input: unknown
): Promise<ActionResult<Treatment>> {
  try {
    if (!id) return { data: null, error: "Treatment ID is required" };

    const parsed = UpdateTreatmentSchema.safeParse(input);
    if (!parsed.success) {
      return {
        data: null,
        error: parsed.error.errors[0]?.message ?? "Invalid input",
      };
    }

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist") {
      return { data: null, error: "Forbidden: only dentists can update treatments." };
    }

    // Read the row BEFORE the update so the history can record what changed
    // rather than only what it changed to. Fetched here, before any of the
    // derived values below are recomputed, so the comparison is against the
    // record as it actually stood.
    const { data: beforeRow } = await db
      .from("treatments")
      .select("*")
      .eq("id", id)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null)
      .maybeSingle();

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (parsed.data.treatment_type !== undefined) updates.treatment_type = parsed.data.treatment_type;
    if (parsed.data.internal_notes !== undefined) updates.internal_notes = parsed.data.internal_notes ?? null;
    if (parsed.data.patient_visible_notes !== undefined) updates.patient_visible_notes = parsed.data.patient_visible_notes ?? null;
    if (parsed.data.medications !== undefined) updates.medications = parsed.data.medications ?? [];
    if (parsed.data.cost !== undefined) updates.cost = parsed.data.cost;
    if (parsed.data.status !== undefined) updates.status = parsed.data.status;
    if (parsed.data.opd_charged !== undefined) {
      updates.opd_charged = parsed.data.opd_charged;
      // Re-resolved on every toggle so switching OPD off clears the charge
      // rather than leaving a fee attached to a visit that is no longer billed
      // for one. Turning it back on re-snapshots at today's rate.
      updates.opd_fee = await resolveOpdFee(db, profile.clinic_id, parsed.data.opd_charged);
    }
    if (parsed.data.xray_taken !== undefined) {
      updates.xray_taken = parsed.data.xray_taken;
      // Clear xray_cost automatically when x-ray is disabled
      updates.xray_cost = parsed.data.xray_taken ? (parsed.data.xray_cost ?? null) : null;
    } else if (parsed.data.xray_cost !== undefined) {
      updates.xray_cost = parsed.data.xray_cost ?? null;
    }

    // Recompute the revenue split whenever the cost or the consultant selection
    // is part of this update. Keeps clinic_share/consultant_share consistent and
    // never subtracts payouts twice.
    const touchesRevenue =
      parsed.data.cost !== undefined ||
      parsed.data.consultant_id !== undefined ||
      parsed.data.commission_type !== undefined ||
      parsed.data.commission_value !== undefined;

    if (touchesRevenue) {
      let effectiveGross = parsed.data.cost;
      if (effectiveGross === undefined) {
        const { data: current } = await db
          .from("treatments")
          .select("cost")
          .eq("id", id)
          .eq("clinic_id", profile.clinic_id)
          .is("deleted_at", null)
          .maybeSingle();
        effectiveGross = Number((current as { cost?: number } | null)?.cost ?? 0);
      }

      const revenue = await resolveConsultantRevenue(
        db,
        profile.clinic_id,
        effectiveGross,
        parsed.data.consultant_id,
        parsed.data.commission_type,
        parsed.data.commission_value
      );
      if (!revenue.ok) return { data: null, error: revenue.error };

      updates.consultant_id = revenue.fields.consultant_id;
      updates.commission_type = revenue.fields.commission_type;
      updates.commission_value = revenue.fields.commission_value;
      updates.consultant_share = revenue.fields.consultant_share;
      updates.clinic_share = revenue.fields.clinic_share;
    }

    if (parsed.data.performed_at !== undefined) {
      if (!parsed.data.performed_at) {
        updates.performed_at = null;
      } else {
        const raw = parsed.data.performed_at.trim();
        if (raw.length === 10) {
          updates.performed_at = `${raw}T12:00:00.000Z`;
        } else {
          const d = new Date(raw);
          updates.performed_at = isNaN(d.getTime()) ? null : d.toISOString();
        }
      }
    }

    // tooth_number/dentition_type travel together — both or neither. Omitted
    // entirely from `updates` when not part of this call, so an update that
    // doesn't touch the tooth link leaves it exactly as it was.
    if (parsed.data.tooth_number !== undefined) updates.tooth_number = parsed.data.tooth_number ?? null;
    if (parsed.data.dentition_type !== undefined) updates.dentition_type = parsed.data.dentition_type ?? null;

    const { data, error } = await db
      .from("treatments")
      .update(updates)
      .eq("id", id)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null)
      .select()
      .single();

    if (error) {
      console.error("[updateTreatment]", error);
      return { data: null, error: "Failed to update treatment." };
    }
    if (!data) return { data: null, error: "Treatment not found." };

    const treatment = data as Treatment;

    // Only the fields that genuinely differ. A save that re-sent the same
    // values writes nothing, so the trail does not fill with entries claiming
    // edits that never happened.
    const changed = diffFields(
      beforeRow as Record<string, unknown> | null,
      treatment as unknown as Record<string, unknown>
    );
    if (changed) {
      await writeTreatmentHistory({
        clinicId: profile.clinic_id,
        treatmentId: treatment.id,
        patientId: treatment.patient_id,
        // A status move is called out separately from an ordinary edit: it is
        // the change a later reader is most often looking for.
        action: "status" in changed.new ? "status_changed" : "updated",
        oldValue: changed.old,
        newValue: changed.new,
        performedBy: profile.id,
      });
    }

    // Re-sync using the treatment's post-update (authoritative) tooth link and
    // status — covers both "the tooth link just changed" and "only the status
    // changed on an already tooth-linked treatment".
    await syncToothForTreatment(db, {
      clinicId: profile.clinic_id,
      performedBy: profile.id,
      treatmentId: treatment.id,
      patientId: treatment.patient_id,
      toothNumber: treatment.tooth_number,
      dentitionType: treatment.dentition_type,
      treatmentStatus: treatment.status,
    });

    revalidatePath("/dentist/treatments");
    revalidatePath(`/dentist/treatments/${id}`);
    revalidatePath(`/dentist/patients/${treatment.patient_id}`);
    revalidatePath(`/dentist/patients/${treatment.patient_id}/treatments`);

    return { data: treatment, error: null };
  } catch (err) {
    console.error("[updateTreatment] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// softDeleteTreatment — dentist only
// =============================================================================

export async function softDeleteTreatment(
  id: string
): Promise<ActionResult<null>> {
  try {
    if (!id) return { data: null, error: "Treatment ID is required" };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist") {
      return { data: null, error: "Forbidden: only dentists can delete treatments." };
    }

    // Fetch the identifying fields before deleting — for cache invalidation,
    // and so the history row can say what was removed rather than only that
    // something was.
    const { data: existing } = await db
      .from("treatments")
      .select("patient_id, treatment_type, status, cost")
      .eq("id", id)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null)
      .single();

    const { error } = await db
      .from("treatments")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null);

    if (error) {
      console.error("[softDeleteTreatment]", error);
      return { data: null, error: "Failed to delete treatment." };
    }

    if (existing?.patient_id) {
      await writeTreatmentHistory({
        clinicId: profile.clinic_id,
        treatmentId: id,
        patientId: existing.patient_id as string,
        action: "deleted",
        oldValue: {
          treatment_type: existing.treatment_type,
          status: existing.status,
          cost: existing.cost,
        },
        performedBy: profile.id,
      });
    }

    revalidatePath("/dentist/treatments");
    if (existing?.patient_id) {
      revalidatePath(`/dentist/patients/${existing.patient_id}`);
      revalidatePath(`/dentist/patients/${existing.patient_id}/treatments`);
    }

    return { data: null, error: null };
  } catch (err) {
    console.error("[softDeleteTreatment] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getTreatment — single treatment by id (dentist only — full record)
// =============================================================================

export async function getTreatment(
  id: string
): Promise<ActionResult<Treatment>> {
  try {
    if (!id) return { data: null, error: "Treatment ID is required" };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist") {
      return { data: null, error: "Forbidden" };
    }

    const { data, error } = await db
      .from("treatments")
      .select("*")
      .eq("id", id)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null)
      .single();

    if (error || !data) {
      return { data: null, error: "Treatment not found." };
    }

    // A treatment record carries internal_notes and medications, so opening one
    // is a clinical read and is accounted for.
    await recordPhiAccess(profile, {
      event: "TREATMENT_VIEWED",
      resourceType: "treatment",
      resourceId: id,
      patientId: (data as Treatment).patient_id,
      context: { surface: "treatment-detail" },
    });

    return { data: data as Treatment, error: null };
  } catch (err) {
    console.error("[getTreatment] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getTreatmentsForPatient — list by patient, role-aware
// Dentist: full record (internal_notes included)
// Receptionist: internal_notes excluded
// =============================================================================

export async function getTreatmentsForPatient(
  patientId: string
): Promise<ActionResult<Treatment[] | TreatmentForReceptionist[]>> {
  try {
    if (!patientId) return { data: [], error: null };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };

    if (profile.role === "patient") {
      return { data: null, error: "Forbidden" };
    }

    // The receptionist list excludes internal_notes but MUST carry the billing
    // columns: they drive the payment totals on the patient profile, and
    // omitting them made a receptionist's "Total Cost" disagree with the
    // outstanding balance shown beside it.
    const selectFields =
      profile.role === "dentist"
        ? "*"
        : "id, clinic_id, appointment_id, patient_id, treatment_type, patient_visible_notes, cost, opd_charged, opd_fee, xray_taken, xray_cost, status, performed_at, deleted_at, created_at, updated_at";

    const { data, error } = await db
      .from("treatments")
      .select(selectFields)
      .eq("patient_id", patientId)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[getTreatmentsForPatient]", error);
      return { data: null, error: "Failed to fetch treatments." };
    }

    return { data: (data ?? []) as Treatment[], error: null };
  } catch (err) {
    console.error("[getTreatmentsForPatient] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getTreatmentsForAppointment — list by appointment, role-aware
// =============================================================================

export async function getTreatmentsForAppointment(
  appointmentId: string
): Promise<ActionResult<Treatment[] | TreatmentForReceptionist[]>> {
  try {
    if (!appointmentId) return { data: [], error: null };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };

    if (profile.role === "patient") {
      return { data: null, error: "Forbidden" };
    }

    const selectFields =
      profile.role === "dentist"
        ? "*"
        : "id, clinic_id, appointment_id, patient_id, treatment_type, patient_visible_notes, cost, status, performed_at, deleted_at, created_at, updated_at";

    const { data, error } = await db
      .from("treatments")
      .select(selectFields)
      .eq("appointment_id", appointmentId)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[getTreatmentsForAppointment]", error);
      return { data: null, error: "Failed to fetch treatments." };
    }

    return { data: (data ?? []) as Treatment[], error: null };
  } catch (err) {
    console.error("[getTreatmentsForAppointment] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getPatientTreatmentHistory — past treatments for a patient (staff)
//
// Used by the appointment detail page "Past Treatment History" section.
// Returns non-deleted treatments for the patient, newest first, enriched with
// the performing dentist's name (resolved via appointment → dentist profile).
// Clinic isolation is enforced by the clinic_id filter.
// =============================================================================

export async function getPatientTreatmentHistory(
  patientId: string
): Promise<ActionResult<TreatmentHistoryItem[]>> {
  try {
    if (!patientId) return { data: [], error: null };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role === "patient") {
      return { data: null, error: "Forbidden" };
    }

    const { data, error } = await db
      .from("treatments")
      .select(
        "id, treatment_type, status, cost, performed_at, created_at, patient_visible_notes, appointment_id"
      )
      .eq("patient_id", patientId)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null)
      .order("performed_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[getPatientTreatmentHistory]", error);
      return { data: null, error: "Failed to fetch treatment history." };
    }

    const rows = (data ?? []) as Array<
      Omit<TreatmentHistoryItem, "dentistName">
    >;

    // Resolve dentist names via the linked appointments (clinic-scoped).
    const apptIds = Array.from(
      new Set(rows.map((r) => r.appointment_id).filter(Boolean) as string[])
    );

    const dentistNameByAppt = new Map<string, string>();
    if (apptIds.length > 0) {
      const { data: appts } = await db
        .from("appointments")
        .select("id, dentist_id")
        .in("id", apptIds)
        .eq("clinic_id", profile.clinic_id);

      const apptRows = (appts ?? []) as { id: string; dentist_id: string }[];
      const dentistIds = Array.from(new Set(apptRows.map((a) => a.dentist_id)));

      if (dentistIds.length > 0) {
        const { data: dentists } = await db
          .from("profiles")
          .select("id, full_name")
          .in("id", dentistIds);

        const nameById = new Map(
          ((dentists ?? []) as { id: string; full_name: string }[]).map((d) => [
            d.id,
            d.full_name,
          ])
        );

        for (const a of apptRows) {
          const name = nameById.get(a.dentist_id);
          if (name) dentistNameByAppt.set(a.id, name);
        }
      }
    }

    const enriched: TreatmentHistoryItem[] = rows.map((r) => ({
      ...r,
      dentistName: r.appointment_id
        ? dentistNameByAppt.get(r.appointment_id) ?? null
        : null,
    }));

    return { data: enriched, error: null };
  } catch (err) {
    console.error("[getPatientTreatmentHistory] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getAllTreatments — clinic-wide list for /dentist/treatments page
// =============================================================================

export async function getAllTreatments(filters?: {
  page?: number;
  limit?: number;
  /** Free-text search across patient name + phone. */
  search?: string;
  status?: string;
  /** Treatment type partial match. */
  treatmentType?: string;
  dateFrom?: string;
  dateTo?: string;
}): Promise<ActionResult<{ treatments: Treatment[]; total: number }>> {
  try {
    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist") {
      return { data: null, error: "Forbidden" };
    }

    const page = filters?.page ?? 1;
    const limit = Math.min(filters?.limit ?? 20, 100);
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    // Guard: inverted date range → return empty immediately
    if (filters?.dateFrom && filters?.dateTo && filters.dateFrom > filters.dateTo) {
      return { data: { treatments: [], total: 0 }, error: null };
    }

    const search = filters?.search?.trim();

    // Free-text search: resolve matching patient IDs first, then filter treatments.
    // This pattern mirrors getAppointments() and avoids PostgREST join filter ambiguity.
    let patientIdFilter: string[] | null = null;
    if (search && search.length >= 1) {
      const escaped = search.replace(/[%,()]/g, " ");
      const { data: matched } = await db
        .from("patients")
        .select("id")
        .eq("clinic_id", profile.clinic_id)
        .is("deleted_at", null)
        .or(`name.ilike.%${escaped}%,phone.ilike.%${escaped}%`)
        .limit(500);
      patientIdFilter = ((matched ?? []) as { id: string }[]).map((p) => p.id);
      if (patientIdFilter.length === 0) {
        return { data: { treatments: [], total: 0 }, error: null };
      }
    }

    let query = db
      .from("treatments")
      .select(
        "*, patients!inner(id, name, phone)",
        { count: "exact" }
      )
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null);

    if (filters?.status) {
      query = query.eq("status", filters.status);
    }

    if (filters?.treatmentType && filters.treatmentType.trim().length >= 1) {
      query = query.ilike("treatment_type", `%${filters.treatmentType.trim()}%`);
    }

    if (patientIdFilter !== null) {
      query = query.in("patient_id", patientIdFilter);
    }

    // created_at is a timestamptz; interpret the date filter in the clinic's
    // local calendar so a treatment recorded just after local midnight isn't
    // dropped from (or leaked into) the wrong day for a non-UTC clinic (audit A16-adjacent).
    if (filters?.dateFrom || filters?.dateTo) {
      const { data: tzSettings } = await db
        .from("clinic_settings")
        .select("timezone")
        .eq("clinic_id", profile.clinic_id)
        .maybeSingle();
      const timezone = (tzSettings as { timezone?: string } | null)?.timezone ?? DEFAULT_TIMEZONE;
      if (filters?.dateFrom)
        query = query.gte("created_at", getUtcBoundariesForLocalDate(filters.dateFrom, timezone).start);
      if (filters?.dateTo)
        query = query.lte("created_at", getUtcBoundariesForLocalDate(filters.dateTo, timezone).end);
    }

    const { data, error, count } = await query
      .order("created_at", { ascending: false })
      .range(from, to);

    if (error) {
      console.error("[getAllTreatments]", error);
      return { data: null, error: "Failed to fetch treatments." };
    }

    return {
      data: {
        treatments: (data ?? []) as Treatment[],
        total: count ?? 0,
      },
      error: null,
    };
  } catch (err) {
    console.error("[getAllTreatments] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getPatientTreatments — patient portal path; patient_visible_notes only
//
// Every treatment is automatically enriched with the performing dentist's
// digital signature (resolved from the dentist's profile via the appointment),
// regardless of treatment status. The signature is NEVER stored on the
// treatment — it is resolved at read time. If the dentist has no signature
// uploaded, `signature` is null and the portal hides the signature block.
// =============================================================================

export async function getPatientTreatments(
  _patientId: string
): Promise<ActionResult<TreatmentForPatientWithSignature[]>> {
  try {
    const supabase = await createServerClient();
    const db: DbClient = supabase;

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return { data: null, error: "Unauthorized" };

    // Resolve patient_id via portal link
    const { data: link } = await db
      .from("patient_portal_links")
      .select("patient_id")
      .eq("user_id", user.id)
      .single();

    if (!link?.patient_id) {
      return { data: null, error: "Portal account not linked." };
    }

    const { data, error } = await db
      .from("treatments")
      .select(
        "id, clinic_id, appointment_id, patient_id, treatment_type, patient_visible_notes, medications, cost, status, performed_at, created_at"
      )
      .eq("patient_id", link.patient_id)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[getPatientTreatments]", error);
      return { data: null, error: "Failed to fetch treatments." };
    }

    const treatments = (data ?? []) as TreatmentForPatient[];

    // Resolve dentist signatures AND registration number for ALL treatments (any status). 
    // Map each treatment → appointment → dentist profile (full_name + signature_url).
    // Registration number comes from clinic_settings (clinic-level, not per-treatment).
    const apptIds = Array.from(
      new Set(
        treatments
          .filter((t) => t.appointment_id)
          .map((t) => t.appointment_id as string)
      )
    );

    // Fetch registration number from clinic_settings (one query per patient's clinic)
    let registrationNumber: string | null = null;
    if (treatments.length > 0) {
      const clinicId = treatments[0]?.clinic_id;
      if (clinicId) {
        const { data: settings } = await db
          .from("clinic_settings")
          .select("registration_number")
          .eq("clinic_id", clinicId)
          .maybeSingle();
        registrationNumber = settings?.registration_number ?? null;
      }
    }

    // appointment_id -> dentist signature info
    const signatureByAppointment = new Map<
      string,
      { dentistName: string; signatureUrl: string }
    >();

    if (apptIds.length > 0) {
      // The patient reads their own appointments through RLS (auth_patient_id).
      //
      // The dentist's NAME and SIGNATURE, though, come from the dentist
      // directory rather than from `db`. This used to rely on "profiles
      // readable within the same clinic" — a policy that also handed the
      // patient the whole staff roster and every other portal patient's name
      // (migration 20260905090000). The name on your own treatment record is
      // legitimate; the roster was not, and only one of the two survived.
      const { data: appts } = await db
        .from("appointments")
        .select("id, dentist_id")
        .in("id", apptIds);

      const apptRows = (appts ?? []) as { id: string; dentist_id: string }[];
      const dentistIds = Array.from(new Set(apptRows.map((a) => a.dentist_id)));

      if (dentistIds.length > 0) {
        const dentistById = await resolveDentistIdentities(dentistIds);
        const dentistRows = Array.from(dentistById.values());

        // Sign once per distinct stored value rather than once per appointment:
        // a patient's history is typically all the same one or two dentists.
        const signedByStored = await resolveSignatureUrls(
          db,
          dentistRows.map((d) => d.signature_url)
        );

        for (const appt of apptRows) {
          const dentist = dentistById.get(appt.dentist_id);
          const signed = dentist?.signature_url
            ? signedByStored.get(dentist.signature_url)
            : undefined;
          // full_name is NOT NULL in the schema; the guard is here because the
          // directory types it nullable, and a signature block with a blank
          // name above it would be worse than no signature block.
          if (dentist?.full_name && signed) {
            signatureByAppointment.set(appt.id, {
              dentistName: dentist.full_name,
              signatureUrl: signed,
            });
          }
        }
      }
    }

    const enriched: TreatmentForPatientWithSignature[] = treatments.map((t) => {
      const sig = t.appointment_id
        ? signatureByAppointment.get(t.appointment_id)
        : undefined;

      return {
        ...t,
        signature: sig
          ? {
              dentistName: sig.dentistName,
              signatureUrl: sig.signatureUrl,
              registrationNumber,
            }
          : null,
      };
    });

    return { data: enriched, error: null };
  } catch (err) {
    console.error("[getPatientTreatments] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}


/**
 * Which audit event a stored document deserves.
 *
 * IOPA, OPG and CBCT are radiographs — diagnostic imaging, and the most
 * sensitive thing in the bucket. Anything else (a scanned report, a clinical
 * photograph, a consent PDF) records as a document. `document_type` is optional
 * and older rows have none, so an unlabelled file is treated as a document
 * rather than guessed at.
 */
const RADIOGRAPH_TYPES = new Set(["IOPA", "OPG", "CBCT"]);

function documentAccessEvent(documentType: string | null | undefined) {
  return documentType && RADIOGRAPH_TYPES.has(documentType)
    ? ("XRAY_VIEWED" as const)
    : ("DOCUMENT_VIEWED" as const);
}

// =============================================================================
// createTreatmentDocument — dentist only — records metadata after upload
// =============================================================================

export async function createTreatmentDocument(
  input: unknown
): Promise<ActionResult<TreatmentDocument>> {
  try {
    const parsed = CreateTreatmentDocumentSchema.safeParse(input);
    if (!parsed.success) {
      return { data: null, error: parsed.error.errors[0]?.message ?? "Invalid input" };
    }

    if (!ALLOWED_DOCUMENT_TYPES.includes(parsed.data.file_type as (typeof ALLOWED_DOCUMENT_TYPES)[number])) {
      return { data: null, error: "Unsupported file type. Allowed: PDF, JPG, JPEG, PNG." };
    }

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist") {
      return { data: null, error: "Forbidden: only dentists can upload documents." };
    }

    // Verify the treatment belongs to this clinic + resolve patient_id
    const { data: treatment } = await db
      .from("treatments")
      .select("id, patient_id")
      .eq("id", parsed.data.treatment_id)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null)
      .single();

    if (!treatment) {
      return { data: null, error: "Treatment not found." };
    }

    const { data, error } = await db
      .from("treatment_documents")
      .insert({
        clinic_id: profile.clinic_id,
        patient_id: parsed.data.patient_id,
        treatment_id: parsed.data.treatment_id,
        file_name: parsed.data.file_name,
        file_path: parsed.data.file_path,
        file_type: parsed.data.file_type,
        file_size: parsed.data.file_size ?? null,
        created_by: profile.id,
      })
      .select()
      .single();

    if (error) {
      console.error("[createTreatmentDocument]", error);
      return { data: null, error: "Failed to save document." };
    }

    revalidatePath(`/dentist/treatments/${parsed.data.treatment_id}`);
    revalidatePath(`/dentist/patients/${parsed.data.patient_id}/treatments`);

    return { data: data as TreatmentDocument, error: null };
  } catch (err) {
    console.error("[createTreatmentDocument] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// uploadTreatmentDocument — dentist only — uploads file + records metadata
//
// Accepts FormData: { file, treatment_id, patient_id }. The file is uploaded
// to the patient-documents bucket using the user's session (RLS-scoped to the
// dentist's clinic folder) and the metadata row is then inserted.
// =============================================================================

export async function uploadTreatmentDocument(
  formData: FormData
): Promise<ActionResult<TreatmentDocument>> {
  try {
    const file = formData.get("file");
    const treatmentId = String(formData.get("treatment_id") ?? "");
    const patientId = String(formData.get("patient_id") ?? "");

    if (!(file instanceof File) || !treatmentId || !patientId) {
      return { data: null, error: "Missing file or identifiers." };
    }

    if (!ALLOWED_DOCUMENT_TYPES.includes(file.type as (typeof ALLOWED_DOCUMENT_TYPES)[number])) {
      return { data: null, error: "Unsupported file type. Allowed: PDF, JPG, JPEG, PNG." };
    }

    // 10 MB cap
    if (file.size > 10 * 1024 * 1024) {
      return { data: null, error: "File too large (max 10 MB)." };
    }

    // The check above trusted file.type, which is the browser's guess and is
    // under the caller's control. This one reads the actual bytes.
    const contentError = await assertContentMatchesType(file, ALLOWED_DOCUMENT_TYPES);
    if (contentError) return { data: null, error: contentError };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist") {
      return { data: null, error: "Forbidden: only dentists can upload documents." };
    }

    // Verify treatment belongs to this clinic
    const { data: treatment } = await db
      .from("treatments")
      .select("id")
      .eq("id", treatmentId)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null)
      .single();
    if (!treatment) return { data: null, error: "Treatment not found." };

    // Build clinic-isolated storage path: {clinic}/{patient}/{treatment}/{ts-name}
    const safeName = file.name.replace(/[^\w.\-]/g, "_");
    const path = `${profile.clinic_id}/${patientId}/${treatmentId}/${Date.now()}-${safeName}`;

    // Store the type the BYTES say, not the one the browser claimed — that is
    // the Content-Type the object is later served with.
    const contentType = await actualContentType(file);

    const { error: uploadErr } = await db.storage
      .from(DOCUMENT_BUCKET)
      .upload(path, file, { contentType, upsert: false });

    if (uploadErr) {
      console.error("[uploadTreatmentDocument] upload:", uploadErr);
      return { data: null, error: "Failed to upload file." };
    }

    const { data, error } = await db
      .from("treatment_documents")
      .insert({
        clinic_id: profile.clinic_id,
        patient_id: patientId,
        treatment_id: treatmentId,
        file_name: file.name,
        file_path: path,
        file_type: contentType,
        file_size: file.size,
        created_by: profile.id,
      })
      .select()
      .single();

    if (error) {
      console.error("[uploadTreatmentDocument] metadata:", error);
      // Best-effort cleanup of the orphaned object
      await db.storage.from(DOCUMENT_BUCKET).remove([path]);
      return { data: null, error: "Failed to save document metadata." };
    }

    revalidatePath(`/dentist/treatments/${treatmentId}`);

    return { data: data as TreatmentDocument, error: null };
  } catch (err) {
    console.error("[uploadTreatmentDocument] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getTreatmentDocuments — staff + patient (role-aware), with signed URLs
// =============================================================================

export async function getTreatmentDocuments(
  treatmentId: string
): Promise<ActionResult<Array<TreatmentDocument & { url: string | null }>>> {
  try {
    if (!treatmentId) return { data: [], error: null };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };

    let query = db
      .from("treatment_documents")
      .select("*")
      .eq("treatment_id", treatmentId)
      // Removed documents are excluded here as well as in the RLS policy.
      // Belt and braces, per CLAUDE.md §13.14 — the policy is the guarantee,
      // this is what makes the intent visible at the call site.
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

    // Staff scope by clinic; patient path relies on RLS (auth_patient_id()).
    if (profile.role !== "patient") {
      query = query.eq("clinic_id", profile.clinic_id);
    }

    const { data, error } = await query;

    if (error) {
      console.error("[getTreatmentDocuments]", error);
      return { data: null, error: "Failed to fetch documents." };
    }

    const docs = (data ?? []) as TreatmentDocument[];

    // Generate short-lived signed URLs for each document (private bucket).
    const withUrls = await Promise.all(
      docs.map(async (doc) => {
        const { data: signed } = await db.storage
          .from(DOCUMENT_BUCKET)
          .createSignedUrl(doc.file_path, DOCUMENT_URL_TTL_SECONDS);
        return { ...doc, url: signed?.signedUrl ?? null };
      })
    );

    // Issuing a signed URL is the moment a stored radiograph becomes
    // retrievable by whoever holds the link, so THAT is the auditable event —
    // not the later GET, which happens at the storage service and never reaches
    // this application.
    //
    // A patient reading their own documents is deliberately not recorded. The
    // question this log answers is who ELSE looked at a record; logging a
    // person's access to their own file adds volume and answers nothing.
    if (profile.role !== "patient" && withUrls.length > 0) {
      await recordPhiAccessBatch(
        profile,
        withUrls
          .filter((doc) => doc.url !== null)
          .map((doc) => ({
            event: documentAccessEvent(doc.document_type),
            resourceType: "treatment_document",
            resourceId: doc.id,
            patientId: doc.patient_id,
            context: {
              surface: "treatment-documents",
              bucket: DOCUMENT_BUCKET,
              ttlSeconds: DOCUMENT_URL_TTL_SECONDS,
            },
          }))
      );
    }

    return { data: withUrls, error: null };
  } catch (err) {
    console.error("[getTreatmentDocuments] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// deleteTreatmentDocument — dentist only — removes metadata + storage object
// =============================================================================

/**
 * Removing a document is a SOFT delete.
 *
 * It used to remove the storage object and then the metadata row, which meant a
 * radiograph could disappear from the clinical record leaving nothing behind —
 * not even the fact that one had existed. A diagnostic image is part of the
 * record a later clinician relies on and a later dispute turns on, so its
 * removal is now marked, attributed and dated, and the object itself is cleared
 * by the retention purge rather than at the moment of the click.
 *
 * The RLS DELETE policy was dropped in 20260903000300, so the hard-delete route
 * is closed rather than merely unused.
 */
export async function deleteTreatmentDocument(
  id: string
): Promise<ActionResult<null>> {
  try {
    if (!id) return { data: null, error: "Document ID is required" };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist") {
      return { data: null, error: "Forbidden: only dentists can delete documents." };
    }

    const { data: doc } = await db
      .from("treatment_documents")
      .select("id, file_path, treatment_id, patient_id")
      .eq("id", id)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null)
      .single();

    if (!doc) return { data: null, error: "Document not found." };

    const { error } = await db
      .from("treatment_documents")
      .update({
        deleted_at: new Date().toISOString(),
        deleted_by: profile.id,
      })
      .eq("id", id)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null);

    if (error) {
      console.error("[deleteTreatmentDocument]", error);
      return { data: null, error: "Failed to delete document." };
    }

    revalidatePath(`/dentist/treatments/${doc.treatment_id}`);
    revalidatePath(`/dentist/patients/${doc.patient_id}/treatments`);

    return { data: null, error: null };
  } catch (err) {
    console.error("[deleteTreatmentDocument] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}


// =============================================================================
// getCurrentUserDisplayName — the logged-in staff member's name
// Used by the treatment form to label the default "Performed By" option with
// the treating dentist's actual name instead of a generic placeholder.
// =============================================================================

export async function getCurrentUserDisplayName(): Promise<
  ActionResult<string | null>
> {
  try {
    const { profile } = await resolveCachedSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    return { data: profile.full_name ?? null, error: null };
  } catch (err) {
    console.error("[getCurrentUserDisplayName] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// APPOINTMENT-SCOPED DOCUMENTS (radiographic: IOPA / OPG / CBCT)
//
// Reuses the existing patient-documents storage bucket and treatment_documents
// metadata table (appointment_id set, treatment_id null). Staff (dentist +
// receptionist) may manage these — radiographs are commonly captured at the
// front desk. Clinic isolation is enforced via clinic_id + storage path.
// =============================================================================

export async function uploadAppointmentDocument(
  formData: FormData
): Promise<ActionResult<TreatmentDocument>> {
  try {
    const file = formData.get("file");
    const appointmentId = String(formData.get("appointment_id") ?? "");
    const patientId = String(formData.get("patient_id") ?? "");
    const documentTypeRaw = String(formData.get("document_type") ?? "").trim();
    const documentType = documentTypeRaw.length > 0 ? documentTypeRaw.slice(0, 40) : null;

    if (!(file instanceof File) || !appointmentId || !patientId) {
      return { data: null, error: "Missing file or identifiers." };
    }

    if (!ALLOWED_DOCUMENT_TYPES.includes(file.type as (typeof ALLOWED_DOCUMENT_TYPES)[number])) {
      return { data: null, error: "Unsupported file type. Allowed: PDF, JPG, JPEG, PNG." };
    }

    if (file.size > 10 * 1024 * 1024) {
      return { data: null, error: "File too large (max 10 MB)." };
    }

    const apptContentError = await assertContentMatchesType(file, ALLOWED_DOCUMENT_TYPES);
    if (apptContentError) return { data: null, error: apptContentError };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist" && profile.role !== "receptionist") {
      return { data: null, error: "Forbidden" };
    }

    // Verify the appointment belongs to this clinic.
    const { data: appointment } = await db
      .from("appointments")
      .select("id")
      .eq("id", appointmentId)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null)
      .single();
    if (!appointment) return { data: null, error: "Appointment not found." };

    // Clinic-isolated storage path: {clinic}/{patient}/appointments/{appt}/{ts-name}
    const safeName = file.name.replace(/[^\w.\-]/g, "_");
    const path = `${profile.clinic_id}/${patientId}/appointments/${appointmentId}/${Date.now()}-${safeName}`;

    const apptContentType = await actualContentType(file);

    const { error: uploadErr } = await db.storage
      .from(DOCUMENT_BUCKET)
      .upload(path, file, { contentType: apptContentType, upsert: false });

    if (uploadErr) {
      console.error("[uploadAppointmentDocument] upload:", uploadErr);
      return { data: null, error: "Failed to upload file." };
    }

    const { data, error } = await db
      .from("treatment_documents")
      .insert({
        clinic_id: profile.clinic_id,
        patient_id: patientId,
        treatment_id: null,
        appointment_id: appointmentId,
        document_type: documentType,
        file_name: file.name,
        file_path: path,
        file_type: apptContentType,
        file_size: file.size,
        created_by: profile.id,
      })
      .select()
      .single();

    if (error) {
      console.error("[uploadAppointmentDocument] metadata:", error);
      await db.storage.from(DOCUMENT_BUCKET).remove([path]);
      return { data: null, error: "Failed to save document metadata." };
    }

    revalidatePath(`/${profile.role}/appointments/${appointmentId}`);

    return { data: data as TreatmentDocument, error: null };
  } catch (err) {
    console.error("[uploadAppointmentDocument] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

export async function getAppointmentDocuments(
  appointmentId: string
): Promise<ActionResult<Array<TreatmentDocument & { url: string | null }>>> {
  try {
    if (!appointmentId) return { data: [], error: null };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };

    let query = db
      .from("treatment_documents")
      .select("*")
      .eq("appointment_id", appointmentId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

    if (profile.role !== "patient") {
      query = query.eq("clinic_id", profile.clinic_id);
    }

    const { data, error } = await query;

    if (error) {
      console.error("[getAppointmentDocuments]", error);
      return { data: null, error: "Failed to fetch documents." };
    }

    const docs = (data ?? []) as TreatmentDocument[];

    const withUrls = await Promise.all(
      docs.map(async (doc) => {
        const { data: signed } = await db.storage
          .from(DOCUMENT_BUCKET)
          .createSignedUrl(doc.file_path, DOCUMENT_URL_TTL_SECONDS);
        return { ...doc, url: signed?.signedUrl ?? null };
      })
    );

    // These are radiographs. Issuing the signed URL is the moment one becomes
    // retrievable by whoever holds the link, so that is what is recorded — the
    // later GET happens at the storage service and never reaches this app.
    // A patient viewing their own imaging is not recorded; see the note in
    // getTreatmentDocuments.
    if (profile.role !== "patient" && withUrls.length > 0) {
      await recordPhiAccessBatch(
        profile,
        withUrls
          .filter((doc) => doc.url !== null)
          .map((doc) => ({
            event: documentAccessEvent(doc.document_type),
            resourceType: "treatment_document",
            resourceId: doc.id,
            patientId: doc.patient_id,
            context: {
              surface: "appointment-documents",
              bucket: DOCUMENT_BUCKET,
              ttlSeconds: DOCUMENT_URL_TTL_SECONDS,
            },
          }))
      );
    }

    return { data: withUrls, error: null };
  } catch (err) {
    console.error("[getAppointmentDocuments] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

export async function deleteAppointmentDocument(
  id: string
): Promise<ActionResult<null>> {
  try {
    if (!id) return { data: null, error: "Document ID is required" };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist" && profile.role !== "receptionist") {
      return { data: null, error: "Forbidden" };
    }

    const { data: doc } = await db
      .from("treatment_documents")
      .select("id, file_path, appointment_id")
      .eq("id", id)
      .eq("clinic_id", profile.clinic_id)
      .not("appointment_id", "is", null)
      .is("deleted_at", null)
      .single();

    if (!doc) return { data: null, error: "Document not found." };

    // Soft, for the same reason as deleteTreatmentDocument: a radiograph
    // leaving the record should be attributable, and the storage object is the
    // retention purge's job rather than this click's.
    const { error } = await db
      .from("treatment_documents")
      .update({
        deleted_at: new Date().toISOString(),
        deleted_by: profile.id,
      })
      .eq("id", id)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null);

    if (error) {
      console.error("[deleteAppointmentDocument]", error);
      return { data: null, error: "Failed to delete document." };
    }

    revalidatePath(`/${profile.role}/appointments/${doc.appointment_id}`);

    return { data: null, error: null };
  } catch (err) {
    console.error("[deleteAppointmentDocument] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getPatientsWithPlannedTreatmentNoVisit — recall/booking send list
// =============================================================================

/**
 * Patients who have a `planned` treatment on record but no upcoming visit
 * booked. A patient counts as booked when they have any future appointment that
 * is not cancelled or a no-show.
 *
 * Returns one row per PATIENT (their most recent planned treatment), with the
 * name and phone the WhatsApp send list needs. Note this is a distinct-patient
 * count: the Business Brain's "treatment.accepted_pending_scheduling" metric
 * counts planned-treatment ROWS, so a patient with several planned treatments
 * adds several to that metric but one to this list. The briefing reconciles the
 * two by showing distinct-patient counts (see getReminderSummaries in
 * actions/messaging.ts), so what the dentist reads always matches this list.
 *
 * Staff only; clinic-scoped.
 */
export async function getPatientsWithPlannedTreatmentNoVisit(): Promise<
  ActionResult<Array<{ id: string; name: string; phone: string | null; treatment_type: string }>>
> {
  try {
    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role === "patient") return { data: null, error: "Forbidden" };

    const cid = profile.clinic_id;
    const now = new Date().toISOString();

    const [{ data: planned, error: plannedErr }, { data: futureAppts }] = await Promise.all([
      db
        .from("treatments")
        .select("patient_id, treatment_type, created_at, patient:patients(id, name, phone)")
        .eq("clinic_id", cid)
        .eq("status", "planned")
        .is("deleted_at", null)
        .order("created_at", { ascending: false }),
      db
        .from("appointments")
        .select("patient_id")
        .eq("clinic_id", cid)
        .is("deleted_at", null)
        .gt("scheduled_at", now)
        // "Has a next visit" excludes cancelled and no-shows — the same set the
        // metric uses when it decides a planned treatment is unscheduled.
        .in("status", ["scheduled", "checked_in", "in_progress", "completed"]),
    ]);

    if (plannedErr) {
      console.error("[getPatientsWithPlannedTreatmentNoVisit]", plannedErr);
      return { data: null, error: "Failed to load treatments." };
    }

    const hasFutureVisit = new Set(
      ((futureAppts ?? []) as { patient_id: string }[]).map((a) => a.patient_id),
    );

    const seen = new Set<string>();
    const result: Array<{ id: string; name: string; phone: string | null; treatment_type: string }> = [];

    for (const t of (planned ?? []) as Array<{
      patient_id: string;
      treatment_type: string;
      patient: { id: string; name: string; phone: string | null } | null;
    }>) {
      if (hasFutureVisit.has(t.patient_id) || seen.has(t.patient_id)) continue;
      seen.add(t.patient_id);
      if (!t.patient) continue;
      result.push({
        id: t.patient.id,
        name: t.patient.name,
        phone: t.patient.phone,
        treatment_type: t.treatment_type,
      });
    }

    return { data: result, error: null };
  } catch (err) {
    console.error("[getPatientsWithPlannedTreatmentNoVisit] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}
