/**
 * Every Business Brain table, against every kind of caller, on the LOCAL Supabase
 * stack. Skips, loudly, when it is not reachable.
 *
 * The tables each carry their own policy, written in separate migrations months
 * apart; this is the one place that reads them as a set. For each table:
 *
 *   read    only the clinic's own DENTIST (and the service role) sees its rows —
 *           never a receptionist, a portal patient, another clinic's dentist or
 *           an anonymous caller
 *   write   no signed-in user writes the derived or evidential tables: history,
 *           snapshots, completions, decisions and memory builds are written by
 *           the server after it validates them. The one client write is a
 *           dentist snoozing their own clinic's card.
 *   change  the append-only tables refuse UPDATE and DELETE even from the owning
 *           dentist, and a stored row reads back unchanged afterwards
 *   history the state-history and observation tables (migrations 20260917100000
 *           and 20260917100100) are written only by database triggers: no role at
 *           all, the service role included, can insert, change or erase a row
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/types/database.types";

const URL = process.env.SUPABASE_TEST_URL ?? "http://127.0.0.1:55321";
const KEY =
  process.env.SUPABASE_TEST_SERVICE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const ANON_KEY =
  process.env.SUPABASE_TEST_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${URL}/rest/v1/`, { headers: { apikey: KEY }, signal: AbortSignal.timeout(2500) });
    return res.status < 500;
  } catch {
    return false;
  }
}
const LOCAL_UP = await reachable();
if (!LOCAL_UP) console.warn(`\n[rls-matrix] SKIPPED — local Supabase not reachable at ${URL}.\n`);

const options = { auth: { persistSession: false, autoRefreshToken: false } };
const service: SupabaseClient<Database> = createClient<Database>(URL, KEY, options);
/* eslint-disable @typescript-eslint/no-explicit-any */
const raw = service as any;

const CLINIC = crypto.randomUUID();
const OTHER_CLINIC = crypto.randomUUID();

type Role = "dentist" | "receptionist" | "patient" | "other_dentist";
const USERS: Record<Role, { id: string; email: string; clinic: string; role: "dentist" | "receptionist" | "patient" }> = {
  dentist: { id: "7e1a0000-0000-4000-8000-0000000000d1", email: "rls-dentist@test.local", clinic: CLINIC, role: "dentist" },
  receptionist: { id: "7e1a0000-0000-4000-8000-0000000000e1", email: "rls-receptionist@test.local", clinic: CLINIC, role: "receptionist" },
  patient: { id: "7e1a0000-0000-4000-8000-0000000000f1", email: "rls-patient@test.local", clinic: CLINIC, role: "patient" },
  other_dentist: { id: "7e1a0000-0000-4000-8000-0000000000d2", email: "rls-other@test.local", clinic: OTHER_CLINIC, role: "dentist" },
};

const TABLES = ["metric_history", "finding_snapshots", "action_completions", "clinic_decisions", "clinic_memory_builds", "problem_dismissals"] as const;
type Table = (typeof TABLES)[number];

/** A valid row for `table` in `clinic`, as the server would write it. */
function row(table: Table, clinic: string, variant = 0): Record<string, unknown> {
  const date = `2026-08-${String(1 + variant).padStart(2, "0")}`;
  switch (table) {
    case "metric_history":
      return { clinic_id: clinic, metric_date: date, metric_key: "followups.overdue", value: 3, measured_at: `${date}T12:00:00.000Z` };
    case "finding_snapshots":
      return { clinic_id: clinic, business_date: date, findings: [] };
    case "action_completions":
      return { clinic_id: clinic, category: "retention", constraint_id: `constraint.retention:${clinic}:${date}`, source: "inferred" };
    case "clinic_decisions":
      return {
        clinic_id: clinic,
        target_type: "proposal",
        target_id: `proposal.action_preference:learning.action_preference:retention:${clinic}`,
        proposal_kind: "action_preference",
        subject: "retention",
        decision: "accepted",
        basis: { episodes: 4 },
        decided_by: clinic === CLINIC ? USERS.dentist.id : USERS.other_dentist.id,
      };
    case "clinic_memory_builds":
      return { clinic_id: clinic, built_for: date, derivation_version: "rls-matrix", window_from: date, window_to: date, digest: "d", memory: {} };
    case "problem_dismissals":
      return {
        clinic_id: clinic,
        category: "retention",
        severity_at_dismissal: "high",
        reason: "Handled by phone",
        expires_at: "2099-01-01T00:00:00.000Z",
        dismissed_by: clinic === CLINIC ? USERS.dentist.id : USERS.other_dentist.id,
      };
  }
}

const clients = new Map<Role | "anon", SupabaseClient<Database>>();

async function signIn(email: string): Promise<SupabaseClient<Database>> {
  const client = createClient<Database>(URL, ANON_KEY, options);
  const { error } = await client.auth.signInWithPassword({ email, password: "password123" });
  if (error) throw new Error(`sign in ${email}: ${error.message}`);
  return client;
}

