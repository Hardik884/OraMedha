/**
 * PMS production hardening, enforced by the database — on the LOCAL Supabase
 * stack. Skips, loudly, when it is not reachable.
 *
 * Server actions apply these rules; each case here goes straight to PostgREST
 * with a signed-in user's session, the way a request that bypasses the actions
 * would, and checks what the row looks like afterwards. A refusal may surface as
 * an error or as "no rows"; what matters is the stored state.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

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
if (!LOCAL_UP) console.warn(`\n[pms-hardening-db] SKIPPED — local Supabase not reachable at ${URL}.\n`);

const options = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient<Database>(URL, KEY, options);
/* eslint-disable @typescript-eslint/no-explicit-any */
const raw = service as any;

const RUN = crypto.randomUUID().slice(0, 8);
const CLINIC = crypto.randomUUID();
const OTHER_CLINIC = crypto.randomUUID();

type Role = "dentist" | "receptionist" | "patient" | "other_dentist";
const USERS: Record<Role, { id: string; email: string; clinic: string; role: "dentist" | "receptionist" | "patient" }> = {
  dentist: { id: crypto.randomUUID(), email: `hard-dentist-${RUN}@test.local`, clinic: CLINIC, role: "dentist" },
  receptionist: { id: crypto.randomUUID(), email: `hard-recep-${RUN}@test.local`, clinic: CLINIC, role: "receptionist" },
  patient: { id: crypto.randomUUID(), email: `hard-patient-${RUN}@test.local`, clinic: CLINIC, role: "patient" },
  other_dentist: { id: crypto.randomUUID(), email: `hard-other-${RUN}@test.local`, clinic: OTHER_CLINIC, role: "dentist" },
};
const clients = new Map<Role, SupabaseClient<Database>>();
const as = (role: Role) => clients.get(role) as any;

let PATIENT = "";

async function insertOne(table: string, values: Record<string, unknown>): Promise<Record<string, any>> {
  const { data, error } = await raw.from(table).insert(values).select("*").single();
  if (error) throw new Error(`seed ${table}: ${error.message}`);
  return data;
}

let slot = 0;
/** A distinct time per appointment, so no two seeds collide on a slot. */
function nextSlot(base = "2026-08-03T03:30:00.000Z"): string {
  slot += 1;
  return new Date(Date.parse(base) + slot * 60 * 60_000).toISOString();
}

async function appointment(over: Record<string, unknown> = {}) {
  return insertOne("appointments", {
    clinic_id: CLINIC,
    patient_id: PATIENT,
    dentist_id: USERS.dentist.id,
    scheduled_at: nextSlot(),
    duration_minutes: 30,
    source: "phone_call",
    status: "scheduled",
    ...over,
  });
}

async function followUp(over: Record<string, unknown> = {}) {
  return insertOne("follow_ups", { clinic_id: CLINIC, patient_id: PATIENT, due_date: "2026-08-20", status: "pending", ...over });
}

async function read(table: string, id: string): Promise<Record<string, any>> {
  const { data } = await raw.from(table).select("*").eq("id", id).single();
  return data;
}

