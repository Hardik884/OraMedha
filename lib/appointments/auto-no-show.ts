/**
 * lib/appointments/auto-no-show.ts
 *
 * Automatic no-show detection — the single authoritative implementation.
 *
 * Business rule: once an appointment's own calendar day has fully ended in
 * the CLINIC'S timezone, an appointment still sitting in `scheduled` (the
 * patient never arrived — nothing ever checked them in) is marked `no_show`.
 *
 * Deliberately NOT flipped, because each is evidence the patient was actually
 * seen or the slot was otherwise resolved by a human:
 *   - completed     — the visit happened.
 *   - checked_in    — the patient arrived; a receptionist should resolve this.
 *   - in_progress   — currently being seen.
 *   - cancelled     — already a terminal state, resolved before the visit.
 * `rescheduled` is not a distinct status in this schema (see
 * AppointmentStatus) — a reschedule updates `scheduled_at` in place, so a
 * rescheduled appointment is simply `scheduled` at its NEW time and is
 * correctly re-evaluated against that new time, not its old one.
 *
 * Timezone handling: "the day has ended" is evaluated per clinic, in that
 * clinic's own configured timezone, not the server's. The cutoff is the UTC
 * instant of local midnight AT THE START OF TODAY (clinic-local) — i.e.
 * everything strictly before today, in that clinic's own calendar, is over.
 * An appointment scheduled earlier TODAY that simply hasn't happened yet is
 * deliberately left alone until its own day ends; the rule is "end of the
 * appointment day", not "the appointment time has passed".
 */

import { writeAppointmentHistory } from "@/lib/appointments/history";
import { getTodayInTimezone, getUtcBoundariesForLocalDate } from "@/lib/utils";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = any;

export type AutoNoShowResult = {
  clinicId: string;
  /** UTC instant of local midnight today for this clinic — the cutoff used. */
  boundary: string;
  /** Appointment ids transitioned to no_show by this call. */
  transitionedIds: string[];
};

export async function autoMarkNoShowForClinic(
  db: DbClient,
  params: { clinicId: string; timezone: string }
): Promise<AutoNoShowResult> {
  const { clinicId, timezone } = params;
  const boundary = getUtcBoundariesForLocalDate(getTodayInTimezone(timezone), timezone).start;
  const now = new Date().toISOString();

  // Conditional UPDATE, scoped to exactly the safe transition
  // (scheduled + strictly before today, clinic-local). Re-running this job
  // within the same hour, or across overlapping cron invocations, re-selects
  // nothing the second time — the WHERE clause is the idempotency guard,
  // there is no separate "already processed" flag to keep in sync.
  const { data: rows, error } = await db
    .from("appointments")
    .update({ status: "no_show", updated_at: now })
    .eq("clinic_id", clinicId)
    .eq("status", "scheduled")
    .lt("scheduled_at", boundary)
    .is("deleted_at", null)
    .select("id");

  if (error) {
    console.error("[autoMarkNoShowForClinic]", { clinicId, error });
    throw new Error(error.message);
  }

  const transitionedIds = ((rows ?? []) as { id: string }[]).map((r) => r.id);

  for (const appointmentId of transitionedIds) {
    await writeAppointmentHistory({
      appointmentId,
      action: "status_changed",
      oldValue: { status: "scheduled" },
      newValue: { status: "no_show" },
      // System-triggered, not a person acting — performedBy is explicitly
      // null rather than attributing the change to whichever profile happens
      // to run the cron.
      performedBy: null,
    });
  }

  // Defensive only: a `scheduled` appointment should never have an open queue
  // entry (check-in is what creates one, and it moves status off `scheduled`
  // in the same action), so this is expected to be a no-op in practice. It
  // exists so a no-show is never left showing as waiting/in_progress on a
  // live queue board if that invariant is ever violated some other way. The
  // entry is removed from the live queue, never marked completed: nothing was
  // completed, and a completion stamp here would be an invented visit end.
  if (transitionedIds.length > 0) {
    await db
      .from("queue_entries")
      .update({ removed_at: now })
      .eq("clinic_id", clinicId)
      .in("appointment_id", transitionedIds)
      .is("removed_at", null)
      .in("status", ["waiting", "in_progress"]);
  }

  return { clinicId, boundary, transitionedIds };
}
