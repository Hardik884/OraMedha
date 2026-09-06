/**
 * actions/__tests__/reminder-logs-permissions.spec.ts
 *
 * Regression guard for 20260905090200_reminder_logs_no_client_delete.sql.
 *
 * WHAT THE PERMISSION ACTUALLY DID
 *   Both staff policies were `for all` — SELECT, INSERT, UPDATE and DELETE —
 *   on a table whose own comment calls it append-only and whose header says
 *   "Nothing updates or deletes them in normal operation". The grant and the
 *   intent had drifted apart.
 *
 *   It matters more than a stray permission usually would, because of what the
 *   rows DO. A reminder_logs row suppresses a patient from the reminder list
 *   for a cooldown window. Deleting it un-suppresses them. So the practical
 *   effect of the DELETE grant was "message this patient about their overdue
 *   payment again, right now", and the record of having done so went with it.
 *
 * WHAT MUST KEEP WORKING
 *   The reminder workflow itself: read the log to suppress duplicates, write a
 *   row when a message is sent. Both roles, own clinic only. And the patient
 *   soft-delete cascade, which clears a deleted patient's rows — that runs
 *   dentist-only on the SERVICE ROLE, so it is unaffected by any policy here,
 *   and this suite proves that rather than assuming it.
 *
 * A note on how refusals look: PostgREST answers an UPDATE or DELETE that RLS
 * matched to no rows with 204 and no error. Every negative case below therefore
 * reads the row back afterwards instead of trusting the status code.
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

const CLINIC_B = "11111111-1111-1111-1111-111111111111"; // Dr. Liying's
const CLINIC_A = "00000000-0000-0000-0000-000000000001"; // My Dental Clinic

const DENTIST_B = "dentist@dentgrow.test";
const RECEPTIONIST_B = "receptionist@dentgrow.test";
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

function sessionHeaders(token: string) {
  return {
    apikey: ANON,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

const STAMP = Date.now().toString().slice(-8);
const made: { patients: string[]; logs: string[] } = { patients: [], logs: [] };

async function makePatient(clinicId: string, label: string): Promise<string> {
  const { data } = await service
    .from("patients")
    .insert({ clinic_id: clinicId, name: `Reminder ${label} ${STAMP}` })
    .select("id")
    .single();
  made.patients.push(data.id);
  return data.id;
}

async function makeLog(clinicId: string, patientId: string): Promise<string> {
  const { data } = await service
    .from("reminder_logs")
    .insert({ clinic_id: clinicId, patient_id: patientId, kind: "payment_reminder" })
    .select("id")
    .single();
  made.logs.push(data.id);
  return data.id;
}

async function logExists(id: string): Promise<boolean> {
  const { data } = await service
    .from("reminder_logs")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  return Boolean(data);
}

describe.skipIf(!LOCAL_UP)("reminder_logs: staff may add, not edit or erase", () => {
  let patientB = "";
  let patientA = "";
  let logB = "";
  let logA = "";

  beforeAll(async () => {
    patientB = await makePatient(CLINIC_B, "B");
    patientA = await makePatient(CLINIC_A, "A");
    logB = await makeLog(CLINIC_B, patientB);
    logA = await makeLog(CLINIC_A, patientA);
  });

  afterAll(async () => {
    if (!LOCAL_UP) return;
    for (const id of made.logs)
      await service.from("reminder_logs").delete().eq("id", id);
    for (const id of made.patients)
      await service.from("patients").delete().eq("id", id);
  });

  // ── The workflow still works ──────────────────────────────────────────────

  it("a receptionist reads their own clinic's reminder history", async () => {
    // This read is what suppresses duplicate messages across page refreshes.
    // If it breaks, every patient reappears on every refresh.
    const res = await fetch(
      `${URL}/rest/v1/reminder_logs?select=id,kind&id=eq.${logB}`,
      { headers: sessionHeaders(await tokenFor(RECEPTIONIST_B)) }
    );
    expect(res.ok).toBe(true);
    expect(await res.json()).toHaveLength(1);
  });

  it("a receptionist records that a reminder was sent", async () => {
    const res = await fetch(`${URL}/rest/v1/reminder_logs`, {
      method: "POST",
      headers: { ...sessionHeaders(await tokenFor(RECEPTIONIST_B)), Prefer: "return=representation" },
      body: JSON.stringify({
        clinic_id: CLINIC_B,
        patient_id: patientB,
        kind: "recall_invitation",
      }),
    });
    expect(res.status).toBe(201);
    const [row] = await res.json();
    made.logs.push(row.id);
  });

  it("a dentist can do both as well", async () => {
    const token = await tokenFor(DENTIST_B);

    const read = await fetch(
      `${URL}/rest/v1/reminder_logs?select=id&id=eq.${logB}`,
      { headers: sessionHeaders(token) }
    );
    expect(await read.json()).toHaveLength(1);

    const write = await fetch(`${URL}/rest/v1/reminder_logs`, {
      method: "POST",
      headers: { ...sessionHeaders(token), Prefer: "return=representation" },
      body: JSON.stringify({
        clinic_id: CLINIC_B,
        patient_id: patientB,
        kind: "treatment_plan_follow_up",
      }),
    });
    expect(write.status).toBe(201);
    const [row] = await write.json();
    made.logs.push(row.id);
  });

  // ── The permission that had to go ─────────────────────────────────────────

  it("a receptionist cannot delete a reminder log", async () => {
    const res = await fetch(`${URL}/rest/v1/reminder_logs?id=eq.${logB}`, {
      method: "DELETE",
      headers: sessionHeaders(await tokenFor(RECEPTIONIST_B)),
    });
    // 204 here means "matched no rows", not "deleted it" — hence the read.
    expect(res.status).toBe(204);
    expect(await logExists(logB)).toBe(true);
  });

  it("a dentist cannot delete one either", async () => {
    // The cascade that legitimately clears these runs on the service role, so
    // nothing is lost by closing the client route for both staff roles.
    await fetch(`${URL}/rest/v1/reminder_logs?id=eq.${logB}`, {
      method: "DELETE",
      headers: sessionHeaders(await tokenFor(DENTIST_B)),
    });
    expect(await logExists(logB)).toBe(true);
  });

  it("a receptionist cannot rewrite one", async () => {
    // No editable field exists on these rows; UPDATE was never used by anything.
    await fetch(`${URL}/rest/v1/reminder_logs?id=eq.${logB}`, {
      method: "PATCH",
      headers: sessionHeaders(await tokenFor(RECEPTIONIST_B)),
      body: JSON.stringify({ kind: "rewritten" }),
    });
    const { data } = await service
      .from("reminder_logs")
      .select("kind")
      .eq("id", logB)
      .single();
    expect(data.kind).toBe("payment_reminder");
  });

  // ── Tenancy ───────────────────────────────────────────────────────────────

  it("staff see nothing belonging to another clinic", async () => {
    const res = await fetch(
      `${URL}/rest/v1/reminder_logs?select=id&id=eq.${logA}`,
      { headers: sessionHeaders(await tokenFor(DENTIST_B)) }
    );
    expect(await res.json()).toEqual([]);
  });

  it("staff cannot write a row against another clinic", async () => {
    const res = await fetch(`${URL}/rest/v1/reminder_logs`, {
      method: "POST",
      headers: sessionHeaders(await tokenFor(RECEPTIONIST_B)),
      body: JSON.stringify({
        clinic_id: CLINIC_A,
        patient_id: patientA,
        kind: "payment_reminder",
      }),
    });
    expect(res.ok).toBe(false);
  });

  it("staff cannot delete another clinic's row", async () => {
    await fetch(`${URL}/rest/v1/reminder_logs?id=eq.${logA}`, {
      method: "DELETE",
      headers: sessionHeaders(await tokenFor(DENTIST_B)),
    });
    expect(await logExists(logA)).toBe(true);
  });

  // ── Patients ──────────────────────────────────────────────────────────────

  it("a patient sees no reminder log at all", async () => {
    // `kind` leaks clinical context — payment_reminder, recall_invitation.
    // Patients have never had a policy here and must not gain one.
    const res = await fetch(`${URL}/rest/v1/reminder_logs?select=*`, {
      headers: sessionHeaders(await tokenFor(PATIENT_B)),
    });
    const rows = res.ok ? await res.json() : [];
    expect(rows).toEqual([]);
  });

  it("an unauthenticated caller sees none", async () => {
    const res = await fetch(`${URL}/rest/v1/reminder_logs?select=*`, {
      headers: { apikey: ANON },
    });
    const rows = res.ok ? await res.json() : [];
    expect(rows).toEqual([]);
  });

  // ── The one legitimate delete ─────────────────────────────────────────────

  it("the service role still clears rows — the patient-deletion cascade", async () => {
    // softDeletePatient() removes a deleted patient's reminder_logs through the
    // admin client. patient-cascade-completeness.spec.ts requires that table to
    // be handled, so closing the client policies must not have closed this.
    const doomed = await makeLog(CLINIC_B, patientB);
    expect(await logExists(doomed)).toBe(true);

    const { error } = await service
      .from("reminder_logs")
      .delete()
      .eq("id", doomed);
    expect(error).toBeNull();
    expect(await logExists(doomed)).toBe(false);
  });
});
