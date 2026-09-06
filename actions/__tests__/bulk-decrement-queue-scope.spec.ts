/**
 * actions/__tests__/bulk-decrement-queue-scope.spec.ts
 *
 * Regression guard for 20260905090100_scope_bulk_decrement_queue_positions.sql.
 *
 * WHAT WAS WRONG, AND WHAT WAS NOT
 *   `bulk_decrement_queue_positions(p_ids uuid[])` is SECURITY INVOKER, granted
 *   to `authenticated`, and its body was:
 *
 *       update queue_entries set position = position - 1 where id = any(p_ids)
 *
 *   — a caller-supplied array of UUIDs and no predicate of its own. It was
 *   never cross-tenant exploitable: being INVOKER, `queue_entries: staff
 *   update` applied, and that policy is scoped to auth_clinic_id(). The
 *   isolation was real. It just lived entirely in a different object, written
 *   for a different purpose, so the function's safety depended on a reader
 *   holding both in their head at once.
 *
 *   The migration puts the clinic predicate in the function, plus a floor at
 *   position 1. This suite asserts BOTH halves stay true — the isolation the
 *   policy was already providing, and the two things only the function body can
 *   provide (a floor, and failing closed for a caller with no clinic).
 *
 * WHY REAL SESSIONS AND REAL ROWS
 *   The whole question is what Postgres does when a particular principal calls
 *   it. Every case below signs in for real and reads the rows back afterwards,
 *   because "did anything actually move" is the only assertion that means
 *   anything here. Note that PostgREST answers an RPC whose UPDATE matched no
 *   rows with a perfectly cheerful 2xx — so a non-error is NOT evidence of a
 *   refusal, and no test here treats it as one.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_TEST_URL ?? "http://127.0.0.1:55321";
const ANON =
  process.env.SUPABASE_TEST_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const SERVICE =
  process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

/** Dr. Liying's Dental Care. */
const CLINIC_B = "11111111-1111-1111-1111-111111111111";
/** My Dental Clinic — a different tenant. */
const CLINIC_A = "00000000-0000-0000-0000-000000000001";

