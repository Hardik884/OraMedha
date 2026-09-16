/**
 * lib/queue/call-in.ts
 *
 * Recording that a patient was called in, when a visit is started from the
 * appointment list rather than from the queue board.
 *
 * Starting a visit is the same event as calling the patient in, and it used to
 * leave the queue row "waiting" with no call-in time, so waiting figures counted
 * a patient in the chair as still waiting. The rules:
 *
 *   - only a queue row that exists is touched. A patient nobody checked in has
 *     no row, and none is invented — the arrival was not recorded;
 *   - a call-in already recorded is never overwritten;
 *   - the row becomes in_progress unless another live entry already is (the
 *     queue allows one per clinic per day); the call-in time is recorded either
 *     way, because it happened.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = any;

export interface CallInResult {
  /** Whether a live queue row existed for the appointment. */
  readonly found: boolean;
  /** Whether the row was promoted to in_progress. */
  readonly promoted: boolean;
  /** The call-in time the row carries afterwards, or null when no row exists. */
  readonly calledAt: string | null;
  readonly error: string | null;
}

export async function recordCallIn(
  db: DbClient,
  clinicId: string,
  appointmentId: string,
  now: string,
): Promise<CallInResult> {
  const { data: entry, error: readError } = await db
    .from("queue_entries")
    .select("id, queue_date, status, called_at")
    .eq("appointment_id", appointmentId)
    .eq("clinic_id", clinicId)
    .is("removed_at", null)
    .in("status", ["waiting", "in_progress"])
    .maybeSingle();
  if (readError) return { found: false, promoted: false, calledAt: null, error: readError.message };
  const row = entry as { id: string; queue_date: string; status: string; called_at: string | null } | null;
  if (!row) return { found: false, promoted: false, calledAt: null, error: null };

  const calledAt = row.called_at ?? now;
  let promote = row.status === "waiting";
  if (promote) {
    const { data: busy, error: busyError } = await db
      .from("queue_entries")
      .select("id")
      .eq("clinic_id", clinicId)
      .eq("queue_date", row.queue_date)
      .eq("status", "in_progress")
      .is("removed_at", null)
      .neq("id", row.id)
      .limit(1);
    if (busyError) return { found: true, promoted: false, calledAt: row.called_at, error: busyError.message };
    promote = (busy ?? []).length === 0;
  }
  if (!promote && row.called_at !== null) {
    return { found: true, promoted: false, calledAt: row.called_at, error: null };
  }
  const { error } = await db
    .from("queue_entries")
    .update(promote ? { status: "in_progress", called_at: calledAt } : { called_at: calledAt })
    .eq("id", row.id)
    .eq("clinic_id", clinicId);
  if (error) return { found: true, promoted: false, calledAt: row.called_at, error: error.message };
  return { found: true, promoted: promote, calledAt, error: null };
}
