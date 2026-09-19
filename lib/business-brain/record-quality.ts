/**
 * lib/business-brain/record-quality.ts
 *
 * How completely this clinic recorded the last thirty days.
 *
 * The rules are in `business-brain/ledger/record-quality.ts`; this is the read.
 * It exists because every "we could not tell you" the briefing prints has a
 * cause, and the cause is almost always a button nobody pressed:
 *
 *   no check-in       -> the visit has no arrival, so lateness and waits are gone
 *   no call-in        -> the wait has one end, and is UNMEASURED rather than zero
 *   no outcome        -> the visit is neither attended nor missed, only stale
 *   no performed date -> a completed treatment is dated by when it was typed
 *   no-show inferred  -> the nightly job's reading, not an observation anyone made
 *
 * None of that is visible anywhere in OraMedha today. A clinic that clicks
 * "Mark as Complete" all day gets a briefing that quietly says less each week
 * and never says why.
 *
 * ## Reads, with the caller's own session
 *
 * Same discipline as the rest of this directory: the request's Supabase client,
 * so RLS applies and the page cannot see further than the dentist can. A read
 * that fails leaves its check UNKNOWN rather than zero — see `RecordCheckCount`.
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  assessRecordQuality,
  isClickedThroughVisit,
  noShowBasis,
  splitNoShowBasis,
  RecordCheck,
  type NoShowBasisSplit,
  type RecordCheckCount,
  type RecordQuality,
} from "@/business-brain";
import type { Database } from "@/types/database.types";
import { getUtcBoundariesForLocalDate } from "@/lib/utils";
// The module's own calendar helper, so a window here starts on the same day a
// metric window does.
import { addDays } from "@/business-brain";
import { readAll } from "./paged-read";

/** Days looked at, matching the trailing window every 30-day metric describes. */
const WINDOW_DAYS = 30;

/** Most rows one read may return. A month of appointments at a large clinic. */
const MAX_ROWS = 20_000;

/** Ids per `in (...)` filter. Longer URLs are refused by PostgREST. */
const ID_CHUNK = 100;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Statuses that mean the patient was there — the visits an arrival belongs to. */
const ATTENDED = new Set(["completed", "checked_in", "in_progress"]);

/** Statuses that say how the visit ended. Anything else after its day is unresolved. */
const RESOLVED = new Set(["completed", "cancelled", "no_show"]);

export interface ClinicRecordQuality extends RecordQuality {
  /** The window read, inclusive. */
  readonly from: string;
  readonly to: string;
  /**
   * How the window's no-shows were established.
   *
   * Reported separately as well as inside the checks, because a no-show rate
   * that mixes the two without saying so implies an observation nobody made.
   */
  readonly noShows: NoShowBasisSplit;
}

/**
 * Count the last thirty days' recording gaps for one clinic.
 *
 * Returns null only when the appointment read itself fails — at that point
 * nothing can be said, and saying nothing is the honest answer. A failure in one
 * of the later reads leaves that check unknown and the rest intact.
 */
export async function readRecordQuality(
  db: SupabaseClient<Database>,
  clinicId: string,
  date: string,
  timezone: string,
): Promise<ClinicRecordQuality | null> {
  const from = addDays(date, -(WINDOW_DAYS - 1));
  const start = getUtcBoundariesForLocalDate(from, timezone).start;
  const end = getUtcBoundariesForLocalDate(date, timezone).end;

  interface AppointmentRow {
    id: string;
    status: string;
    scheduled_at: string;
  }

  let appointments: AppointmentRow[];
  try {
    appointments = await readAll<AppointmentRow>(
      "record quality (appointments)",
      (a, b) =>
        db
          .from("appointments")
          .select("id, status, scheduled_at")
          .eq("clinic_id", clinicId)
          .is("deleted_at", null)
          .gte("scheduled_at", start)
          .lte("scheduled_at", end)
          .order("scheduled_at", { ascending: true })
          .order("id", { ascending: true })
          .range(a, b),
      MAX_ROWS,
    );
  } catch {
    return null;
  }

  // Yesterday and earlier: today's visits are still in progress, and a visit
  // that has not ended cannot be missing its outcome.
  const endedBefore = getUtcBoundariesForLocalDate(date, timezone).start;
  const finished = appointments.filter((a) => a.scheduled_at < endedBefore);
  const attended = appointments.filter((a) => ATTENDED.has(a.status));
  const missed = appointments.filter((a) => a.status === "no_show");

  const [queue, marks] = await Promise.all([
    readQueue(db, clinicId, attended.map((a) => a.id)),
    readNoShowMarks(db, clinicId, missed.map((a) => a.id)),
  ]);

  // ── Arrivals, and the call-ins that give a wait its second end ─────────────
  let arrivalsRecorded: number | null = null;
  let callInsRecorded: number | null = null;
  let callInTotal = 0;
  if (queue !== null) {
    arrivalsRecorded = 0;
    callInsRecorded = 0;
    for (const appointment of attended) {
      const entry = queue.get(appointment.id);
      // A visit clicked through to completion within a minute of its "check-in",
      // never called in, records no arrival: that timestamp is a button press.
      const arrived =
        entry !== undefined &&
        !isClickedThroughVisit({
          checkedInAt: entry.checked_in_at,
          calledAt: entry.called_at,
          completedAt: entry.completed_at,
        });
      if (!arrived) continue;
      arrivalsRecorded += 1;
      // Only a visit with a recorded arrival could have had a call-in recorded,
      // so it is the denominator: judging call-ins against visits that were
      // never checked in would count the same missing check-in twice.
      callInTotal += 1;
      if (entry?.called_at !== null) callInsRecorded += 1;
    }
  }

  // ── Treatments completed in the window, and whether they carry their date ──
  const treatmentDates = await readTreatmentDates(db, clinicId, start, end);

  // ── No-shows: a person's mark, or the nightly job's inference ──────────────
  const bases =
    marks === null
      ? null
      : missed.map((a) => noShowBasis(marks.get(a.id) ?? []));
  const noShows = splitNoShowBasis(bases ?? []);

  const counts: RecordCheckCount[] = [
    { check: RecordCheck.ARRIVALS, recorded: arrivalsRecorded, total: attended.length },
    { check: RecordCheck.CALL_INS, recorded: callInsRecorded, total: callInTotal },
    {
      check: RecordCheck.VISIT_OUTCOMES,
      recorded: finished.filter((a) => RESOLVED.has(a.status)).length,
      total: finished.length,
    },
    {
      check: RecordCheck.TREATMENT_DATES,
      recorded: treatmentDates?.dated ?? null,
      total: treatmentDates?.total ?? 0,
    },
    {
      check: RecordCheck.NO_SHOW_MARKS,
      recorded: bases === null ? null : noShows.recorded,
      total: missed.length,
    },
  ];

  return { ...assessRecordQuality(counts), from, to: date, noShows };
}