describe.skipIf(!LOCAL_UP)("PMS hardening — database enforcement", () => {
  beforeAll(async () => {
    const { error: clinicError } = await raw.from("clinics").insert([
      { id: CLINIC, name: `Hardening ${RUN}` },
      { id: OTHER_CLINIC, name: `Hardening other ${RUN}` },
    ]);
    if (clinicError) throw new Error(`seed clinics: ${clinicError.message}`);
    for (const u of Object.values(USERS)) {
      const { error } = await raw.auth.admin.createUser({ id: u.id, email: u.email, password: "password123", email_confirm: true });
      if (error) throw new Error(`seed user: ${error.message}`);
      const { error: profileError } = await raw.from("profiles").upsert({ id: u.id, clinic_id: u.clinic, full_name: "Hardening", role: u.role });
      if (profileError) throw new Error(`seed profile: ${profileError.message}`);
    }
    PATIENT = (await insertOne("patients", { clinic_id: CLINIC, name: "Hardening patient" })).id;
    await insertOne("patient_portal_links", { patient_id: PATIENT, user_id: USERS.patient.id });
    for (const role of Object.keys(USERS) as Role[]) {
      const client = createClient<Database>(URL, ANON_KEY, options);
      const { error } = await client.auth.signInWithPassword({ email: USERS[role].email, password: "password123" });
      if (error) throw new Error(`sign in ${role}: ${error.message}`);
      clients.set(role, client);
    }
  });

  // ── F12 / F13e: follow-up status ────────────────────────────────────────────
  describe("follow-up status", () => {
    it("a receptionist cannot close a pending follow-up directly", async () => {
      for (const status of ["completed", "cancelled"]) {
        const fu = await followUp();
        await as("receptionist").from("follow_ups").update({ status }).eq("id", fu.id);
        expect({ status, after: (await read("follow_ups", fu.id)).status }).toEqual({ status, after: "pending" });
      }
    });

    it("a portal patient and another clinic's dentist cannot change it either", async () => {
      const fu = await followUp();
      await as("patient").from("follow_ups").update({ status: "completed" }).eq("id", fu.id);
      await as("other_dentist").from("follow_ups").update({ status: "completed" }).eq("id", fu.id);
      expect((await read("follow_ups", fu.id)).status).toBe("pending");
    });

    it("the dentist completes or cancels a pending follow-up", async () => {
      const a = await followUp();
      const b = await followUp();
      expect((await as("dentist").from("follow_ups").update({ status: "completed" }).eq("id", a.id)).error).toBeNull();
      expect((await as("dentist").from("follow_ups").update({ status: "cancelled" }).eq("id", b.id)).error).toBeNull();
      expect((await read("follow_ups", a.id)).status).toBe("completed");
      expect((await read("follow_ups", b.id)).status).toBe("cancelled");
    });

    it("nobody signed in reopens or changes a closed follow-up, the dentist included", async () => {
      for (const from of ["completed", "cancelled"]) {
        const fu = await followUp({ status: from });
        for (const role of ["dentist", "receptionist"] as const) {
          for (const to of ["pending", from === "completed" ? "cancelled" : "completed"]) {
            await as(role).from("follow_ups").update({ status: to }).eq("id", fu.id);
          }
        }
        expect({ from, after: (await read("follow_ups", fu.id)).status }).toEqual({ from, after: from });
      }
    });

    it("a receptionist may complete it only through its completed recall visit", async () => {
      const fu = await followUp();
      const recall = await appointment({ follow_up_id: fu.id, status: "in_progress" });
      await as("receptionist").from("follow_ups").update({ status: "completed" }).eq("id", fu.id);
      expect((await read("follow_ups", fu.id)).status).toBe("pending");

      await raw.from("appointments").update({ status: "completed" }).eq("id", recall.id);
      expect((await as("receptionist").from("follow_ups").update({ status: "completed" }).eq("id", fu.id)).error).toBeNull();
      expect((await read("follow_ups", fu.id)).status).toBe("completed");
    });

    it("edits that leave the status alone still work for staff", async () => {
      const fu = await followUp();
      expect((await as("receptionist").from("follow_ups").update({ notes: "call back" }).eq("id", fu.id)).error).toBeNull();
      expect((await read("follow_ups", fu.id)).notes).toBe("call back");
    });
  });

  // ── F5: queue soft removal ──────────────────────────────────────────────────
  describe("queue soft removal", () => {
    async function queueEntry(appt: Record<string, any>, over: Record<string, unknown> = {}) {
      return insertOne("queue_entries", {
        clinic_id: CLINIC,
        appointment_id: appt.id,
        patient_id: PATIENT,
        position: 1,
        status: "waiting",
        checked_in_at: "2026-08-03T04:00:00.000Z",
        queue_date: "2026-08-03",
        ...over,
      });
    }

    it("cannot be removed before it was checked in", async () => {
      const entry = await queueEntry(await appointment({ status: "checked_in" }));
      const { error } = await raw.from("queue_entries").update({ removed_at: "2026-08-03T03:00:00.000Z" }).eq("id", entry.id);
      expect(error?.message ?? "").toMatch(/chk_queue_removed_after_check_in/);
    });

    it("a removed in-progress entry never blocks the next patient being called", async () => {
      const date = "2026-08-04";
      const first = await queueEntry(await appointment({ status: "cancelled" }), { status: "in_progress", queue_date: date, called_at: "2026-08-03T04:10:00.000Z" });
      await raw.from("queue_entries").update({ removed_at: "2026-08-03T04:20:00.000Z" }).eq("id", first.id);
      const second = await queueEntry(await appointment({ status: "in_progress" }), { status: "in_progress", queue_date: date, called_at: "2026-08-03T04:30:00.000Z" });
      expect(second.status).toBe("in_progress");
      // Two LIVE in-progress entries are still refused.
      const { error } = await raw
        .from("queue_entries")
        .insert({ clinic_id: CLINIC, appointment_id: (await appointment({ status: "in_progress" })).id, patient_id: PATIENT, position: 3, status: "in_progress", checked_in_at: "2026-08-03T04:00:00.000Z", queue_date: date });
      expect(error?.message ?? "").toMatch(/uq_queue_clinic_in_progress_per_day/);
    });

    it("the removed row keeps its check-in and call-in", async () => {
      const entry = await queueEntry(await appointment({ status: "checked_in" }), { queue_date: "2026-08-05", called_at: "2026-08-03T04:05:00.000Z" });
      await raw.from("queue_entries").update({ removed_at: "2026-08-03T04:30:00.000Z" }).eq("id", entry.id);
      const after = await read("queue_entries", entry.id);
      expect(after).toMatchObject({ checked_in_at: entry.checked_in_at, called_at: entry.called_at, status: "waiting" });
      expect(after.removed_at).not.toBeNull();
    });
  });
});
