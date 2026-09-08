"use server";

import { revalidatePath } from "next/cache";
import { resolveSession as resolveCachedSession } from "@/lib/auth/session";
import { getTodayInTimezone } from "@/lib/utils";
import {
  CreateConsultantSchema,
  UpdateConsultantSchema,
  RecordConsultancyIncomeSchema,
  UpdateConsultancyIncomeSchema,
  CreateConsultancyScheduleSchema,
  CreateUnavailableDateSchema,
  type ActionResult,
  type Consultant,
  type ConsultancyIncome,
  type ConsultancySchedule,
  type UnavailableDate,
} from "@/types";

/**
 * Consultant Management — Server Actions
 *
 * Rules:
 * - clinic_id / dentist_id always come from the session, never the client.
 * - Only dentists mutate consultants, consultancy income, schedules, holidays.
 * - Consultants are clinic-scoped; consultancy income is dentist-scoped.
 * - RLS enforces the same boundaries at the database level.
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

const SETTINGS_PATH = "/dentist/settings";

// =============================================================================
// CONSULTANT DIRECTORY
// =============================================================================

export async function getConsultants(): Promise<ActionResult<Consultant[]>> {
  try {
    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };

    const { data, error } = await db
      .from("consultants")
      .select("*")
      .eq("clinic_id", profile.clinic_id)
      .eq("is_active", true)
      .order("name", { ascending: true });

    if (error) {
      console.error("[getConsultants]", error);
      return { data: null, error: "Failed to fetch consultants." };
    }

    return { data: (data ?? []) as Consultant[], error: null };
  } catch (err) {
    console.error("[getConsultants] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

export async function createConsultant(
  input: unknown
): Promise<ActionResult<Consultant>> {
  try {
    const parsed = CreateConsultantSchema.safeParse(input);
    if (!parsed.success) {
      return { data: null, error: parsed.error.errors[0]?.message ?? "Invalid input" };
    }

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist") {
      return { data: null, error: "Forbidden: only dentists can add consultants." };
    }

    const { data, error } = await db
      .from("consultants")
      .insert({
        clinic_id: profile.clinic_id,
        name: parsed.data.name,
        designation: parsed.data.designation ?? null,
        phone: parsed.data.phone ?? null,
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        return { data: null, error: "A consultant with this name already exists." };
      }
      console.error("[createConsultant]", error);
      return { data: null, error: "Failed to create consultant." };
    }

    revalidatePath(SETTINGS_PATH);
    return { data: data as Consultant, error: null };
  } catch (err) {
    console.error("[createConsultant] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

export async function updateConsultant(
  id: string,
  input: unknown
): Promise<ActionResult<Consultant>> {
  try {
    if (!id) return { data: null, error: "Consultant ID is required" };

    const parsed = UpdateConsultantSchema.safeParse(input);
    if (!parsed.success) {
      return { data: null, error: parsed.error.errors[0]?.message ?? "Invalid input" };
    }

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist") {
      return { data: null, error: "Forbidden: only dentists can edit consultants." };
    }

    const { data, error } = await db
      .from("consultants")
      .update({
        name: parsed.data.name,
        designation: parsed.data.designation ?? null,
        phone: parsed.data.phone ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("clinic_id", profile.clinic_id)
      .eq("is_active", true)
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        return { data: null, error: "A consultant with this name already exists." };
      }
      console.error("[updateConsultant]", error);
      return { data: null, error: "Failed to update consultant." };
    }
    if (!data) return { data: null, error: "Consultant not found." };

    revalidatePath(SETTINGS_PATH);
    return { data: data as Consultant, error: null };
  } catch (err) {
    console.error("[updateConsultant] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

/**
 * Delete a consultant. Soft-deletes (is_active = false) so historical treatment
 * links and their stored revenue splits remain intact. Removed from the
 * directory and the treatment-form dropdown.
 */
