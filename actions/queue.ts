"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@/lib/supabase/server";
import { resolveSession as resolveCachedSession } from "@/lib/auth/session";
import { getTodayInTimezone } from "@/lib/utils";
import { completeAppointmentCascade } from "@/lib/appointments/complete";
import type { ActionResult, QueueEntry, QueueEntryWithPatient } from "@/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = any;

type ResolvedProfile = {
  id: string;
  clinic_id: string;
  role: "dentist" | "receptionist" | "patient";
};

// =============================================================================
// resolveSession — shared session + profile resolution
// =============================================================================

async function resolveSession(): Promise<{
  db: DbClient;
  profile: ResolvedProfile | null;
}> {
  const { db, profile } = await resolveCachedSession();
  return { db, profile };
}

// =============================================================================
// resolveClinicForPortal — for patient role, resolve clinic_id from portal link
// =============================================================================

async function resolveClinicForPortalUser(
  db: DbClient,
  userId: string
): Promise<{ patientId: string; clinicId: string } | null> {
  const { data } = await db
    .from("patient_portal_links")
    .select("patient_id, patients!inner(clinic_id)")
    .eq("user_id", userId)
    .maybeSingle();

  if (!data) return null;

  const row = data as {
    patient_id: string;
    patients: { clinic_id: string } | { clinic_id: string }[] | null;
  };

  const clinicId = Array.isArray(row.patients)
    ? row.patients[0]?.clinic_id
    : row.patients?.clinic_id;

  if (!clinicId) return null;
  return { patientId: row.patient_id, clinicId };
}

// =============================================================================
// getClinicTimezone — fetches clinic_settings.timezone or returns UTC
// =============================================================================

async function getClinicTimezone(
  db: DbClient,
  clinicId: string
): Promise<string> {
  if (!clinicId) return "Asia/Kolkata";
  const { data } = await db
    .from("clinic_settings")
    .select("timezone")
    .eq("clinic_id", clinicId)
    .maybeSingle();
  return (data as { timezone?: string } | null)?.timezone ?? "Asia/Kolkata";
}

/**
 * todayForClinic — today's date (YYYY-MM-DD) in the clinic's local calendar.
 * Use this for queue_date inserts/queries instead of new Date().toISOString().split('T')[0]
 * which uses UTC and is wrong for clinics in non-UTC timezones.
 */
async function todayForClinic(
  db: DbClient,
  clinicId: string
): Promise<string> {
  const tz = await getClinicTimezone(db, clinicId);
  return getTodayInTimezone(tz);
}

/**
 * getServiceClient — service-role client used for queue position aggregation
 * for portal patients. RLS limits patient role to seeing only their own queue
 * row, so we cannot count "patients ahead" from the user session client.
 *
 * Reads only — never used to mutate data on behalf of a patient.
 */
function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

// =============================================================================
// checkInPatient — creates queue_entries row
// Called by: receptionist CheckInButton
// =============================================================================

