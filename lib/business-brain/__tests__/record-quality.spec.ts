/**
 * Integration spec for the record-quality read.
 *
 * Runs against the LOCAL Supabase stack and skips, loudly, when it is not
 * reachable — same contract as the sibling adapters.
 *
 * What is worth proving here is the arithmetic of absence, because every count
 * in this file is a count of something that is NOT in the database:
 *
 *   - a visit clicked through to completion within a minute of its "check-in"
 *     has no recorded arrival, even though a queue row exists
 *   - a wait with only one end is not a short wait
 *   - a no-show the nightly job inferred (no actor) is not one a person marked
 *   - a completed treatment with no performed_at is still counted, and counted
 *     as missing its date rather than dropped out of the window
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/types/database.types";
import { RecordCheck } from "@/business-brain";
import { readRecordQuality } from "../record-quality";

const URL = process.env.SUPABASE_TEST_URL ?? "http://127.0.0.1:55321";
const KEY =
  process.env.SUPABASE_TEST_SERVICE_KEY ??
  // Standard local-development service key — published in Supabase's own docs.
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${URL}/rest/v1/`, {
      headers: { apikey: KEY },
      signal: AbortSignal.timeout(2500),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}
const LOCAL_UP = await reachable();
if (!LOCAL_UP) {
  console.warn(
    `\n[record-quality] SKIPPED — local Supabase not reachable at ${URL}.` +
      `\n                 Start it with: npm run db:start\n`,
  );
}

const C = "9fd00000-0000-4000-8000-000000000001";
const D = "9fd00000-0000-4000-8000-000000000010";
const P = "9fd00000-0000-4000-8000-000000000020";

/** "Today" for the read. Every fixture sits inside the trailing 30 days. */
const TODAY = "2026-04-20";
const TZ = "Asia/Kolkata";

