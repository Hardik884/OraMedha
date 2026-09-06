"use server";

import { revalidatePath } from "next/cache";
import { resolveSession as resolveCachedSession } from "@/lib/auth/session";
import {
  CreateAvailabilityRuleSchema,
  type ActionResult,
  type AvailabilityRule,
} from "@/types";
import {
  getAvailableSlots as computeSlots,
  type AvailabilityRule as SlotRule,
  type OccupiedSlot,
} from "@/lib/scheduling/slots";
import { getUtcBoundariesForLocalDate } from "@/lib/utils";
import { resolveClinicDentistId } from "@/lib/staff/dentist-directory";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = any;

type ResolvedProfile = {
  id: string;
  clinic_id: string;
  role: "dentist" | "receptionist" | "patient";
};

type ClinicDayHours = {
  open: string | null;
  close: string | null;
  is_open: boolean;
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
// clinicHoursToSlotRules
//
// Converts a clinic_hours JSONB object (source of truth) into the SlotRule[]
// format expected by the slot generation engine.
//
// DOW mapping: clinic_hours keys are day names; Sunday = 0, Monday = 1, …
// =============================================================================

const DAY_NAME_TO_DOW: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

function clinicHoursToSlotRules(
  clinicHours: Record<string, ClinicDayHours>,
  requestedDayOfWeek: number,
  slotDurationMinutes: number
): SlotRule[] {
  const rules: SlotRule[] = [];

  for (const [dayName, hours] of Object.entries(clinicHours)) {
    const dow = DAY_NAME_TO_DOW[dayName.toLowerCase()];
    if (dow === undefined || dow !== requestedDayOfWeek) continue;
    if (!hours.is_open || !hours.open || !hours.close) continue;

    rules.push({
      startTime: hours.open.slice(0, 5),
      endTime: hours.close.slice(0, 5),
      slotDurationMinutes,
    });
  }

  return rules;
}

// =============================================================================
// getAvailableSlots — duration-aware slot generation
//
// Source of truth priority:
//   1. clinic_hours (from clinic_settings) — always used first
//   2. availability_rules — used as override if active rules exist for the day
//      (backward-compatible: clinics that already configured rules keep them)
//
// Closed days (is_open: false in clinic_hours OR no active rule) → no slots.
// Outside clinic hours → no slots.
// Overlap prevention and duration validation still enforced by the slot engine.
//
// Used by: portal SlotPicker, staff AppointmentForm, RescheduleModal,
//          Patient AI Assistant, and createAppointment server action.
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

    // Fetch clinic settings: timezone + clinic_hours + avg duration
    const { data: settings } = await db
      .from("clinic_settings")
      .select("timezone, clinic_hours, average_appointment_duration")
      .eq("clinic_id", resolvedClinicId)
      .maybeSingle();

    const timezone =
      (settings as { timezone?: string } | null)?.timezone ?? "Asia/Kolkata";
    const clinicHours =
      (settings as { clinic_hours?: Record<string, ClinicDayHours> } | null)
        ?.clinic_hours ?? null;
    const defaultSlotDuration =
      (settings as { average_appointment_duration?: number } | null)
        ?.average_appointment_duration ?? 30;

    // ── Past-date handling ──────────────────────────────────────────────────
    // Staff (dentist/receptionist) can list slots for any historical date so
    // they can record migrated / late-entered visits. Portal patients remain
    // restricted to today or later — they cannot self-book in the past.
    const todayInTz = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    if (profile.role === "patient" && date < todayInTz) {
      return { data: [], error: null };
    }

    // ── DOW: timezone-aware ─────────────────────────────────────────────────
    const noonLocal = new Date(`${date}T12:00:00`);
    const dayStr = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
    }).format(noonLocal);
    const dowMap: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    const dayOfWeek = dowMap[dayStr] ?? noonLocal.getDay();

    // ── Build slot rules ────────────────────────────────────────────────────
    // Step 1: Try availability_rules for this day (explicit overrides)
    const { data: dbRules, error: rulesErr } = await db
      .from("availability_rules")
      .select("start_time, end_time, slot_duration_minutes")
      .eq("clinic_id", resolvedClinicId)
      .eq("day_of_week", dayOfWeek)
      .eq("is_active", true);

    if (rulesErr) {
      console.error("[getAvailableSlots] rules:", rulesErr);
      return { data: null, error: "Failed to fetch availability rules." };
    }

    let slotRules: SlotRule[];

    if (dbRules && dbRules.length > 0) {
      // Explicit availability rules configured — use them (legacy / override path)
      slotRules = (
        dbRules as { start_time: string; end_time: string; slot_duration_minutes: number }[]
      ).map((r) => ({
        startTime: r.start_time.slice(0, 5),
        endTime: r.end_time.slice(0, 5),
        slotDurationMinutes: r.slot_duration_minutes,
      }));
    } else if (clinicHours) {
      // No explicit rules — derive from clinic_hours (primary path going forward)
      slotRules = clinicHoursToSlotRules(
        clinicHours,
        dayOfWeek,
        defaultSlotDuration
      );
    } else {
      // No clinic_hours and no rules → no slots
      return { data: [], error: null };
    }

    if (slotRules.length === 0) {
      // Day is closed (is_open: false or no matching rule)
      return { data: [], error: null };
    }

    // ── Dentist for occupied-slot lookup ────────────────────────────────────
    // Through the service role: this runs for portal patients, who no longer
    // have any read on a staff profiles row (migration 20260905090000).
    // `resolvedClinicId` was resolved from the portal link above, server-side.
    const dentistId = (await resolveClinicDentistId(resolvedClinicId)) ?? undefined;

    // ── Occupied slots ──────────────────────────────────────────────────────
    // Use UTC boundaries for the clinic's local date so that the gte/lte
    // comparison against the UTC-stored timestamptz column is correct.
    const { start: startBoundary, end: endBoundary } =
      getUtcBoundariesForLocalDate(date, timezone);

    // ── Holiday / closure check ─────────────────────────────────────────────
    // A full-day unavailable date blocks every slot for every booking channel.
    const { data: unavailableData } = await db
      .from("unavailable_dates")
      .select("id")
      .eq("clinic_id", resolvedClinicId)
      .eq("date", date)
      .limit(1);

    if (unavailableData && unavailableData.length > 0) {
      return { data: [], error: null };
    }

    // ── External consultancy schedule blocks ────────────────────────────────
    // Time ranges on this specific date when the dentist consults elsewhere.
    const { data: consultancyBlocks } = await db
      .from("consultancy_schedules")
      .select("start_time, end_time")
      .eq("clinic_id", resolvedClinicId)
      .eq("date", date)
      .eq("is_active", true);

    const blockedRanges: Array<{ start: string; end: string }> = (
      (consultancyBlocks ?? []) as { start_time: string; end_time: string }[]
    ).map((b) => ({
      start: b.start_time.slice(0, 5),
      end: b.end_time.slice(0, 5),
    }));

    const { data: occupied } = dentistId
      ? await db
          .from("appointments")
          .select("scheduled_at, duration_minutes")
          .eq("dentist_id", dentistId)
          .is("deleted_at", null)
          .not("status", "in", '("cancelled","no_show")')
          .gte("scheduled_at", startBoundary)
          .lte("scheduled_at", endBoundary)
      : { data: [] };

    const occupiedSlots: OccupiedSlot[] = (
      (occupied ?? []) as { scheduled_at: string; duration_minutes: number }[]
    ).map((o) => ({
      scheduledAt: o.scheduled_at,
      durationMinutes: o.duration_minutes ?? 30,
    }));

    // ── Past-slot cutoff for today ──────────────────────────────────────────
    let nowCutoffMinutes: number | null = null;
    if (date === todayInTz) {
      const now = new Date();
      const timeStr = new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
        .format(now)
        .slice(0, 5);
      const [h, m] = timeStr.split(":").map(Number);
      nowCutoffMinutes = (h ?? 0) * 60 + (m ?? 0);
    }

    const slots = computeSlots(
      date,
      slotRules,
      occupiedSlots,
      timezone,
      requestedDurationMinutes,
      nowCutoffMinutes,
      blockedRanges
    );

    return { data: slots, error: null };
  } catch (err) {
    console.error("[getAvailableSlots] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}