const DENTIST_B = "dentist@dentgrow.test";
const RECEPTIONIST_B = "receptionist@dentgrow.test";
const DENTIST_A = "brain@dentgrow.test";
const PATIENT_B = "patient@dentgrow.test";

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${URL}/rest/v1/`, { headers: { apikey: ANON } });
    return res.ok || res.status === 404 || res.status === 400;
  } catch {
    return false;
  }
}
const LOCAL_UP = await reachable();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const service = createClient(URL, SERVICE, {
  auth: { persistSession: false, autoRefreshToken: false },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

async function tokenFor(email: string): Promise<string> {
  const res = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const body = await res.json();
  if (!body.access_token) throw new Error(`sign-in failed for ${email}`);
  return body.access_token as string;
}

/** Call the RPC as a given principal. `token` omitted = anonymous. */
async function callRpc(
  ids: string[],
  token?: string
): Promise<{ status: number }> {
  const res = await fetch(
    `${URL}/rest/v1/rpc/bulk_decrement_queue_positions`,
    {
      method: "POST",
      headers: {
        apikey: ANON,
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ p_ids: ids }),
    }
  );
  return { status: res.status };
}

/** Fixture ids, so nothing here depends on seed rows staying put. */
const STAMP = Date.now().toString().slice(-8);
const made: { clinics: string[]; patients: string[]; appts: string[]; queue: string[] } =
  { clinics: [], patients: [], appts: [], queue: [] };

/**
 * A waiting queue entry at `position`, in `clinicId`.
 *
 * Built rather than borrowed from the seed: these tests move positions around,
 * and mutating seeded rows would leave the local database in a state the next
 * suite silently inherits.
 */
async function makeQueueEntry(
  clinicId: string,
  dentistId: string,
  position: number
): Promise<string> {
  const { data: patient } = await service
    .from("patients")
    .insert({ clinic_id: clinicId, name: `Queue Fixture ${STAMP}-${position}` })
    .select("id")
    .single();
  made.patients.push(patient.id);

  const { data: appt } = await service
    .from("appointments")
    .insert({
      clinic_id: clinicId,
      patient_id: patient.id,
      dentist_id: dentistId,
      scheduled_at: new Date().toISOString(),
      source: "walk_in",
      status: "checked_in",
    })
    .select("id")
    .single();
  made.appts.push(appt.id);

  const { data: entry } = await service
    .from("queue_entries")
    .insert({
      clinic_id: clinicId,
      appointment_id: appt.id,
      patient_id: patient.id,
      position,
      status: "waiting",
    })
    .select("id")
    .single();
  made.queue.push(entry.id);
  return entry.id;
}

async function positionOf(id: string): Promise<number> {
  const { data } = await service
    .from("queue_entries")
    .select("position")
    .eq("id", id)
    .single();
  return data.position as number;
}

async function dentistIdFor(clinicId: string): Promise<string> {
  const { data } = await service
    .from("profiles")
    .select("id")
    .eq("clinic_id", clinicId)
    .eq("role", "dentist")
    .limit(1)
    .single();
  return data.id as string;
}

describe.skipIf(!LOCAL_UP)("bulk_decrement_queue_positions", () => {
  /** In the caller's own clinic. */
  let ownEntry = "";
  /** In the OTHER clinic — the row a cross-tenant call would try to move. */
  let foreignEntry = "";
  /** At position 1 already, to exercise the floor. */
  let floorEntry = "";

  beforeAll(async () => {
    const [dentB, dentA] = await Promise.all([
      dentistIdFor(CLINIC_B),
      dentistIdFor(CLINIC_A),
    ]);
    ownEntry = await makeQueueEntry(CLINIC_B, dentB, 5);
    floorEntry = await makeQueueEntry(CLINIC_B, dentB, 1);
    foreignEntry = await makeQueueEntry(CLINIC_A, dentA, 5);
  });

  afterAll(async () => {
    if (!LOCAL_UP) return;
    for (const id of made.queue)
      await service.from("queue_entries").delete().eq("id", id);
    for (const id of made.appts)
      await service.from("appointments").delete().eq("id", id);
    for (const id of made.patients)
      await service.from("patients").delete().eq("id", id);
  });

  // ── The legitimate case ───────────────────────────────────────────────────

  it("a dentist decrements an entry in their own clinic", async () => {
    const before = await positionOf(ownEntry);
    const { status } = await callRpc([ownEntry], await tokenFor(DENTIST_B));
    expect(status).toBeLessThan(300);
    expect(await positionOf(ownEntry)).toBe(before - 1);
  });

  it("a receptionist can do the same — the queue is their job too", async () => {
    const before = await positionOf(ownEntry);
    await callRpc([ownEntry], await tokenFor(RECEPTIONIST_B));
    expect(await positionOf(ownEntry)).toBe(before - 1);
  });

  // ── Tenancy ───────────────────────────────────────────────────────────────

  it("a dentist naming another clinic's entry moves nothing", async () => {
    const before = await positionOf(foreignEntry);
    const { status } = await callRpc([foreignEntry], await tokenFor(DENTIST_B));

    // The call SUCCEEDS at the HTTP layer — it matched no rows, which is not an
    // error. Asserting on the status here would pass against a function with no
    // scoping at all, so the row is what gets asserted.
    expect(status).toBeLessThan(300);
    expect(await positionOf(foreignEntry)).toBe(before);
  });

  it("a mixed array moves only the caller's own row", async () => {
    // The shape an attacker would actually use: hide the foreign id among
    // legitimate ones and hope the function processes the array wholesale.
    const ownBefore = await positionOf(ownEntry);
    const foreignBefore = await positionOf(foreignEntry);

    await callRpc([ownEntry, foreignEntry], await tokenFor(DENTIST_B));

    expect(await positionOf(ownEntry)).toBe(ownBefore - 1);
    expect(await positionOf(foreignEntry)).toBe(foreignBefore);
  });

  // ── Unauthorised callers ──────────────────────────────────────────────────

  it("a portal patient moves nothing, in either clinic", async () => {
    const token = await tokenFor(PATIENT_B);
    const ownBefore = await positionOf(ownEntry);
    const foreignBefore = await positionOf(foreignEntry);

    await callRpc([ownEntry, foreignEntry], token);

    // A patient shares CLINIC_B with `ownEntry`, so the function's own clinic
    // predicate does not stop them — `queue_entries: staff update` does, and
    // there is no patient UPDATE policy at all. Both layers are load-bearing
    // and this asserts the combination.
    expect(await positionOf(ownEntry)).toBe(ownBefore);
    expect(await positionOf(foreignEntry)).toBe(foreignBefore);
  });

  it("an unauthenticated caller moves nothing", async () => {
    const before = await positionOf(ownEntry);
    await callRpc([ownEntry]);
    expect(await positionOf(ownEntry)).toBe(before);
  });

  it("the SERVICE ROLE moves nothing either — the case RLS cannot cover", async () => {
    // service_role carries BYPASSRLS, so `queue_entries: staff update` does not
    // constrain it and never did. Before the migration, an accidental
    // service-role invocation would have decremented every id in the array
    // across every clinic in the database. Now auth_clinic_id() returns NULL
    // for it and `clinic_id = NULL` matches nothing, so it fails closed.
    //
    // This is the one assertion in the file that the RLS policy could not have
    // made true on its own.
    const ownBefore = await positionOf(ownEntry);
    const foreignBefore = await positionOf(foreignEntry);

    const res = await fetch(
      `${URL}/rest/v1/rpc/bulk_decrement_queue_positions`,
      {
        method: "POST",
        headers: {
          apikey: SERVICE,
          Authorization: `Bearer ${SERVICE}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ p_ids: [ownEntry, foreignEntry] }),
      }
    );
    expect(res.status).toBeLessThan(300);
    expect(await positionOf(ownEntry)).toBe(ownBefore);
    expect(await positionOf(foreignEntry)).toBe(foreignBefore);
  });

  // ── Inputs that should simply do nothing ──────────────────────────────────

  it("ids that do not exist are a no-op, not an error", async () => {
    const { status } = await callRpc(
      ["00000000-0000-4000-8000-0000000fffff"],
      await tokenFor(DENTIST_B)
    );
    expect(status).toBeLessThan(300);
  });

  it("an empty array is a no-op", async () => {
    const before = await positionOf(ownEntry);
    const { status } = await callRpc([], await tokenFor(DENTIST_B));
    expect(status).toBeLessThan(300);
    expect(await positionOf(ownEntry)).toBe(before);
  });

  it("a malformed uuid is rejected outright", async () => {
    const res = await fetch(
      `${URL}/rest/v1/rpc/bulk_decrement_queue_positions`,
      {
        method: "POST",
        headers: {
          apikey: ANON,
          "Content-Type": "application/json",
          Authorization: `Bearer ${await tokenFor(DENTIST_B)}`,
        },
        body: JSON.stringify({ p_ids: ["not-a-uuid"] }),
      }
    );
    expect(res.ok).toBe(false);
  });

  // ── The floor ─────────────────────────────────────────────────────────────

  it("never drives a position below 1", async () => {
    // Unreachable through skipPatient(), which only ever passes rows ahead of
    // the skipped entry. It is reachable by a same-clinic staff member calling
    // the RPC directly, and a queue with a position of 0 or -1 in it is a
    // corrupted waiting room.
    expect(await positionOf(floorEntry)).toBe(1);
    await callRpc([floorEntry], await tokenFor(DENTIST_B));
    expect(await positionOf(floorEntry)).toBe(1);
  });
});
