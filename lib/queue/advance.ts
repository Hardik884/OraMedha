/**
 * lib/queue/advance.ts
 *
 * "Mark Done & Call Next", made safe against a queue that has drifted out of step
 * with the appointments it points at. The queue must ALWAYS advance: a chair
 * entry that cannot be closed blocks the next patient behind the
 * one-in-progress-per-day index, and the front desk has no other way round it.
 *
 * Drift this handles, and what each is read as — never inventing an event:
 *
 *   appointment still `scheduled`      the queue entry IS the recorded check-in, so
 *                                      the appointment is moved to `checked_in`
 *                                      first, then completed as normal
 *   appointment already `completed`    the entry is closed as completed with no
 *                                      `completed_at`: when the visit ended was not
 *                                      recorded here, and none is made up
 *   appointment cancelled / missed /   the entry is taken off the live queue
 *     deleted / gone                   (`removed_at`), never marked completed
 *   the completion could not be saved, the entry is still closed, with no invented
 *   or the queue could not record it   end time; an unsaved appointment is left
 *                                      for someone to resolve
 *
 * The next waiting entry is promoted the same way: a `scheduled` appointment is
 * checked in first, and an entry whose appointment is closed or gone is taken
 * off the queue and the one behind it is called instead.
 */

import { completeAppointmentCascade } from "@/lib/appointments/complete";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = any;

const CLOSED = new Set(["cancelled", "no_show"]);

interface AppointmentState {
  readonly status: string;
  readonly deleted: boolean;
}

async function appointmentState(db: DbClient, clinicId: string, appointmentId: string): Promise<AppointmentState | null> {
  const { data } = await db
    .from("appointments")
    .select("status, deleted_at")
    .eq("id", appointmentId)
    .eq("clinic_id", clinicId)
    .maybeSingle();
  const row = data as { status: string; deleted_at: string | null } | null;
  return row === null ? null : { status: row.status, deleted: row.deleted_at !== null };
}

/** An appointment whose queue entry exists but whose check-in was never saved: record it. */
async function recordCheckIn(db: DbClient, clinicId: string, appointmentId: string, now: string): Promise<void> {
  await db
    .from("appointments")
    .update({ status: "checked_in", updated_at: now })
    .eq("id", appointmentId)
    .eq("clinic_id", clinicId)
    .eq("status", "scheduled");
}

async function removeFromLiveQueue(db: DbClient, clinicId: string, entryId: string, now: string): Promise<void> {
  await db
    .from("queue_entries")
    .update({ removed_at: now })
    .eq("id", entryId)
    .eq("clinic_id", clinicId)
    .is("removed_at", null);
}

export type ChairOutcome = "completed" | "already_completed" | "removed" | "closed_unresolved";

/** Close the patient in the chair, whatever state their appointment is in. */
export async function closeChair(
  db: DbClient,
  params: { clinicId: string; entryId: string; appointmentId: string; performedBy: string; now: string },
): Promise<ChairOutcome> {
  const { clinicId, entryId, appointmentId, performedBy, now } = params;

  const before = await appointmentState(db, clinicId, appointmentId);
  if (before === null || before.deleted || CLOSED.has(before.status)) {
    await removeFromLiveQueue(db, clinicId, entryId, now);
    return "removed";
  }
  if (before.status === "scheduled") await recordCheckIn(db, clinicId, appointmentId, now);

  const result = await completeAppointmentCascade(db, { appointmentId, clinicId, performedBy });

  const after = await appointmentState(db, clinicId, appointmentId);
  if (after === null || after.deleted || CLOSED.has(after.status)) {
    await removeFromLiveQueue(db, clinicId, entryId, now);
    return "removed";
  }

  // Whatever happened above, the chair is closed now. The cascade stamps
  // completed_at when it can; if its queue update did not land (the visit was
  // completed earlier, or the recorded times cannot hold a completion now), the
  // entry is closed with no end time rather than an invented one.
  await db
    .from("queue_entries")
    .update({ status: "completed" })
    .eq("id", entryId)
    .eq("clinic_id", clinicId)
    .is("removed_at", null)
    .in("status", ["waiting", "in_progress"]);

  if (result.completed) return "completed";
  if (after.status === "completed") return "already_completed";
  console.error("[closeChair] appointment could not be completed; queue entry closed anyway", { appointmentId, status: after.status });
  return "closed_unresolved";
}

/** Call the next patient: the first waiting entry whose appointment can still be seen. */
export async function callNext(
  db: DbClient,
  params: { clinicId: string; queueDate: string; now: string; maxSkips?: number },
): Promise<string | null> {
  const { clinicId, queueDate, now } = params;
  const maxSkips = params.maxSkips ?? 50;

  for (let i = 0; i <= maxSkips; i += 1) {
    const { data } = await db
      .from("queue_entries")
      .select("id, appointment_id, called_at")
      .eq("clinic_id", clinicId)
      .eq("queue_date", queueDate)
      .is("removed_at", null)
      .eq("status", "waiting")
      .order("position", { ascending: true })
      .limit(1)
      .maybeSingle();
    const next = data as { id: string; appointment_id: string; called_at: string | null } | null;
    if (next === null) return null;

    const state = await appointmentState(db, clinicId, next.appointment_id);
    if (state === null || state.deleted || CLOSED.has(state.status) || state.status === "completed") {
      // Nothing left to call this patient in for.
      await removeFromLiveQueue(db, clinicId, next.id, now);
      continue;
    }

    // A call-in already recorded (the dentist started this visit while another
    // patient held the chair) is kept: it is when the patient was called.
    await db
      .from("queue_entries")
      .update({ status: "in_progress", called_at: next.called_at ?? now })
      .eq("id", next.id)
      .eq("clinic_id", clinicId);

    if (state.status === "scheduled") await recordCheckIn(db, clinicId, next.appointment_id, now);
    await db
      .from("appointments")
      .update({ status: "in_progress", updated_at: now })
      .eq("id", next.appointment_id)
      .eq("clinic_id", clinicId)
      .eq("status", "checked_in");
    return next.id;
  }
  return null;
}