export async function deleteConsultant(id: string): Promise<ActionResult<null>> {
  try {
    if (!id) return { data: null, error: "Consultant ID is required" };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist") {
      return { data: null, error: "Forbidden: only dentists can delete consultants." };
    }

    const { error } = await db
      .from("consultants")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("clinic_id", profile.clinic_id);

    if (error) {
      console.error("[deleteConsultant]", error);
      return { data: null, error: "Failed to delete consultant." };
    }

    revalidatePath(SETTINGS_PATH);
    return { data: null, error: null };
  } catch (err) {
    console.error("[deleteConsultant] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// CONSULTANCY INCOME (external earnings)
// =============================================================================

/** Total external consultancy income the dentist recorded for today. */
export async function getConsultancyRevenueToday(): Promise<ActionResult<number>> {
  try {
    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist") return { data: null, error: "Forbidden" };

    const { data: settings } = await db
      .from("clinic_settings")
      .select("timezone")
      .eq("clinic_id", profile.clinic_id)
      .maybeSingle();
    const tz = (settings as { timezone?: string } | null)?.timezone ?? "Asia/Kolkata";
    const today = getTodayInTimezone(tz);

    const { data, error } = await db
      .from("consultancy_income")
      .select("amount")
      .eq("clinic_id", profile.clinic_id)
      .eq("dentist_id", profile.id)
      .eq("date", today);

    if (error) {
      console.error("[getConsultancyRevenueToday]", error);
      return { data: null, error: "Failed to fetch consultancy revenue." };
    }

    const total = ((data ?? []) as { amount: number }[]).reduce(
      (sum, c) => sum + Number(c.amount ?? 0),
      0
    );
    return { data: total, error: null };
  } catch (err) {
    console.error("[getConsultancyRevenueToday] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

export async function recordConsultancyIncome(
  input: unknown
): Promise<ActionResult<ConsultancyIncome>> {
  try {
    const parsed = RecordConsultancyIncomeSchema.safeParse(input);
    if (!parsed.success) {
      return { data: null, error: parsed.error.errors[0]?.message ?? "Invalid input" };
    }

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist") {
      return { data: null, error: "Forbidden: only dentists can record consultancy income." };
    }

    /*
     * Reserving the time.
     *
     * When a slot is given, the same range is written to consultancy_schedules
     * FIRST, because that is the table getAvailableSlots already subtracts from
     * (actions/availability.ts) for every booking channel — dentist,
     * receptionist and patient portal alike. Writing it here is what makes the
     * reservation real; the income row alone would block nothing.
     *
     * Deliberately NOT a second scheduling system. consultancy_schedules exists
     * for exactly this ("Specific-date time ranges when the dentist consults
     * externally", 20260707000000) and was previously only reachable from
     * Settings, where nobody thought to use it when recording a consultation.
     *
     * Order matters: if the block succeeds and the income insert then fails, a
     * stray block would silently withhold slots from the schedule with nothing
     * on screen explaining why — so the block is rolled back on failure below.
     */
    let scheduleId: string | null = null;
    if (parsed.data.start_time && parsed.data.end_time) {
      const { data: block, error: blockErr } = await db
        .from("consultancy_schedules")
        .insert({
          clinic_id: profile.clinic_id,
          dentist_id: profile.id,
          date: parsed.data.date,
          start_time: parsed.data.start_time,
          end_time: parsed.data.end_time,
          reason: parsed.data.external_clinic
            ? `External consultation — ${parsed.data.external_clinic}`
            : "External consultation",
        })
        .select("id")
        .single();

      if (blockErr || !block) {
        console.error("[recordConsultancyIncome] schedule block:", blockErr);
        return { data: null, error: "Failed to reserve that time slot." };
      }
      scheduleId = (block as { id: string }).id;
    }

    const { data, error } = await db
      .from("consultancy_income")
      .insert({
        clinic_id: profile.clinic_id,
        dentist_id: profile.id,
        date: parsed.data.date,
        external_clinic: parsed.data.external_clinic ?? null,
        description: parsed.data.description ?? null,
        // Optional: the slot is routinely reserved before the fee is agreed.
        amount: parsed.data.amount ?? null,
        is_paid: parsed.data.is_paid ?? false,
        start_time: parsed.data.start_time ?? null,
        end_time: parsed.data.end_time ?? null,
        schedule_id: scheduleId,
        notes: parsed.data.notes ?? null,
      })
      .select()
      .single();

    if (error) {
      console.error("[recordConsultancyIncome]", error);
      if (scheduleId) {
        // Undo the block. Leaving it would withhold slots for a consultation
        // that was never recorded, and nothing on any screen would explain it.
        await db.from("consultancy_schedules").delete().eq("id", scheduleId);
      }
      return { data: null, error: "Failed to record consultancy income." };
    }

    revalidatePath("/dentist/external-consultations");
    revalidatePath("/dentist/payments");
    revalidatePath("/dentist/analytics");
    revalidatePath("/dentist");
    // The reserved slot changes what the booking screens may offer.
    if (scheduleId) {
      revalidatePath("/dentist/appointments");
      revalidatePath("/receptionist/appointments");
      revalidatePath(SETTINGS_PATH);
    }
    return { data: data as ConsultancyIncome, error: null };
  } catch (err) {
    console.error("[recordConsultancyIncome] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

/**
 * Edit an already-recorded consultation: the fee, and whether it has been paid.
 *
 * Both remain editable after creation on purpose. A consultation is commonly
 * booked before the amount is agreed and paid some time after that, so a record
 * that could not be revised would force the dentist to guess a figure at
 * booking time or delete and re-enter the row — which would also drop the
 * reserved slot.
 *
 * The date and the reserved slot are NOT editable here. Moving the time means
 * moving the consultancy_schedules block that depends on it, which is a
 * different operation with its own conflict rules.
 */
export async function updateConsultancyIncome(
  id: string,
  input: unknown
): Promise<ActionResult<ConsultancyIncome>> {
  try {
    if (!id) return { data: null, error: "Consultation ID is required" };

    const parsed = UpdateConsultancyIncomeSchema.safeParse(input);
    if (!parsed.success) {
      return { data: null, error: parsed.error.errors[0]?.message ?? "Invalid input" };
    }

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist") {
      return { data: null, error: "Forbidden: only dentists can edit consultancy income." };
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    // `amount` is explicitly nullable — clearing it back to "not yet known" is
    // a legitimate edit, so `undefined` (absent) and `null` (cleared) differ.
    if (parsed.data.amount !== undefined) updates.amount = parsed.data.amount;
    if (parsed.data.is_paid !== undefined) updates.is_paid = parsed.data.is_paid;

    const { data, error } = await db
      .from("consultancy_income")
      .update(updates)
      .eq("id", id)
      .eq("clinic_id", profile.clinic_id)
      .eq("dentist_id", profile.id)
      .select()
      .single();

    if (error) {
      console.error("[updateConsultancyIncome]", error);
      return { data: null, error: "Failed to update the consultation." };
    }
    if (!data) return { data: null, error: "Consultation not found." };

    revalidatePath("/dentist/external-consultations");
    revalidatePath("/dentist/payments");
    revalidatePath("/dentist/analytics");
    revalidatePath("/dentist");
    return { data: data as ConsultancyIncome, error: null };
  } catch (err) {
    console.error("[updateConsultancyIncome] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

/**
 * How many recorded external consultations have not been paid for.
 *
 * A count, not the rows: this feeds the dashboard Actions card, which needs to
 * know whether there is anything to chase, not what it is. `head: true` means
 * PostgREST returns the count and no body.
 */
export async function getUnpaidConsultationCount(): Promise<ActionResult<number>> {
  try {
    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist") return { data: 0, error: null };

    const { count, error } = await db
      .from("consultancy_income")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", profile.clinic_id)
      .eq("dentist_id", profile.id)
      .eq("is_paid", false);

    if (error) {
      console.error("[getUnpaidConsultationCount]", error);
      return { data: 0, error: null };
    }
    return { data: count ?? 0, error: null };
  } catch (err) {
    console.error("[getUnpaidConsultationCount] unexpected:", err);
    return { data: 0, error: null };
  }
}

/**
 * List all external consultancy income entries for the dentist, newest first.
 * Used by the External Consultations page. Dentist-scoped; clinic-isolated.
 */
export async function getConsultancyIncome(): Promise<
  ActionResult<ConsultancyIncome[]>
> {
  try {
    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist") return { data: null, error: "Forbidden" };

    const { data, error } = await db
      .from("consultancy_income")
      .select("*")
      .eq("clinic_id", profile.clinic_id)
      .eq("dentist_id", profile.id)
      .order("date", { ascending: false })
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[getConsultancyIncome]", error);
      return { data: null, error: "Failed to fetch external consultations." };
    }

    return { data: (data ?? []) as ConsultancyIncome[], error: null };
  } catch (err) {
    console.error("[getConsultancyIncome] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// CONSULTANCY SCHEDULES (recurring weekly blocks)
// =============================================================================

export async function getConsultancySchedules(): Promise<
  ActionResult<ConsultancySchedule[]>
> {
  try {
    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };

    const { data, error } = await db
      .from("consultancy_schedules")
      .select("*")
      .eq("clinic_id", profile.clinic_id)
      .eq("is_active", true)
      .order("date", { ascending: true })
      .order("start_time", { ascending: true });

    if (error) {
      console.error("[getConsultancySchedules]", error);
      return { data: null, error: "Failed to fetch consultancy schedules." };
    }

    return { data: (data ?? []) as ConsultancySchedule[], error: null };
  } catch (err) {
    console.error("[getConsultancySchedules] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

export async function createConsultancySchedule(
  input: unknown
): Promise<ActionResult<ConsultancySchedule>> {
  try {
    const parsed = CreateConsultancyScheduleSchema.safeParse(input);
    if (!parsed.success) {
      return { data: null, error: parsed.error.errors[0]?.message ?? "Invalid input" };
    }

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist") {
      return { data: null, error: "Forbidden: only dentists can add consultancy schedules." };
    }

    const { data, error } = await db
      .from("consultancy_schedules")
      .insert({
        clinic_id: profile.clinic_id,
        dentist_id: profile.id,
        date: parsed.data.date,
        start_time: parsed.data.start_time,
        end_time: parsed.data.end_time,
        reason: parsed.data.reason ?? null,
      })
      .select()
      .single();

    if (error) {
      console.error("[createConsultancySchedule]", error);
      return { data: null, error: "Failed to create consultancy schedule." };
    }

    revalidatePath(SETTINGS_PATH);
    return { data: data as ConsultancySchedule, error: null };
  } catch (err) {
    console.error("[createConsultancySchedule] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

export async function deleteConsultancySchedule(id: string): Promise<ActionResult<null>> {
  try {
    if (!id) return { data: null, error: "Schedule ID is required" };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist") return { data: null, error: "Forbidden" };

    const { error } = await db
      .from("consultancy_schedules")
      .delete()
      .eq("id", id)
      .eq("clinic_id", profile.clinic_id);

    if (error) {
      console.error("[deleteConsultancySchedule]", error);
      return { data: null, error: "Failed to delete consultancy schedule." };
    }

    revalidatePath(SETTINGS_PATH);
    return { data: null, error: null };
  } catch (err) {
    console.error("[deleteConsultancySchedule] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// UNAVAILABLE DATES (holidays / closures)
// =============================================================================

export async function getUnavailableDates(): Promise<ActionResult<UnavailableDate[]>> {
  try {
    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };

    const { data, error } = await db
      .from("unavailable_dates")
      .select("*")
      .eq("clinic_id", profile.clinic_id)
      .order("date", { ascending: true });

    if (error) {
      console.error("[getUnavailableDates]", error);
      return { data: null, error: "Failed to fetch unavailable dates." };
    }

    return { data: (data ?? []) as UnavailableDate[], error: null };
  } catch (err) {
    console.error("[getUnavailableDates] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

export async function createUnavailableDate(
  input: unknown
): Promise<ActionResult<UnavailableDate>> {
  try {
    const parsed = CreateUnavailableDateSchema.safeParse(input);
    if (!parsed.success) {
      return { data: null, error: parsed.error.errors[0]?.message ?? "Invalid input" };
    }

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist") {
      return { data: null, error: "Forbidden: only dentists can add unavailable dates." };
    }

    const { data, error } = await db
      .from("unavailable_dates")
      .insert({
        clinic_id: profile.clinic_id,
        dentist_id: profile.id,
        date: parsed.data.date,
        reason: parsed.data.reason ?? null,
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        return { data: null, error: "This date is already marked as unavailable." };
      }
      console.error("[createUnavailableDate]", error);
      return { data: null, error: "Failed to create unavailable date." };
    }

    revalidatePath(SETTINGS_PATH);
    return { data: data as UnavailableDate, error: null };
  } catch (err) {
    console.error("[createUnavailableDate] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

export async function deleteUnavailableDate(id: string): Promise<ActionResult<null>> {
  try {
    if (!id) return { data: null, error: "Unavailable date ID is required" };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role !== "dentist") return { data: null, error: "Forbidden" };

    const { error } = await db
      .from("unavailable_dates")
      .delete()
      .eq("id", id)
      .eq("clinic_id", profile.clinic_id);

    if (error) {
      console.error("[deleteUnavailableDate]", error);
      return { data: null, error: "Failed to delete unavailable date." };
    }

    revalidatePath(SETTINGS_PATH);
    return { data: null, error: null };
  } catch (err) {
    console.error("[deleteUnavailableDate] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}