const db: SupabaseClient<Database> = createClient<Database>(URL, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
/* eslint-disable @typescript-eslint/no-explicit-any */
const raw = db as any;

async function insert(table: string, values: unknown) {
  const { error } = await raw.from(table).insert(values);
  if (error) throw new Error(`seed ${table}: ${error.message}`);
}

async function cleanup() {
  await raw.from("clinics").delete().eq("id", C);
  await raw.auth.admin.deleteUser(D).catch(() => undefined);
}

const A_ARRIVED = "9fd00000-0000-4000-8000-000000000101"; // check-in and call-in
const A_NO_CALL_IN = "9fd00000-0000-4000-8000-000000000102"; // check-in, never called
const A_CLICKED_THROUGH = "9fd00000-0000-4000-8000-000000000103"; // completed in 30s, no call-in
const A_NO_QUEUE = "9fd00000-0000-4000-8000-000000000104"; // completed, never queued
const A_LEFT_OPEN = "9fd00000-0000-4000-8000-000000000105"; // still checked in, days later
const A_NO_SHOW_MARKED = "9fd00000-0000-4000-8000-000000000106"; // a person marked it
const A_NO_SHOW_INFERRED = "9fd00000-0000-4000-8000-000000000107"; // the nightly job did

const T_DATED = "9fd00000-0000-4000-8000-000000000201";
const T_UNDATED = "9fd00000-0000-4000-8000-000000000202";

async function seed() {
  await cleanup();
  const { error } = await raw.auth.admin.createUser({
    id: D,
    email: "bb-record-quality@test.local",
    password: "password123",
    email_confirm: true,
  });
  if (error && !/already/i.test(error.message)) throw new Error(`seed user: ${error.message}`);

  await insert("clinics", { id: C, name: "Recording Clinic" });
  await insert("clinic_settings", {
    clinic_id: C,
    clinic_name: "Recording Clinic",
    timezone: TZ,
    average_appointment_duration: 30,
  });
  await insert("profiles", { id: D, clinic_id: C, full_name: "RQ Dentist", role: "dentist" });
  await insert("patients", [
    { id: P, clinic_id: C, name: "Patient", created_at: "2026-01-01T00:00:00Z" },
  ]);

  const appt = (id: string, scheduled: string, status: string) => ({
    id,
    clinic_id: C,
    patient_id: P,
    dentist_id: D,
    scheduled_at: scheduled,
    source: "walk_in",
    status,
  });

  await insert("appointments", [
    appt(A_ARRIVED, "2026-04-10T04:00:00Z", "completed"),
    appt(A_NO_CALL_IN, "2026-04-11T04:00:00Z", "completed"),
    appt(A_CLICKED_THROUGH, "2026-04-12T04:00:00Z", "completed"),
    appt(A_NO_QUEUE, "2026-04-13T04:00:00Z", "completed"),
    appt(A_LEFT_OPEN, "2026-04-14T04:00:00Z", "checked_in"),
    appt(A_NO_SHOW_MARKED, "2026-04-15T04:00:00Z", "no_show"),
    appt(A_NO_SHOW_INFERRED, "2026-04-16T04:00:00Z", "no_show"),
  ]);

  const queue = (
    id: string,
    appointment: string,
    checkedIn: string,
    calledAt: string | null,
    completedAt: string | null,
  ) => ({
    id,
    clinic_id: C,
    appointment_id: appointment,
    patient_id: P,
    position: 1,
    status: completedAt === null ? "waiting" : "completed",
    checked_in_at: checkedIn,
    called_at: calledAt,
    completed_at: completedAt,
  });

  await insert("queue_entries", [
    queue(
      "9fd00000-0000-4000-8000-000000000301",
      A_ARRIVED,
      "2026-04-10T03:50:00Z",
      "2026-04-10T04:05:00Z",
      "2026-04-10T04:35:00Z",
    ),
    // Arrived, never called in: the wait has one end.
    queue(
      "9fd00000-0000-4000-8000-000000000302",
      A_NO_CALL_IN,
      "2026-04-11T03:50:00Z",
      null,
      "2026-04-11T04:40:00Z",
    ),
    // "Checked in" and completed thirty seconds later, never called: a button
    // press, not an arrival.
    queue(
      "9fd00000-0000-4000-8000-000000000303",
      A_CLICKED_THROUGH,
      "2026-04-12T04:30:00Z",
      null,
      "2026-04-12T04:30:30Z",
    ),
    queue(
      "9fd00000-0000-4000-8000-000000000304",
      A_LEFT_OPEN,
      "2026-04-14T03:50:00Z",
      "2026-04-14T04:10:00Z",
      null,
    ),
  ]);

  await insert("appointment_history", [
    // A person marked this one.
    {
      appointment_id: A_NO_SHOW_MARKED,
      action: "status_changed",
      new_value: { status: "no_show" },
      performed_by: D,
      timestamp: "2026-04-15T06:00:00Z",
    },
    // The nightly job marked this one: no actor.
    {
      appointment_id: A_NO_SHOW_INFERRED,
      action: "status_changed",
      new_value: { status: "no_show" },
      performed_by: null,
      timestamp: "2026-04-17T00:05:00Z",
    },
  ]);

  await insert("treatments", [
    {
      id: T_DATED,
      clinic_id: C,
      patient_id: P,
      appointment_id: A_ARRIVED,
      treatment_type: "Cleaning",
      cost: 1000,
      status: "completed",
      performed_at: "2026-04-10T04:30:00Z",
      // Stated on both rows: a multi-row insert takes its columns from the first,
      // so an omission here would arrive as a null rather than the default.
      updated_at: "2026-04-10T05:00:00Z",
    },
    {
      id: T_UNDATED,
      clinic_id: C,
      patient_id: P,
      appointment_id: A_NO_QUEUE,
      treatment_type: "Filling",
      cost: 2000,
      status: "completed",
      performed_at: null,
      updated_at: "2026-04-13T10:00:00Z",
    },
  ]);
}

describe.skipIf(!LOCAL_UP)("record quality (integration)", () => {
  beforeAll(seed, 60_000);
  afterAll(cleanup);

  it("counts the recording gaps behind every figure the briefing withholds", async () => {
    const quality = await readRecordQuality(db, C, TODAY, TZ);
    const by = new Map(quality?.checks.map((c) => [c.check, c]));

    // Five visits where the patient was there: four completed and one still
    // checked in. Three recorded a real arrival — one was clicked through in
    // thirty seconds and one never reached the queue at all.
    expect(by.get(RecordCheck.ARRIVALS)).toMatchObject({ recorded: 3, total: 5 });

    // Of those three arrivals, two were called in. The third's wait has one end
    // and is unmeasured rather than zero. The denominator is arrivals, not
    // visits: counting the missing check-ins again here would charge them twice.
    expect(by.get(RecordCheck.CALL_INS)).toMatchObject({ recorded: 2, total: 3 });

    // Every appointment's day has ended. Six were resolved; the seventh is still
    // sitting in "checked in" nearly a week later, with no outcome at all.
    expect(by.get(RecordCheck.VISIT_OUTCOMES)).toMatchObject({ recorded: 6, total: 7 });

    // One of the two completed treatments says when it was performed. The other
    // is counted, not dropped — it is exactly what this check is about.
    expect(by.get(RecordCheck.TREATMENT_DATES)).toMatchObject({ recorded: 1, total: 2 });

    expect(by.get(RecordCheck.NO_SHOW_MARKS)).toMatchObject({ recorded: 1, total: 2 });
  });

  it("separates the no-shows a person marked from the ones inferred overnight", async () => {
    const quality = await readRecordQuality(db, C, TODAY, TZ);
    expect(quality?.noShows).toMatchObject({
      total: 2,
      recorded: 1,
      inferred: 1,
      unknown: 0,
      recordedSharePercent: 50,
    });
  });

  it("sees nothing of another clinic's records", async () => {
    const quality = await readRecordQuality(
      db,
      "9fd00000-0000-4000-8000-0000000000ff",
      TODAY,
      TZ,
    );
    // Asked and found nothing: every check has nothing to record, and the score
    // is null rather than a perfect one.
    expect(quality?.score).toBeNull();
    expect(quality?.checks.every((c) => c.status === "nothing_to_record")).toBe(true);
  });
});
