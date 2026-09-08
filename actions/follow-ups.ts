"use server";

import { revalidatePath } from "next/cache";
import { createServerClient } from "@/lib/supabase/server";
import { resolveSession as resolveCachedSession } from "@/lib/auth/session";
import { getTodayInTimezone, zonedDateToUTC } from "@/lib/utils";
import {
  CreateFollowUpSchema,
  UpdateFollowUpSchema,
  type ActionResult,
  type FollowUp,
  type FollowUpWithRelations,
} from "@/types";

/**
 * Follow-Up Server Actions
 *
 * Security rules (enforced in every action):
 * - clinic_id is ALWAYS sourced from the server session.
 * - Dentist: full CRUD (create, update, complete, cancel, list).
 * - Receptionist: create, update, view — cannot cancel or complete.
 * - Patient: view own follow-ups only (via portal link).
 * - Overdue = due_date < today AND status = 'pending'.
 * - Soft-deleted follow-ups excluded from all queries.
 *
 * Validation guards:
 * - patient must exist and belong to the clinic
 * - appointment_id (if provided) must belong to the patient
 * - treatment_id (if provided) must belong to the patient
 * - due_date must be a valid date string
 * - follow_up_type is required
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

/**
 * todayForClinic — today's date (YYYY-MM-DD) in the clinic's local timezone.
 *
 * Exported so every "is this overdue" comparison in the app — server actions
 * here, and the server components that render follow-up lists — resolves
 * "today" the same way. Before this was shared, two components computed today
 * as `new Date()` at RENDER time, which on Vercel runs in the server's system
 * timezone (UTC), not the clinic's. For a clinic ahead of UTC that briefly
 * disagreed with the clinic-aware queries already used elsewhere in this file
 * about exactly when a day rolls over.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function todayForClinic(db: any, clinicId: string): Promise<string> {
  if (!clinicId) return new Date().toISOString().split("T")[0];
  const { data } = await db
    .from("clinic_settings")
    .select("timezone")
    .eq("clinic_id", clinicId)
    .maybeSingle();
  const tz = (data as { timezone?: string } | null)?.timezone ?? "Asia/Kolkata";
  return getTodayInTimezone(tz);
}

// =============================================================================
// createFollowUp — dentist + receptionist
// =============================================================================

export async function createFollowUp(
  input: unknown
): Promise<ActionResult<FollowUp>> {
  try {
    const parsed = CreateFollowUpSchema.safeParse(input);
    if (!parsed.success) {
      return {
        data: null,
        error: parsed.error.errors[0]?.message ?? "Invalid input",
      };
    }

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role === "patient") {
      return { data: null, error: "Forbidden: patients cannot create follow-ups." };
    }

    // ── Validate patient, appointment, and treatment in parallel ─────────────
    // All three are independent reads so they can safely run in parallel.
    // Historical follow-ups are permitted (paper-record migration), so
    // "today" is no longer needed for a past-date guard here.
    const [patientRow, apptRow, txRow] = await Promise.all([
      db
        .from("patients")
        .select("id")
        .eq("id", parsed.data.patient_id)
        .eq("clinic_id", profile.clinic_id)
        .is("deleted_at", null)
        .single()
        .then((r: { data: unknown }) => r.data),

      parsed.data.appointment_id
        ? db
            .from("appointments")
            .select("id")
            .eq("id", parsed.data.appointment_id)
            .eq("patient_id", parsed.data.patient_id)
            .eq("clinic_id", profile.clinic_id)
            .is("deleted_at", null)
            .single()
            .then((r: { data: unknown }) => r.data)
        : Promise.resolve(true), // no appointment to validate → pass-through

      parsed.data.treatment_id
        ? db
            .from("treatments")
            .select("id")
            .eq("id", parsed.data.treatment_id)
            .eq("patient_id", parsed.data.patient_id)
            .eq("clinic_id", profile.clinic_id)
            .is("deleted_at", null)
            .single()
            .then((r: { data: unknown }) => r.data)
        : Promise.resolve(true), // no treatment to validate → pass-through
    ]);

    if (!patientRow) {
      return { data: null, error: "Patient not found in this clinic." };
    }

    if (parsed.data.appointment_id && !apptRow) {
      return {
        data: null,
        error: "Appointment not found or does not belong to this patient.",
      };
    }

    if (parsed.data.treatment_id && !txRow) {
      return {
        data: null,
        error: "Treatment not found or does not belong to this patient.",
      };
    }

    // Historical follow-ups are permitted (migration / late data entry). Such an
    // entry can be created with status "completed" (or "cancelled") directly —
    // see CreateFollowUpSchema.status — so a clinic digitising a resolved
    // recall is not forced through "pending" and then immediately misread as
    // overdue. A genuinely still-open backdated entry stays "pending" and is
    // correctly overdue: its due date has, in fact, passed.

    const { data, error } = await db
      .from("follow_ups")
      .insert({
        clinic_id:      profile.clinic_id,
        patient_id:     parsed.data.patient_id,
        appointment_id: parsed.data.appointment_id ?? null,
        treatment_id:   parsed.data.treatment_id ?? null,
        follow_up_type: parsed.data.follow_up_type,
        due_date:       parsed.data.due_date,
        status:         parsed.data.status ?? "pending",
        confirmation_status: parsed.data.confirmation_status ?? "confirmed",
        notes:          parsed.data.notes ?? null,
        created_by:     profile.id,
      })
      .select()
      .single();

    if (error) {
      console.error("[createFollowUp]", error);
      return { data: null, error: "Failed to create follow-up." };
    }

    const followUp = data as FollowUp;

    // ── Auto-create the patient's next appointment from the follow-up ───────
    // Always auto-create an appointment when due_time is provided.
    // Uses the current user's dentist ID (or the clinic's dentist for
    // receptionists). Links the new appointment back to the follow-up record.
    // Failure here is non-fatal — the follow-up still exists.
    const initialStatus = parsed.data.status ?? "pending";
    if (parsed.data.due_time && initialStatus === "pending") {
      try {
        // Resolve clinic timezone.
        const { data: settings } = await db
          .from("clinic_settings")
          .select("timezone")
          .eq("clinic_id", profile.clinic_id)
          .maybeSingle();
        const tz = (settings as { timezone?: string } | null)?.timezone ?? "Asia/Kolkata";

        // Resolve dentist: use the caller's own profile if they are a dentist,
        // otherwise find the clinic's dentist.
        let dentistId: string | null = null;
        if (profile.role === "dentist") {
          dentistId = profile.id;
        } else {
          const { data: dentist } = await db
            .from("profiles")
            .select("id")
            .eq("clinic_id", profile.clinic_id)
            .eq("role", "dentist")
            .limit(1)
            .single();
          dentistId = (dentist as { id: string } | null)?.id ?? null;
        }

        if (dentistId) {
          const localDateTime = `${parsed.data.due_date}T${parsed.data.due_time}:00`;
          const scheduledAtUtc = zonedDateToUTC(localDateTime, tz).toISOString();

          const { data: appt } = await db
            .from("appointments")
            .insert({
              clinic_id:        profile.clinic_id,
              patient_id:       parsed.data.patient_id,
              dentist_id:       dentistId,
              scheduled_at:     scheduledAtUtc,
              duration_minutes: 30,
              source:           "other",
              status:           "scheduled",
              notes:            `Follow-up appointment${parsed.data.notes ? `: ${parsed.data.notes}` : ""}`,
              created_by:       profile.id,
              // Provenance. Without this the visit carries no trace of why it
              // exists, and its detail page reads as a fresh start even when the
              // patient owes money from the visit that prompted the recall.
              follow_up_id:     followUp.id,
            })
            .select("id")
            .single();

          const newApptId = (appt as { id: string } | null)?.id;
          if (newApptId) {
            // Keep the follow-up linked to its ORIGINATING appointment when one
            // was provided (e.g. created from an appointment detail page), so it
            // continues to appear under that appointment. Only fall back to the
            // auto-created appointment when the follow-up had no source appointment.
            if (!parsed.data.appointment_id) {
              await db
                .from("follow_ups")
                .update({ appointment_id: newApptId, updated_at: new Date().toISOString() })
                .eq("id", followUp.id);
              followUp.appointment_id = newApptId;
            }
            revalidatePath(`/dentist/appointments`);
            revalidatePath(`/dentist/appointments/${newApptId}`);
          }
        }
      } catch (apptErr) {
        console.error("[createFollowUp] auto-appointment failed:", apptErr);
      }
    }

    revalidatePath("/dentist/follow-ups");
    revalidatePath(`/dentist/patients/${parsed.data.patient_id}`);

    // Revalidate the source appointment page so the new follow-up appears
    // immediately when the dentist navigates back.
    if (parsed.data.appointment_id) {
      revalidatePath(`/dentist/appointments/${parsed.data.appointment_id}`);
    }

    return { data: followUp, error: null };
  } catch (err) {
    console.error("[createFollowUp] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// updateFollowUp — dentist + receptionist
// =============================================================================

export async function updateFollowUp(
  id: string,
  input: unknown
): Promise<ActionResult<FollowUp>> {
  try {
    if (!id) return { data: null, error: "Follow-up ID is required" };

    const parsed = UpdateFollowUpSchema.safeParse(input);
    if (!parsed.success) {
      return {
        data: null,
        error: parsed.error.errors[0]?.message ?? "Invalid input",
      };
    }

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role === "patient") {
      return { data: null, error: "Forbidden" };
    }

    // Fetch the existing follow-up to resolve patient_id for cross-checks
    const { data: existing } = await db
      .from("follow_ups")
      .select("id, patient_id, status")
      .eq("id", id)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null)
      .single();

    if (!existing) return { data: null, error: "Follow-up not found." };

    const patientId: string = (existing as { patient_id: string }).patient_id;

    // ── Validate appointment belongs to this patient (if being updated) ────
    if (parsed.data.appointment_id) {
      const { data: apptRow } = await db
        .from("appointments")
        .select("id")
        .eq("id", parsed.data.appointment_id)
        .eq("patient_id", patientId)
        .eq("clinic_id", profile.clinic_id)
        .is("deleted_at", null)
        .single();

      if (!apptRow) {
        return {
          data: null,
          error: "Appointment not found or does not belong to this patient.",
        };
      }
    }

    // ── Validate treatment belongs to this patient (if being updated) ──────
    if (parsed.data.treatment_id) {
      const { data: txRow } = await db
        .from("treatments")
        .select("id")
        .eq("id", parsed.data.treatment_id)
        .eq("patient_id", patientId)
        .eq("clinic_id", profile.clinic_id)
        .is("deleted_at", null)
        .single();

      if (!txRow) {
        return {
          data: null,
          error: "Treatment not found or does not belong to this patient.",
        };
      }
    }

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (parsed.data.follow_up_type !== undefined) updates.follow_up_type = parsed.data.follow_up_type;
    if (parsed.data.due_date !== undefined)        updates.due_date        = parsed.data.due_date;
    if (parsed.data.notes !== undefined)           updates.notes           = parsed.data.notes ?? null;
    if (parsed.data.appointment_id !== undefined)  updates.appointment_id  = parsed.data.appointment_id ?? null;
    if (parsed.data.treatment_id !== undefined)    updates.treatment_id    = parsed.data.treatment_id ?? null;
    if (parsed.data.status !== undefined)          updates.status          = parsed.data.status;
    if (parsed.data.confirmation_status !== undefined) updates.confirmation_status = parsed.data.confirmation_status;

    const { data, error } = await db
      .from("follow_ups")
      .update(updates)
      .eq("id", id)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null)
      .select()
      .single();

    if (error) {
      console.error("[updateFollowUp]", error);
      return { data: null, error: "Failed to update follow-up." };
    }
    if (!data) return { data: null, error: "Follow-up not found." };

    const followUp = data as FollowUp;

    revalidatePath("/dentist/follow-ups");
    revalidatePath(`/dentist/follow-ups/${id}`);
    revalidatePath(`/dentist/patients/${followUp.patient_id}`);
    if (followUp.appointment_id) {
      revalidatePath(`/dentist/appointments/${followUp.appointment_id}`);
    }

    return { data: followUp, error: null };
  } catch (err) {
    console.error("[updateFollowUp] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// completeFollowUp — dentist only
// =============================================================================

export async function completeFollowUp(
  id: string
): Promise<ActionResult<FollowUp>> {
  try {
    if (!id) return { data: null, error: "Follow-up ID is required" };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist") {
      return { data: null, error: "Forbidden: only dentists can complete follow-ups." };
    }

    const { data, error } = await db
      .from("follow_ups")
      .update({
        status:     "completed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("clinic_id", profile.clinic_id)
      .eq("status", "pending")
      .is("deleted_at", null)
      .select()
      .single();

    if (error) {
      console.error("[completeFollowUp]", error);
      return { data: null, error: "Failed to complete follow-up." };
    }
    if (!data) return { data: null, error: "Follow-up not found or already completed." };

    const followUp = data as FollowUp;

    revalidatePath("/dentist/follow-ups");
    revalidatePath(`/dentist/follow-ups/${id}`);
    revalidatePath(`/dentist/patients/${followUp.patient_id}`);

    return { data: followUp, error: null };
  } catch (err) {
    console.error("[completeFollowUp] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// cancelFollowUp — dentist only
// =============================================================================

export async function cancelFollowUp(
  id: string
): Promise<ActionResult<FollowUp>> {
  try {
    if (!id) return { data: null, error: "Follow-up ID is required" };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist") {
      return { data: null, error: "Forbidden: only dentists can cancel follow-ups." };
    }

    const { data, error } = await db
      .from("follow_ups")
      .update({
        status:     "cancelled",
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("clinic_id", profile.clinic_id)
      .eq("status", "pending")
      .is("deleted_at", null)
      .select()
      .single();

    if (error) {
      console.error("[cancelFollowUp]", error);
      return { data: null, error: "Failed to cancel follow-up." };
    }
    if (!data) return { data: null, error: "Follow-up not found or not pending." };

    const followUp = data as FollowUp;

    revalidatePath("/dentist/follow-ups");
    revalidatePath(`/dentist/follow-ups/${id}`);
    revalidatePath(`/dentist/patients/${followUp.patient_id}`);

    return { data: followUp, error: null };
  } catch (err) {
    console.error("[cancelFollowUp] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getFollowUp — single follow-up by id with relations (staff only)
// =============================================================================

export async function getFollowUp(
  id: string
): Promise<ActionResult<FollowUpWithRelations>> {
  try {
    if (!id) return { data: null, error: "Follow-up ID is required" };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role === "patient") {
      return { data: null, error: "Forbidden" };
    }

    const { data, error } = await db
      .from("follow_ups")
      .select(
        "*, " +
        "patient:patients(id, name, phone), " +
        // Disambiguated FK. Appointments now reference follow_ups too
        // (appointments.follow_up_id), so two relationships exist between the
        // tables and PostgREST cannot guess which one an embed means. This is
        // the ORIGINATING appointment — the visit that prompted the recall.
        "appointment:appointments!follow_ups_appointment_id_fkey(id, scheduled_at, status), " +
        "treatment:treatments(id, treatment_type, status)"
      )
      .eq("id", id)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null)
      .single();

    if (error || !data) {
      return { data: null, error: "Follow-up not found." };
    }

    return { data: data as FollowUpWithRelations, error: null };
  } catch (err) {
    console.error("[getFollowUp] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getFollowUpsForAppointment — all follow-ups linked to a specific appointment
// =============================================================================

export async function getFollowUpsForAppointment(
  appointmentId: string
): Promise<ActionResult<FollowUpWithRelations[]>> {
  try {
    if (!appointmentId) return { data: [], error: null };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role === "patient") {
      return { data: null, error: "Forbidden" };
    }

    const { data, error } = await db
      .from("follow_ups")
      .select(
        "*, " +
        "patient:patients(id, name, phone), " +
        // Disambiguated FK. Appointments now reference follow_ups too
        // (appointments.follow_up_id), so two relationships exist between the
        // tables and PostgREST cannot guess which one an embed means. This is
        // the ORIGINATING appointment — the visit that prompted the recall.
        "appointment:appointments!follow_ups_appointment_id_fkey(id, scheduled_at, status), " +
        "treatment:treatments(id, treatment_type, status)"
      )
      .eq("appointment_id", appointmentId)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null)
      .order("due_date", { ascending: true });

    if (error) {
      console.error("[getFollowUpsForAppointment]", error);
      return { data: null, error: "Failed to fetch follow-ups." };
    }

    return { data: (data ?? []) as FollowUpWithRelations[], error: null };
  } catch (err) {
    console.error("[getFollowUpsForAppointment] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getFollowUpsForPatient — all follow-ups for a patient profile (staff)
// =============================================================================

export async function getFollowUpsForPatient(
  patientId: string
): Promise<ActionResult<FollowUpWithRelations[]>> {
  try {
    if (!patientId) return { data: [], error: null };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role === "patient") {
      return { data: null, error: "Forbidden" };
    }

    const { data, error } = await db
      .from("follow_ups")
      .select(
        "*, " +
        "patient:patients(id, name, phone), " +
        // Disambiguated FK. Appointments now reference follow_ups too
        // (appointments.follow_up_id), so two relationships exist between the
        // tables and PostgREST cannot guess which one an embed means. This is
        // the ORIGINATING appointment — the visit that prompted the recall.
        "appointment:appointments!follow_ups_appointment_id_fkey(id, scheduled_at, status), " +
        "treatment:treatments(id, treatment_type, status)"
      )
      .eq("patient_id", patientId)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null)
      // Newest first, matching the clinic-wide Follow-ups tab.
      .order("due_date", { ascending: false })
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[getFollowUpsForPatient]", error);
      return { data: null, error: "Failed to fetch follow-ups." };
    }

    return { data: (data ?? []) as FollowUpWithRelations[], error: null };
  } catch (err) {
    console.error("[getFollowUpsForPatient] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getAllFollowUps — clinic-wide list for /dentist/follow-ups dashboard
// Overdue follow-ups first, then by due_date ascending.
// Accepts optional status filter.
// =============================================================================

export async function getAllFollowUps(filters?: {
  status?: "pending" | "completed" | "cancelled" | "overdue";
  confirmation?: "tentative" | "confirmed";
  treatmentType?: string;
  page?: number;
  limit?: number;
  /** Free-text search across patient name + phone. */
  search?: string;
  dateFrom?: string;
  dateTo?: string;
}): Promise<ActionResult<{ followUps: FollowUpWithRelations[]; total: number }>> {
  try {
    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role === "patient") {
      return { data: null, error: "Forbidden" };
    }

    const page  = filters?.page ?? 1;
    const limit = Math.min(filters?.limit ?? 50, 100);
    const from  = (page - 1) * limit;
    const to    = from + limit - 1;

    // Guard: inverted date range → return empty immediately
    if (filters?.dateFrom && filters?.dateTo && filters.dateFrom > filters.dateTo) {
      return { data: { followUps: [], total: 0 }, error: null };
    }

    const today = await todayForClinic(db, profile.clinic_id);
    const search = filters?.search?.trim();

    // Free-text search: resolve matching patient IDs first.
    // Mirrors the pattern from getAppointments().
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
        return { data: { followUps: [], total: 0 }, error: null };
      }
    }

    let query = db
      .from("follow_ups")
      .select(
        "*, " +
        "patient:patients(id, name, phone), " +
        // Disambiguated FK. Appointments now reference follow_ups too
        // (appointments.follow_up_id), so two relationships exist between the
        // tables and PostgREST cannot guess which one an embed means. This is
        // the ORIGINATING appointment — the visit that prompted the recall.
        "appointment:appointments!follow_ups_appointment_id_fkey(id, scheduled_at, status), " +
        "treatment:treatments(id, treatment_type, status)",
        { count: "exact" }
      )
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null);

    if (filters?.status === "overdue") {
      query = query.eq("status", "pending").lt("due_date", today);
    } else if (filters?.status) {
      query = query.eq("status", filters.status);
    }

    if (filters?.confirmation) {
      query = query.eq("confirmation_status", filters.confirmation);
    }

    if (filters?.treatmentType) {
      query = query.eq("follow_up_type", filters.treatmentType);
    }

    if (patientIdFilter !== null) {
      query = query.in("patient_id", patientIdFilter);
    }

    if (filters?.dateFrom) query = query.gte("due_date", filters.dateFrom);
    if (filters?.dateTo)   query = query.lte("due_date", filters.dateTo);

    /*
     * Newest first.
     *
     * The list read oldest-first, so the Follow-ups tab opened on recalls due
     * months ago and the one just created was on the last page. `due_date` is
     * the date the follow-up is FOR, which is what the tab is sorted by;
     * `created_at` breaks ties so two recalls due the same day appear in the
     * order they were entered, newest first.
     *
     * getOverdueFollowUps deliberately keeps its ascending order — that one is
     * a worklist, and there the most overdue item is the one to deal with
     * first.
     */
    const { data, error, count } = await query
      .order("due_date", { ascending: false })
      .order("created_at", { ascending: false })
      .range(from, to);

    if (error) {
      console.error("[getAllFollowUps]", error);
      return { data: null, error: "Failed to fetch follow-ups." };
    }

    return {
      data: {
        followUps: (data ?? []) as FollowUpWithRelations[],
        total: count ?? 0,
      },
      error: null,
    };
  } catch (err) {
    console.error("[getAllFollowUps] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getOverdueFollowUps — dentist dashboard + analytics
// =============================================================================

export async function getOverdueFollowUps(): Promise<
  ActionResult<FollowUpWithRelations[]>
> {
  try {
    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role === "patient") {
      return { data: null, error: "Forbidden" };
    }

    const today = await todayForClinic(db, profile.clinic_id);

    const { data, error } = await db
      .from("follow_ups")
      .select(
        "*, " +
        "patient:patients(id, name, phone), " +
        // Disambiguated FK. Appointments now reference follow_ups too
        // (appointments.follow_up_id), so two relationships exist between the
        // tables and PostgREST cannot guess which one an embed means. This is
        // the ORIGINATING appointment — the visit that prompted the recall.
        "appointment:appointments!follow_ups_appointment_id_fkey(id, scheduled_at, status), " +
        "treatment:treatments(id, treatment_type, status)"
      )
      .eq("clinic_id", profile.clinic_id)
      .eq("status", "pending")
      .lt("due_date", today)
      .is("deleted_at", null)
      .order("due_date", { ascending: true });

    if (error) {
      console.error("[getOverdueFollowUps]", error);
      return { data: null, error: "Failed to fetch overdue follow-ups." };
    }

    return {
      data: (data ?? []) as FollowUpWithRelations[],
      error: null,
    };
  } catch (err) {
    console.error("[getOverdueFollowUps] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getPatientAppointments — fetch appointments for a patient (used by form)
// Returns lightweight list for the appointment selector in the follow-up form.
// =============================================================================

export async function getPatientAppointmentsForFollowUp(
  patientId: string
): Promise<ActionResult<Array<{ id: string; scheduled_at: string; status: string }>>> {
  try {
    if (!patientId) return { data: [], error: null };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role === "patient") return { data: null, error: "Forbidden" };

    const { data, error } = await db
      .from("appointments")
      .select("id, scheduled_at, status")
      .eq("patient_id", patientId)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null)
      .not("status", "in", '("cancelled","no_show")')
      .order("scheduled_at", { ascending: false })
      .limit(20);

    if (error) {
      console.error("[getPatientAppointmentsForFollowUp]", error);
      return { data: null, error: "Failed to fetch appointments." };
    }

    return {
      data: (data ?? []) as Array<{ id: string; scheduled_at: string; status: string }>,
      error: null,
    };
  } catch (err) {
    console.error("[getPatientAppointmentsForFollowUp] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getPatientTreatmentsForFollowUp — fetch treatments for a patient (used by form)
// =============================================================================

export async function getPatientTreatmentsForFollowUp(
  patientId: string
): Promise<ActionResult<Array<{ id: string; treatment_type: string; status: string }>>> {
  try {
    if (!patientId) return { data: [], error: null };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role === "patient") return { data: null, error: "Forbidden" };

    const { data, error } = await db
      .from("treatments")
      .select("id, treatment_type, status")
      .eq("patient_id", patientId)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) {
      console.error("[getPatientTreatmentsForFollowUp]", error);
      return { data: null, error: "Failed to fetch treatments." };
    }

    return {
      data: (data ?? []) as Array<{ id: string; treatment_type: string; status: string }>,
      error: null,
    };
  } catch (err) {
    console.error("[getPatientTreatmentsForFollowUp] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getPatientPortalFollowUps — patient portal: view own follow-ups only
// =============================================================================

export async function getPatientPortalFollowUps(): Promise<ActionResult<FollowUp[]>> {
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
      .from("follow_ups")
      .select("*")
      .eq("patient_id", link.patient_id)
      .is("deleted_at", null)
      .order("due_date", { ascending: true });

    if (error) {
      console.error("[getPatientPortalFollowUps]", error);
      return { data: null, error: "Failed to fetch follow-ups." };
    }

    return { data: (data ?? []) as FollowUp[], error: null };
  } catch (err) {
    console.error("[getPatientPortalFollowUps] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getPortalToday — the authenticated patient's CLINIC's local date
// =============================================================================
//
// The portal pages compute "is this overdue" client-side against a "today"
// they derive themselves. That used to be `new Date()` at render time, which
// on Vercel runs in UTC regardless of which clinic (and which timezone) the
// patient belongs to — the same class of bug fixed in FollowUpList.tsx and
// PatientFollowUpsTab.tsx. This gives portal pages the same clinic-aware
// answer those already get, without changing getPatientPortalFollowUps'
// existing return shape.

export async function getPortalToday(): Promise<ActionResult<string>> {
  try {
    const db: DbClient = await createServerClient();

    const {
      data: { user },
    } = await db.auth.getUser();
    if (!user) return { data: null, error: "Unauthorized" };

    const { data: linkData } = await db
      .from("patient_portal_links")
      .select("patient_id")
      .eq("user_id", user.id)
      .single();
    const link = linkData as { patient_id: string } | null;
    if (!link?.patient_id) return { data: null, error: "Portal account not linked." };

    const { data: patientData } = await db
      .from("patients")
      .select("clinic_id")
      .eq("id", link.patient_id)
      .single();
    const clinicId = (patientData as { clinic_id: string } | null)?.clinic_id;
    if (!clinicId) return { data: null, error: "Clinic not found." };

    return { data: await todayForClinic(db, clinicId), error: null };
  } catch (err) {
    console.error("[getPortalToday] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getFollowUpStats — summary counts for dashboard KPIs
// =============================================================================

export async function getFollowUpStats(): Promise<
  ActionResult<{
    pending: number;
    overdue: number;
    completed: number;
    upcoming: number;
  }>
> {
  try {
    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role === "patient") {
      return { data: null, error: "Forbidden" };
    }

    const today = await todayForClinic(db, profile.clinic_id);

    const { data, error } = await db
      .from("follow_ups")
      .select("status, due_date")
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null);

    if (error) {
      console.error("[getFollowUpStats]", error);
      return { data: null, error: "Failed to fetch follow-up stats." };
    }

    const rows = (data ?? []) as { status: string; due_date: string }[];

    const stats = { pending: 0, overdue: 0, completed: 0, upcoming: 0 };

    for (const row of rows) {
      if (row.status === "pending") {
        stats.pending++;
        if (row.due_date < today) {
          stats.overdue++;
        } else {
          stats.upcoming++;
        }
      } else if (row.status === "completed") {
        stats.completed++;
      }
    }

    return { data: stats, error: null };
  } catch (err) {
    console.error("[getFollowUpStats] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}