interface QueueRow {
  appointment_id: string;
  checked_in_at: string;
  called_at: string | null;
  completed_at: string | null;
}

/** First queue entry per appointment: a re-queued patient arrived when they first arrived. */
async function readQueue(
  db: SupabaseClient<Database>,
  clinicId: string,
  ids: readonly string[],
): Promise<Map<string, QueueRow> | null> {
  if (ids.length === 0) return new Map();
  try {
    const rows: QueueRow[] = [];
    for (const chunk of chunks(ids, ID_CHUNK)) {
      rows.push(
        ...(await readAll<QueueRow>(
          "record quality (queue)",
          (a, b) =>
            db
              .from("queue_entries")
              .select("appointment_id, checked_in_at, called_at, completed_at")
              .eq("clinic_id", clinicId)
              .in("appointment_id", chunk)
              .order("checked_in_at", { ascending: true })
              .order("id", { ascending: true })
              .range(a, b),
          MAX_ROWS,
        )),
      );
    }
    const first = new Map<string, QueueRow>();
    for (const row of rows) if (!first.has(row.appointment_id)) first.set(row.appointment_id, row);
    return first;
  } catch {
    return null;
  }
}

interface HistoryRow {
  appointment_id: string;
  new_value: unknown;
  timestamp: string;
  performed_by: string | null;
}

/** Every recorded status change per missed appointment, for the basis rule. */
async function readNoShowMarks(
  db: SupabaseClient<Database>,
  clinicId: string,
  ids: readonly string[],
): Promise<Map<string, { statusAfter: string | null; at: string; byPerson: boolean | null }[]> | null> {
  if (ids.length === 0) return new Map();
  try {
    const rows: HistoryRow[] = [];
    for (const chunk of chunks(ids, ID_CHUNK)) {
      rows.push(
        ...(await readAll<HistoryRow>(
          "record quality (appointment history)",
          (a, b) =>
            db
              .from("appointment_history")
              .select("appointment_id, new_value, timestamp, performed_by")
              .in("appointment_id", chunk)
              .order("timestamp", { ascending: true })
              .order("id", { ascending: true })
              .range(a, b),
          MAX_ROWS,
        )),
      );
    }
    const byAppointment = new Map<
      string,
      { statusAfter: string | null; at: string; byPerson: boolean | null }[]
    >();
    for (const row of rows) {
      const status = (row.new_value as { status?: string } | null)?.status ?? null;
      const list = byAppointment.get(row.appointment_id) ?? [];
      // No actor is the nightly job's signature: it runs as the service role and
      // stamps no profile. A person's change always carries one.
      list.push({ statusAfter: status, at: row.timestamp, byPerson: row.performed_by !== null });
      byAppointment.set(row.appointment_id, list);
    }
    return byAppointment;
  } catch {
    return null;
  }
}

/** Treatments completed in the window, and how many say when they were performed. */
async function readTreatmentDates(
  db: SupabaseClient<Database>,
  clinicId: string,
  start: string,
  end: string,
): Promise<{ dated: number; total: number } | null> {
  try {
    // Dated by performed_at where it exists and by the recorded completion where
    // it does not, so the window catches both — a treatment completed in the
    // window with no performed_at is precisely what this check counts.
    const rows = await readAll<{ performed_at: string | null; updated_at: string }>(
      "record quality (treatments)",
      (a, b) =>
        db
          .from("treatments")
          .select("performed_at, updated_at")
          .eq("clinic_id", clinicId)
          .eq("status", "completed")
          .is("deleted_at", null)
          .or(`and(performed_at.gte.${start},performed_at.lte.${end}),and(performed_at.is.null,updated_at.gte.${start},updated_at.lte.${end})`)
          .order("updated_at", { ascending: true })
          .range(a, b),
      MAX_ROWS,
    );
    return { dated: rows.filter((r) => r.performed_at !== null).length, total: rows.length };
  } catch {
    return null;
  }
}
