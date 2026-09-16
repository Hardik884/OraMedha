"use server";

import { revalidatePath } from "next/cache";
import { resolveSession as resolveCachedSession } from "@/lib/auth/session";
import {
  CreateAvailabilityRuleSchema,
  type ActionResult,
  type AvailabilityRule,
} from "@/types";
import { loadClinicSchedule } from "@/lib/scheduling/schedule-source";
import { bookableSlots, loadOccupancy } from "@/lib/scheduling/booking-validation";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveClinicDentistId } from "@/lib/staff/dentist-directory";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = any;

type ResolvedProfile = {
  id: string;
  clinic_id: string;
  role: "dentist" | "receptionist" | "patient";
};

async function resolveSession() {
  const { db, profile } = await resolveCachedSession();
  return { db, profile };
}

// =============================================================================
// getAvailabilityRules — readable by all clinic members
// =============================================================================

export async function getAvailabilityRules(): Promise<
  ActionResult<AvailabilityRule[]>
> {
  try {
    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };

    const { data, error } = await db
      .from("availability_rules")
      .select("*")
      .eq("clinic_id", profile.clinic_id)
      .order("day_of_week", { ascending: true })
      .order("start_time", { ascending: true });

    if (error) {
      console.error("[getAvailabilityRules]", error);
      return { data: null, error: "Failed to fetch availability rules." };
    }

    return { data: (data ?? []) as AvailabilityRule[], error: null };
  } catch {
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// createAvailabilityRule — dentist only
// =============================================================================

export async function createAvailabilityRule(
  input: unknown
): Promise<ActionResult<AvailabilityRule>> {
  try {
    const parsed = CreateAvailabilityRuleSchema.safeParse(input);
    if (!parsed.success) {
      return {
        data: null,
        error: parsed.error.errors[0]?.message ?? "Invalid input",
      };
    }

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist") return { data: null, error: "Forbidden" };

    const { data, error } = await db
      .from("availability_rules")
      .insert({
        clinic_id: profile.clinic_id,
        day_of_week: parsed.data.day_of_week,
        start_time: parsed.data.start_time,
        end_time: parsed.data.end_time,
        slot_duration_minutes: parsed.data.slot_duration_minutes,
        is_active: parsed.data.is_active,
      })
      .select()
      .single();

    if (error) {
      console.error("[createAvailabilityRule]", error);
      return { data: null, error: "Failed to create availability rule." };
    }

    revalidatePath("/dentist/settings");
    return { data: data as AvailabilityRule, error: null };
  } catch {
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// updateAvailabilityRule — dentist only
// =============================================================================

export async function updateAvailabilityRule(
  id: string,
  input: unknown
): Promise<ActionResult<AvailabilityRule>> {
  try {
    const parsed = CreateAvailabilityRuleSchema.partial().safeParse(input);
    if (!parsed.success) {
      return {
        data: null,
        error: parsed.error.errors[0]?.message ?? "Invalid input",
      };
    }

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist") return { data: null, error: "Forbidden" };

    const { data, error } = await db
      .from("availability_rules")
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("clinic_id", profile.clinic_id)
      .select()
      .single();

    if (error) {
      console.error("[updateAvailabilityRule]", error);
      return { data: null, error: "Failed to update availability rule." };
    }

    revalidatePath("/dentist/settings");
    return { data: data as AvailabilityRule, error: null };
  } catch {
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// toggleAvailabilityRule — dentist only
// =============================================================================

export async function toggleAvailabilityRule(
  id: string,
  isActive: boolean
): Promise<ActionResult<AvailabilityRule>> {
  try {
    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist") return { data: null, error: "Forbidden" };

    const { data, error } = await db
      .from("availability_rules")
      .update({ is_active: isActive, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("clinic_id", profile.clinic_id)
      .select()
      .single();

    if (error) {
      console.error("[toggleAvailabilityRule]", error);
      return { data: null, error: "Failed to toggle availability rule." };
    }

    revalidatePath("/dentist/settings");
    return { data: data as AvailabilityRule, error: null };
  } catch {
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getAvailableSlots — duration-aware slot generation
//
// The slots a booking screen offers for a date, from the same schedule and the
// same rules the server applies when a slot is booked or an appointment moved
// (lib/scheduling/booking-validation.ts): availability rules for the weekday,
// else clinic hours; the whole appointment fitting; holidays and consultancy
// blocks; the dentist's other appointments; past-date rules; the clinic's
// timezone.
//
// Used by: portal SlotPicker, staff AppointmentForm, RescheduleModal and the
//          Patient AI Assistant.
// =============================================================================

export async function getAvailableSlots(
  date: string,
  /** Duration of the appointment being booked (minutes). Default: 30 */
  requestedDurationMinutes = 30
): Promise<ActionResult<string[]>> {
  try {
    if (!date) return { data: [], error: null };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };

    // Resolve clinic_id for portal patients via portal link
    let resolvedClinicId = profile.clinic_id;
    if (profile.role === "patient") {
      const { data: linkData } = await db
        .from("patient_portal_links")
        .select("patient_id, patients!inner(clinic_id)")
        .eq("user_id", profile.id)
        .single();

      if (!linkData) return { data: null, error: "Portal account not linked." };

      const link = linkData as {
        patient_id: string;
        patients: { clinic_id: string } | { clinic_id: string }[] | null;
      };
      const linkedClinicId = Array.isArray(link.patients)
        ? link.patients[0]?.clinic_id
        : link.patients?.clinic_id;
      if (!linkedClinicId) return { data: null, error: "Unable to determine clinic." };
      resolvedClinicId = linkedClinicId;
    }

    // ── The clinic schedule and the dentist's day ───────────────────────────
    // The same schedule and the same rules the server applies when the slot is
    // booked (lib/scheduling/booking-validation.ts), so every slot offered here
    // is accepted there. Other patients' appointments are read server-side —
    // only their times — because a portal patient's own session can see only
    // their own, and a list built from that offered slots already taken.
    const schedule = await loadClinicSchedule(db, resolvedClinicId, date, date);

    // Through the service role: this runs for portal patients, who no longer
    // have any read on a staff profiles row (migration 20260905090000).
    // `resolvedClinicId` was resolved from the portal link above, server-side.
    const dentistId = await resolveClinicDentistId(resolvedClinicId);
    const occupied = dentistId
      ? await loadOccupancy(createAdminClient(), {
          clinicId: resolvedClinicId,
          dentistId,
          date,
          timezone: schedule.timezone,
        })
      : [];

    const slots = bookableSlots(schedule, date, occupied, requestedDurationMinutes, {
      patientFacing: profile.role === "patient",
      hideStartedSlotsToday: true,
      now: new Date(),
    });

    return { data: slots, error: null };
  } catch (err) {
    console.error("[getAvailableSlots] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}