export async function checkInPatient(
  appointmentId: string
): Promise<ActionResult<QueueEntry>> {
  try {
    if (!appointmentId) return { data: null, error: "Appointment ID required" };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };

    if (profile.role !== "dentist" && profile.role !== "receptionist") {
      return { data: null, error: "Forbidden" };
    }

    // Verify appointment belongs to this clinic and is in a check-in-eligible state
    const { data: appt } = await db
      .from("appointments")
      .select("id, patient_id, status, clinic_id")
      .eq("id", appointmentId)
      .eq("clinic_id", profile.clinic_id)
      .is("deleted_at", null)
      .single();

    if (!appt) return { data: null, error: "Appointment not found." };

    const appointment = appt as {
      id: string;
      patient_id: string;
      status: string;
      clinic_id: string;
    };

    if (
      !["scheduled", "checked_in"].includes(appointment.status)
    ) {
      return {
        data: null,
        error: `Cannot check in a ${appointment.status} appointment.`,
      };
    }

    // Prevent duplicate check-ins for today only.
    // We scope by queue_date so a past-day entry does not block today's check-in.
    const qDateEarly = await todayForClinic(db, profile.clinic_id);

    // Check for any existing queue entry for this appointment regardless of date.
    // The uq_queue_appointment DB constraint is NOT scoped to queue_date,
    // so we must check globally to give a clean error instead of a constraint violation.
    const { data: existingAny } = await db
      .from("queue_entries")
      .select("id, queue_date, status")
      .eq("appointment_id", appointmentId)
      .maybeSingle();

    if (existingAny) {
      const row = existingAny as { id: string; queue_date: string; status: string };
      if (row.queue_date === qDateEarly) {
        return { data: null, error: "Patient is already in the queue." };
      }
      // Entry exists from a previous day — the unique constraint will block re-insert.
      // Return a clear error rather than a cryptic DB constraint failure.
      return { data: null, error: "This appointment was already checked in on a previous visit. Please use a new appointment." };
    }

    // Use the already-computed date (avoids a second DB round-trip).
    const qDate = qDateEarly;

    // Get next position: MAX(position) + 1 for today's queue at this clinic
    const { data: posData } = await db
      .from("queue_entries")
      .select("position")
      .eq("clinic_id", profile.clinic_id)
      .eq("queue_date", qDate)
      .is("removed_at", null)
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();

    const nextPosition = ((posData as { position: number } | null)?.position ?? 0) + 1;

    // Insert queue entry
    const { data: entry, error: insertErr } = await db
      .from("queue_entries")
      .insert({
        clinic_id: profile.clinic_id,
        appointment_id: appointmentId,
        patient_id: appointment.patient_id,
        position: nextPosition,
        status: "waiting",
        checked_in_at: new Date().toISOString(),
        queue_date: qDate,
      })
      .select()
      .single();

    if (insertErr || !entry) {
      console.error("[checkInPatient] insert failed:", insertErr);
      return { data: null, error: insertErr?.message ?? "Failed to check in patient." };
    }

    // Also update the appointment status to checked_in if it was scheduled
    if (appointment.status === "scheduled") {
      const { error: apptUpdateErr } = await db
        .from("appointments")
        .update({ status: "checked_in", updated_at: new Date().toISOString() })
        .eq("id", appointmentId)
        .eq("clinic_id", profile.clinic_id);
      if (apptUpdateErr) {
        console.error("[checkInPatient] appointment status update failed:", apptUpdateErr);
      }
    }

    revalidatePath(`/${profile.role}/queue`);
    revalidatePath(`/${profile.role}/appointments`);
    revalidatePath(`/${profile.role}/appointments/${appointmentId}`);

    return { data: entry as QueueEntry, error: null };
  } catch (err) {
    console.error("[checkInPatient] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// advanceQueue — in_progress → completed, promote first waiting → in_progress
// Called by: dentist + receptionist QueueEntry "Call Next" button
// =============================================================================

export async function advanceQueue(): Promise<ActionResult<null>> {
  try {
    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };

    if (profile.role !== "dentist" && profile.role !== "receptionist") {
      return { data: null, error: "Forbidden" };
    }

    const cid = profile.clinic_id;
    const qDate = await todayForClinic(db, cid);

    // Find current in_progress entry — select patient_id directly to avoid
    // a follow-up appointment lookup when updating visit counts.
    const { data: currentData } = await db
      .from("queue_entries")
      .select("id, appointment_id, patient_id")
      .eq("clinic_id", cid)
      .eq("queue_date", qDate)
      .is("removed_at", null)
      .eq("status", "in_progress")
      .maybeSingle();

    if (currentData) {
      const current = currentData as { id: string; appointment_id: string; patient_id: string };

      // Complete the current appointment via the single authoritative
      // workflow. This updates the appointment status, increments the visit
      // count exactly once, marks the queue entry completed, auto-completes
      // linked follow-ups, and writes audit history — identical behaviour to
      // the dentist status-control path, and fully idempotent.
      await completeAppointmentCascade(db, {
        appointmentId: current.appointment_id,
        clinicId: cid,
        performedBy: profile.id,
      });
    }

    // Find the first waiting entry (lowest position) and promote to in_progress
    const { data: nextData } = await db
      .from("queue_entries")
      .select("id, appointment_id, called_at")
      .eq("clinic_id", cid)
      .eq("queue_date", qDate)
      .is("removed_at", null)
      .eq("status", "waiting")
      .order("position", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (nextData) {
      const next = nextData as { id: string; appointment_id: string; called_at: string | null };

      // A call-in already recorded (the dentist started this visit while another
      // patient held the chair) is kept: it is when the patient was called.
      await db
        .from("queue_entries")
        .update({ status: "in_progress", called_at: next.called_at ?? new Date().toISOString() })
        .eq("id", next.id);

      // Update appointment status to in_progress
      await db
        .from("appointments")
        .update({ status: "in_progress", updated_at: new Date().toISOString() })
        .eq("id", next.appointment_id)
        .eq("clinic_id", cid);
    }

    revalidatePath(`/${profile.role}/queue`);
    revalidatePath(`/${profile.role}/appointments`);
    revalidatePath(`/${profile.role}/follow-ups`);

    return { data: null, error: null };
  } catch (err) {
    console.error("[advanceQueue] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// skipPatient — moves entry to end of queue, recalculates positions
// =============================================================================

export async function skipPatient(
  queueEntryId: string
): Promise<ActionResult<null>> {
  try {
    if (!queueEntryId) return { data: null, error: "Queue entry ID required" };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };

    if (profile.role !== "dentist" && profile.role !== "receptionist") {
      return { data: null, error: "Forbidden" };
    }

    const cid = profile.clinic_id;
    const qDate = await todayForClinic(db, cid);

    // Verify the entry exists and belongs to this clinic
    const { data: entryData } = await db
      .from("queue_entries")
      .select("id, position, status")
      .eq("id", queueEntryId)
      .eq("clinic_id", cid)
      .eq("queue_date", qDate)
      .is("removed_at", null)
      .single();

    if (!entryData) return { data: null, error: "Queue entry not found." };

    const entry = entryData as { id: string; position: number; status: string };

    if (entry.status !== "waiting") {
      return {
        data: null,
        error: "Can only skip waiting patients.",
      };
    }

    // Get current max position
    const { data: maxData } = await db
      .from("queue_entries")
      .select("position")
      .eq("clinic_id", cid)
      .eq("queue_date", qDate)
      .is("removed_at", null)
      .eq("status", "waiting")
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();

    const maxPosition = (maxData as { position: number } | null)?.position ?? entry.position;

    if (entry.position === maxPosition) {
      // Already at the end — nothing to do
      return { data: null, error: null };
    }

    // Shift all waiting entries between (entry.position, maxPosition] down by -1,
    // then place the skipped entry at maxPosition.
    //
    // Replaced the previous per-row serial loop with a Supabase RPC that
    // performs a single UPDATE...WHERE id = ANY($1) server-side.
    const { data: toShift } = await db
      .from("queue_entries")
      .select("id, position")
      .eq("clinic_id", cid)
      .eq("queue_date", qDate)
      .is("removed_at", null)
      .eq("status", "waiting")
      .gt("position", entry.position)
      .order("position", { ascending: true });

    const shiftRows = (toShift ?? []) as { id: string; position: number }[];

    if (shiftRows.length > 0) {
      // Attempt bulk decrement via RPC (see migration 20260622000000).
      // Falls back to sequential updates if the function doesn't exist yet.
      const shiftIds = shiftRows.map((r) => r.id);
      const { error: rpcErr } = await db.rpc("bulk_decrement_queue_positions", {
        p_ids: shiftIds,
      });

      if (rpcErr) {
        // RPC not yet deployed — fall back to sequential (still correct).
        console.warn("[skipPatient] bulk_decrement_queue_positions RPC not available, falling back to sequential updates:", rpcErr.message);
        for (const row of shiftRows) {
          await db
            .from("queue_entries")
            .update({ position: row.position - 1 })
            .eq("id", row.id);
        }
      }
    }

    // Place the skipped entry at the end
    await db
      .from("queue_entries")
      .update({ position: maxPosition })
      .eq("id", queueEntryId);

    revalidatePath(`/${profile.role}/queue`);

    return { data: null, error: null };
  } catch (err) {
    console.error("[skipPatient] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getTodayQueue — full queue for today, scoped to clinic
//
// Staff (dentist + receptionist): full clinic queue for today.
// Patient (portal): receives a single-entry array containing only their own
//                   queue row (or empty if not checked in).
// Joins patient name + appointment duration for wait-time calculation
// =============================================================================

export async function getTodayQueue(): Promise<
  ActionResult<QueueEntryWithPatient[]>
> {
  try {
    // Use the request-memoised session rather than a private auth.getUser() +
    // profiles pair. This function is re-invoked on every realtime queue event
    // and again during the queue page render, so resolving the session here
    // independently meant paying for an auth round-trip and a profiles query
    // that the same request had usually already done.
    const { db, user, profile } = await resolveCachedSession();
    if (!user) return { data: null, error: "Unauthorized" };

    // Staff path
    if (profile && (profile.role === "dentist" || profile.role === "receptionist")) {
      const qDate = await todayForClinic(db, profile.clinic_id);

      const { data, error } = await db
        .from("queue_entries")
        .select(
          "*, patient:patients(id, name), appointment:appointments(duration_minutes)"
        )
        .eq("clinic_id", profile.clinic_id)
        .eq("queue_date", qDate)
        .is("removed_at", null)
        .order("position", { ascending: true });

      if (error) {
        console.error("[getTodayQueue] query error:", error);
        return { data: null, error: "Failed to fetch queue." };
      }

      const entries = (data ?? []).map(
        (row: {
          appointment: { duration_minutes: number } | null;
          [key: string]: unknown;
        }) => ({
          ...row,
          duration_minutes: row.appointment?.duration_minutes ?? 30,
        })
      );

      return { data: entries as QueueEntryWithPatient[], error: null };
    }

    // Patient portal path: return only the patient's own entry (if any)
    const link = await resolveClinicForPortalUser(db, user.id);
    if (!link) {
      // No portal link — return empty (silent, not an error)
      return { data: [], error: null };
    }

    const qDate = await todayForClinic(db, link.clinicId);
    const { data, error } = await db
      .from("queue_entries")
      .select(
        "*, patient:patients(id, name), appointment:appointments(duration_minutes)"
      )
      .eq("patient_id", link.patientId)
      .eq("queue_date", qDate)
      .is("removed_at", null)
      .order("position", { ascending: true });

    if (error) {
      console.error("[getTodayQueue patient]", error);
      return { data: null, error: "Failed to fetch queue." };
    }

    const entries = (data ?? []).map(
      (row: {
        appointment: { duration_minutes: number } | null;
        [key: string]: unknown;
      }) => ({
        ...row,
        duration_minutes: row.appointment?.duration_minutes ?? 30,
      })
    );

    return { data: entries as QueueEntryWithPatient[], error: null };
  } catch (err) {
    console.error("[getTodayQueue] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getQueueStatus — patient portal: position, patients ahead, estimated wait
//
// Always uses a service-role read for the "patients ahead" aggregation so we
// get an accurate count regardless of role-based RLS visibility. The lookup is
// strictly scoped to the patient's clinic and is read-only.
// =============================================================================

export async function getQueueStatus(patientId: string): Promise<
  ActionResult<{
    position: number | null;
    patientsAhead: number;
    estimatedWaitMinutes: number;
    currentQueueNumber: number | null;
    myStatus: string | null;
  }>
> {
  const empty = {
    position: null,
    patientsAhead: 0,
    estimatedWaitMinutes: 0,
    currentQueueNumber: null,
    myStatus: null,
  };

  try {
    if (!patientId) {
      return { data: empty, error: null };
    }

    const supabase = await createServerClient();
    const db: DbClient = supabase;

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { data: null, error: "Unauthorized" };

    // Resolve the caller's role and clinic
    const { data: profileData } = await db
      .from("profiles")
      .select("id, clinic_id, role")
      .eq("id", user.id)
      .maybeSingle();

    const profile = profileData as ResolvedProfile | null;

    let clinicId: string | null = null;
    let isPortalSelf = false;

    if (profile && (profile.role === "dentist" || profile.role === "receptionist")) {
      clinicId = profile.clinic_id;
    } else {
      // Portal path — verify the caller owns this patient_id
      const link = await resolveClinicForPortalUser(db, user.id);
      if (!link) return { data: empty, error: null };
      if (link.patientId !== patientId) {
        return { data: null, error: "Forbidden" };
      }
      clinicId = link.clinicId;
      isPortalSelf = true;
    }

    if (!clinicId) return { data: empty, error: null };

    // Use the service-role client for queue aggregation. RLS would otherwise
    // hide other patients' rows from a portal user, breaking the count.
    const service = getServiceClient();
    const qDate = getTodayInTimezone(await getClinicTimezone(db, clinicId));

    // Find this patient's queue entry for today
    const { data: myEntryData } = await service
      .from("queue_entries")
      .select("id, position, status")
      .eq("clinic_id", clinicId)
      .eq("patient_id", patientId)
      .eq("queue_date", qDate)
      .is("removed_at", null)
      .maybeSingle();

    if (!myEntryData) {
      // Not in the queue yet
      const { data: currentData } = await service
        .from("queue_entries")
        .select("position")
        .eq("clinic_id", clinicId)
        .eq("queue_date", qDate)
        .is("removed_at", null)
        .eq("status", "in_progress")
        .maybeSingle();

      return {
        data: {
          ...empty,
          currentQueueNumber:
            (currentData as { position: number } | null)?.position ?? null,
        },
        error: null,
      };
    }

    const myEntry = myEntryData as {
      id: string;
      position: number;
      status: string;
    };

    // If the patient's queue entry is completed, they are no longer in the
    // active queue. Return empty status so the portal does not show queue UI.
    if (myEntry.status === "completed") {
      const { data: currentData } = await service
        .from("queue_entries")
        .select("position")
        .eq("clinic_id", clinicId)
        .eq("queue_date", qDate)
        .is("removed_at", null)
        .eq("status", "in_progress")
        .maybeSingle();

      return {
        data: {
          ...empty,
          currentQueueNumber:
            (currentData as { position: number } | null)?.position ?? null,
        },
        error: null,
      };
    }

    // Count waiting entries with lower position than the patient's
    const { data: aheadEntries } = await service
      .from("queue_entries")
      .select("id, position, appointments(duration_minutes)")
      .eq("clinic_id", clinicId)
      .eq("queue_date", qDate)
      .is("removed_at", null)
      .eq("status", "waiting")
      .lt("position", myEntry.position);

    const ahead = (aheadEntries ?? []) as Array<{
      position: number;
      appointments:
        | { duration_minutes: number }
        | { duration_minutes: number }[]
        | null;
    }>;

    const patientsAhead = ahead.length;

    // Compute estimated wait — sum of appointment durations for entries ahead.
    // Fallback to clinic average if a specific duration is missing.
    let estimatedWaitMinutes = 0;
    if (ahead.length > 0) {
      estimatedWaitMinutes = ahead.reduce((sum, e) => {
        const dur = Array.isArray(e.appointments)
          ? e.appointments[0]?.duration_minutes
          : e.appointments?.duration_minutes;
        return sum + (dur ?? 30);
      }, 0);
    }

    if (patientsAhead > 0) {
      const { data: settingsData } = await service
        .from("clinic_settings")
        .select("average_appointment_duration, chair_count")
        .eq("clinic_id", clinicId)
        .maybeSingle();
      const settings = settingsData as
        | { average_appointment_duration?: number; chair_count?: number }
        | null;

      if (estimatedWaitMinutes === 0) {
        estimatedWaitMinutes = patientsAhead * (settings?.average_appointment_duration ?? 30);
      }

      // A clinic with N active chairs treats N patients in parallel, so the
      // work ahead is shared across chairs, not served serially on one
      // (audit B3) — the same "N chairs ⇒ N× throughput" convention
      // lib/business-brain/metrics-repository.ts already applies to capacity
      // (openMinutes × chairCount). Math.ceil, not floor: a partial chair-share
      // of remaining work still costs the full remaining time on whichever
      // chair frees up last, so rounding down would under-promise accuracy.
      const chairCount = Math.max(1, settings?.chair_count ?? 1);
      estimatedWaitMinutes = Math.ceil(estimatedWaitMinutes / chairCount);
    }

    // Find current in_progress entry number
    const { data: currentData } = await service
      .from("queue_entries")
      .select("position")
      .eq("clinic_id", clinicId)
      .eq("queue_date", qDate)
      .is("removed_at", null)
      .eq("status", "in_progress")
      .maybeSingle();

    const currentQueueNumber =
      (currentData as { position: number } | null)?.position ?? null;

    void isPortalSelf;

    return {
      data: {
        position: myEntry.position,
        patientsAhead,
        estimatedWaitMinutes,
        currentQueueNumber,
        myStatus: myEntry.status,
      },
      error: null,
    };
  } catch (err) {
    console.error("[getQueueStatus] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

// =============================================================================
// getQueueMetrics — today's stats for dashboard header
// =============================================================================

export async function getQueueMetrics(): Promise<
  ActionResult<{
    totalToday: number;
    checkedInToday: number;
    waitingNow: number;
    completedToday: number;
    inProgressNow: number;
    avgWaitMinutes: number;
    /** Active chairs — the staff queue board's per-row wait estimate divides
     * accumulated duration by this (audit B3), matching the server's own
     * getQueueStatus and the capacity convention in metrics-repository.ts. */
    chairCount: number;
  }>
> {
  try {
    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };

    if (profile.role === "patient") {
      return { data: null, error: "Forbidden" };
    }

    const cid = profile.clinic_id;
    const qDate = await todayForClinic(db, cid);

    const [{ data: entries }, { data: settingsData }] = await Promise.all([
      db
        .from("queue_entries")
        .select("status, checked_in_at, called_at, appointment:appointments(duration_minutes)")
        .eq("clinic_id", cid)
        .eq("queue_date", qDate)
        .is("removed_at", null),
      db.from("clinic_settings").select("chair_count").eq("clinic_id", cid).maybeSingle(),
    ]);
    const chairCount = Math.max(1, (settingsData as { chair_count?: number } | null)?.chair_count ?? 1);

    const rows = (entries ?? []) as {
      status: string;
      checked_in_at: string;
      called_at: string | null;
      appointment: { duration_minutes: number } | null;
    }[];

    const waiting = rows.filter((r) => r.status === "waiting");
    const inProgress = rows.filter((r) => r.status === "in_progress");
    const completed = rows.filter((r) => r.status === "completed");

    // Average wait = average of (called_at - checked_in_at) for completed/in_progress
    const withWaitTimes = [...completed, ...inProgress].filter(
      (r) => r.called_at
    );
    const avgWaitMinutes =
      withWaitTimes.length > 0
        ? Math.round(
            withWaitTimes.reduce((sum, r) => {
              const wait =
                (new Date(r.called_at!).getTime() -
                  new Date(r.checked_in_at).getTime()) /
                60000;
              return sum + wait;
            }, 0) / withWaitTimes.length
          )
        : 0;

    return {
      data: {
        totalToday: rows.length,
        checkedInToday: rows.length, // all queue entries represent checked-in patients
        waitingNow: waiting.length,
        completedToday: completed.length,
        inProgressNow: inProgress.length,
        avgWaitMinutes,
        chairCount,
      },
      error: null,
    };
  } catch (err) {
    console.error("[getQueueMetrics] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}