/** The rows of `table` in CLINIC a caller can see; an error reads as none. */
async function visible(client: SupabaseClient<Database>, table: Table): Promise<number> {
  const { data, error } = await (client as any).from(table).select("clinic_id").eq("clinic_id", CLINIC);
  return error ? 0 : (data as unknown[]).length;
}

describe.skipIf(!LOCAL_UP)("Business Brain RLS matrix", () => {
  beforeAll(async () => {
    const { error: clinicError } = await raw.from("clinics").insert([
      { id: CLINIC, name: "RLS matrix" },
      { id: OTHER_CLINIC, name: "RLS matrix other" },
    ]);
    if (clinicError) throw new Error(`seed clinics: ${clinicError.message}`);
    for (const u of Object.values(USERS)) {
      const { error } = await raw.auth.admin.createUser({ id: u.id, email: u.email, password: "password123", email_confirm: true });
      if (error && !/already/i.test(error.message)) throw new Error(`seed user: ${error.message}`);
      const { error: profileError } = await raw.from("profiles").upsert({ id: u.id, clinic_id: u.clinic, full_name: "RLS", role: u.role });
      if (profileError) throw new Error(`seed profile: ${profileError.message}`);
    }
    for (const table of TABLES) {
      const { error } = await raw.from(table).insert([row(table, CLINIC), row(table, OTHER_CLINIC)]);
      if (error) throw new Error(`seed ${table}: ${error.message}`);
    }
    clients.set("anon", createClient<Database>(URL, ANON_KEY, options));
    for (const role of Object.keys(USERS) as Role[]) clients.set(role, await signIn(USERS[role].email));
  });

  // ── state history and observations ────────────────────────────────────────
  const HISTORY = {
    appointment_status_history: "appointment_id",
    treatment_status_history: "treatment_id",
    follow_up_status_history: "follow_up_id",
    payment_state_history: "payment_id",
    patient_state_history: "patient_id",
    metric_observations: "metric_key",
  } as const;
  type HistoryTable = keyof typeof HISTORY;

  /** Records in both clinics, so every history table holds a row for each. */
  async function seedRecords(clinic: string, dentistId: string) {
    const patient = crypto.randomUUID();
    const one = async (table: string, values: Record<string, unknown>) => {
      const { data, error } = await raw.from(table).insert(values).select("id").single();
      if (error) throw new Error(`seed ${table}: ${error.message}`);
      return data.id as string;
    };
    await one("patients", { id: patient, clinic_id: clinic, name: "RLS history" });
    const appointment = await one("appointments", {
      clinic_id: clinic,
      patient_id: patient,
      dentist_id: dentistId,
      scheduled_at: new Date(Date.parse("2026-08-01T09:00:00.000Z") + Math.floor(Math.random() * 1e9)).toISOString(),
      duration_minutes: 30,
      source: "phone_call",
      status: "scheduled",
    });
    await one("treatments", { clinic_id: clinic, patient_id: patient, appointment_id: appointment, treatment_type: "Cleaning", cost: 100, status: "planned" });
    await one("follow_ups", { clinic_id: clinic, patient_id: patient, due_date: "2026-08-10", status: "pending" });
    await one("payments", { clinic_id: clinic, patient_id: patient, amount: 50, method: "cash", payment_date: "2026-08-01" });
  }

  async function historyRows(client: SupabaseClient<Database>, table: HistoryTable): Promise<number> {
    const { data, error } = await (client as any).from(table).select("clinic_id").eq("clinic_id", CLINIC);
    return error ? 0 : (data as unknown[]).length;
  }

  beforeAll(async () => {
    await seedRecords(CLINIC, USERS.dentist.id);
    await seedRecords(OTHER_CLINIC, USERS.other_dentist.id);
  });

  it("state history and observations: only the clinic's own dentist and the service role can read them", async () => {
    for (const table of Object.keys(HISTORY) as HistoryTable[]) {
      const all = await historyRows(service, table);
      expect({ table, some: all > 0 }).toEqual({ table, some: true });
      expect({ table, dentist: await historyRows(clients.get("dentist")!, table) }).toEqual({ table, dentist: all });
      for (const caller of ["anon", "receptionist", "patient", "other_dentist"] as const) {
        expect({ table, caller, rows: await historyRows(clients.get(caller)!, table) }).toEqual({ table, caller, rows: 0 });
      }
    }
  });

  it("state history and observations: nobody, the service role included, can forge, change or erase a row", async () => {
    for (const table of Object.keys(HISTORY) as HistoryTable[]) {
      const { data: existing } = await raw.from(table).select("*").eq("clinic_id", CLINIC).limit(1).single();
      const { id: _id, seq: _seq, ...forged } = existing as Record<string, unknown>;
      for (const caller of ["service", "dentist", "receptionist", "patient", "other_dentist", "anon"] as const) {
        const client = (caller === "service" ? service : clients.get(caller)) as any;
        // A row that passes every CHECK: only the missing write grant (and RLS) can refuse it.
        const { error: insertError } = await client.from(table).insert(forged);
        expect({ table, caller, insertRefused: insertError !== null }).toEqual({ table, caller, insertRefused: true });
        // A refused update or delete may read as an error or as "no rows"; what
        // matters is checked below: the row is untouched.
        await client.from(table).update({ clinic_id: OTHER_CLINIC }).eq("id", existing.id);
        await client.from(table).delete().eq("id", existing.id);
      }
      const { data: after } = await raw.from(table).select("*").eq("id", existing.id).single();
      expect({ table, after }).toEqual({ table, after: existing });
    }
  });

  it("point-in-time readers: refused to anonymous callers, and scoped by RLS for everyone else", async () => {
    const args = { p_clinic_id: CLINIC, p_known_at: "2100-01-01T00:00:00.000Z" };
    const { error: anonError } = await (clients.get("anon") as any).rpc("appointment_states_as_of", args);
    expect(anonError).not.toBeNull();
    const everyone = (await raw.rpc("appointment_states_as_of", args)).data.length;
    expect(everyone).toBeGreaterThan(0);
    expect((await (clients.get("dentist") as any).rpc("appointment_states_as_of", args)).data).toHaveLength(everyone);
    for (const caller of ["receptionist", "patient", "other_dentist"] as const) {
      const { data } = await (clients.get(caller) as any).rpc("appointment_states_as_of", args);
      expect({ caller, rows: (data ?? []).length }).toEqual({ caller, rows: 0 });
    }
  });

  afterAll(async () => {
    if (!LOCAL_UP) return;
    // The append-only tables keep their rows (their clinics are unique to this
    // run); the mutable ones are cleared.
    await raw.from("metric_history").delete().in("clinic_id", [CLINIC, OTHER_CLINIC]);
    await raw.from("problem_dismissals").delete().in("clinic_id", [CLINIC, OTHER_CLINIC]);
  });

  for (const table of TABLES) {
    it(`${table}: only the clinic's own dentist and the service role can read it`, async () => {
      expect(await visible(service, table)).toBe(1);
      expect(await visible(clients.get("dentist")!, table)).toBe(1);
      for (const caller of ["anon", "receptionist", "patient", "other_dentist"] as const) {
        expect({ caller, rows: await visible(clients.get(caller)!, table) }).toEqual({ caller, rows: 0 });
      }
    });
  }

  for (const table of TABLES.filter((t) => t !== "problem_dismissals")) {
    it(`${table}: no signed-in caller can write it, in their own clinic or another`, async () => {
      for (const caller of ["dentist", "receptionist", "patient", "other_dentist"] as const) {
        const { error } = await (clients.get(caller) as any).from(table).insert(row(table, CLINIC, 20));
        expect({ caller, refused: error !== null }).toEqual({ caller, refused: true });
      }
      const { data } = await raw.from(table).select("clinic_id").eq("clinic_id", CLINIC);
      expect(data).toHaveLength(1);
    });
  }

  it("problem_dismissals: only the clinic's own dentist can snooze its card", async () => {
    for (const caller of ["receptionist", "patient", "other_dentist"] as const) {
      const { error } = await (clients.get(caller) as any).from("problem_dismissals").insert(row("problem_dismissals", CLINIC));
      expect({ caller, refused: error !== null }).toEqual({ caller, refused: true });
    }
    const dentist = clients.get("dentist") as any;
    const { data, error } = await dentist.from("problem_dismissals").insert(row("problem_dismissals", CLINIC)).select("id").single();
    expect(error).toBeNull();
    // Un-snoozing is the dentist's too; it also leaves the table as the other tests expect it.
    const { error: undo } = await dentist.from("problem_dismissals").delete().eq("id", data.id);
    expect(undo).toBeNull();
  });

  for (const table of ["finding_snapshots", "action_completions", "clinic_decisions", "clinic_memory_builds", "metric_history"] as const) {
    it(`${table}: the owning dentist cannot change or erase a stored row`, async () => {
      const before = await raw.from(table).select("*").eq("clinic_id", CLINIC);
      const client = clients.get("dentist") as any;
      const patch: Record<string, unknown> =
        table === "metric_history" ? { value: 999 } : table === "action_completions" ? { source: "declared" } : table === "finding_snapshots" ? { findings: [{ x: 1 }] } : table === "clinic_decisions" ? { decision: "rejected" } : { digest: "tampered" };
      await client.from(table).update(patch).eq("clinic_id", CLINIC);
      await client.from(table).delete().eq("clinic_id", CLINIC);
      const after = await raw.from(table).select("*").eq("clinic_id", CLINIC);
      expect(after.data).toEqual(before.data);
    });
  }

  for (const table of ["finding_snapshots", "action_completions", "clinic_decisions", "clinic_memory_builds"] as const) {
    it(`${table}: even the service role cannot rewrite history outside a retention purge`, async () => {
      const { error: del } = await raw.from(table).delete().eq("clinic_id", OTHER_CLINIC);
      expect(del?.message ?? "").toMatch(/append-only|retention purge/i);
    });
  }
});
