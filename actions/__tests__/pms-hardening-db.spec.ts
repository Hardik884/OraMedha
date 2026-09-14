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

  // ── F13a: appointment status transitions ────────────────────────────────────
  describe("appointment status transitions", () => {
    async function tryStatus(role: Role, id: string, status: string) {
      await as(role).from("appointments").update({ status }).eq("id", id);
      return (await read("appointments", id)).status as string;
    }

    async function noShowMark(appointmentId: string, performedBy: string | null, daysAgo: number) {
      const { error } = await raw.from("appointment_history").insert({
        appointment_id: appointmentId,
        action: "status_changed",
        old_value: { status: "scheduled" },
        new_value: { status: "no_show" },
        performed_by: performedBy,
        timestamp: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
      });
      if (error) throw new Error(`seed history: ${error.message}`);
    }

    it("staff walk the lifecycle", async () => {
      const appt = await appointment();
      expect(await tryStatus("receptionist", appt.id, "checked_in")).toBe("checked_in");
      expect(await tryStatus("receptionist", appt.id, "in_progress")).toBe("in_progress");
      expect(await tryStatus("receptionist", appt.id, "completed")).toBe("completed");
    });

    it("completed and cancelled are final for everyone signed in", async () => {
      for (const from of ["completed", "cancelled"]) {
        const appt = await appointment({ status: from });
        for (const role of ["dentist", "receptionist", "patient"] as const) {
          for (const to of ["scheduled", "checked_in", "in_progress", from === "completed" ? "cancelled" : "completed"]) {
            expect({ from, role, to, after: await tryStatus(role, appt.id, to) }).toEqual({ from, role, to, after: from });
          }
        }
      }
    });

    it("a receptionist cannot skip straight to completed, the dentist can", async () => {
      const a = await appointment();
      expect(await tryStatus("receptionist", a.id, "completed")).toBe("scheduled");
      expect(await tryStatus("receptionist", a.id, "in_progress")).toBe("scheduled");
      expect(await tryStatus("dentist", a.id, "completed")).toBe("completed");

      const b = await appointment({ status: "checked_in" });
      expect(await tryStatus("receptionist", b.id, "completed")).toBe("checked_in");
      expect(await tryStatus("dentist", b.id, "completed")).toBe("completed");
    });

    it("a receptionist completes a checked-in visit only when the live queue has the patient in the chair", async () => {
      const appt = await appointment({ status: "checked_in" });
      await insertOne("queue_entries", {
        clinic_id: CLINIC, appointment_id: appt.id, patient_id: PATIENT, position: 1, status: "in_progress",
        checked_in_at: "2026-08-03T04:00:00.000Z", called_at: "2026-08-03T04:10:00.000Z", queue_date: "2026-08-10",
      });
      expect(await tryStatus("receptionist", appt.id, "completed")).toBe("completed");
    });

    it("a check-in rolls back to scheduled only while nothing is queued for it", async () => {
      const queued = await appointment({ status: "checked_in" });
      await insertOne("queue_entries", {
        clinic_id: CLINIC, appointment_id: queued.id, patient_id: PATIENT, position: 1, status: "waiting",
        checked_in_at: "2026-08-03T04:00:00.000Z", queue_date: "2026-08-11",
      });
      expect(await tryStatus("receptionist", queued.id, "scheduled")).toBe("checked_in");

      const unqueued = await appointment({ status: "checked_in" });
      expect(await tryStatus("receptionist", unqueued.id, "scheduled")).toBe("scheduled");
    });

    it("a portal patient may only cancel their own scheduled appointment", async () => {
      const scheduled = await appointment();
      expect(await tryStatus("patient", scheduled.id, "cancelled")).toBe("cancelled");
      const checkedIn = await appointment({ status: "checked_in" });
      expect(await tryStatus("patient", checkedIn.id, "cancelled")).toBe("checked_in");
      const other = await appointment();
      expect(await tryStatus("patient", other.id, "completed")).toBe("scheduled");
      expect(await tryStatus("patient", other.id, "no_show")).toBe("scheduled");
    });

    it("another clinic's dentist cannot change the status at all", async () => {
      const appt = await appointment();
      expect(await tryStatus("other_dentist", appt.id, "cancelled")).toBe("scheduled");
    });

    it("the dentist corrects a system-inferred no-show within seven days, and only that", async () => {
      const inferred = await appointment({ status: "no_show" });
      await noShowMark(inferred.id, null, 1);
      expect(await tryStatus("receptionist", inferred.id, "completed")).toBe("no_show");
      expect(await tryStatus("dentist", inferred.id, "completed")).toBe("completed");

      const recorded = await appointment({ status: "no_show" });
      await noShowMark(recorded.id, USERS.receptionist.id, 1);
      expect(await tryStatus("dentist", recorded.id, "completed")).toBe("no_show");

      const stale = await appointment({ status: "no_show" });
      await noShowMark(stale.id, null, 8);
      expect(await tryStatus("dentist", stale.id, "completed")).toBe("no_show");

      const unevidenced = await appointment({ status: "no_show" });
      expect(await tryStatus("dentist", unevidenced.id, "completed")).toBe("no_show");

      // Never back to scheduled, whoever inferred it.
      expect(await tryStatus("dentist", inferred.id, "scheduled")).toBe("completed");
      const inferred2 = await appointment({ status: "no_show" });
      await noShowMark(inferred2.id, null, 1);
      expect(await tryStatus("dentist", inferred2.id, "scheduled")).toBe("no_show");
    });

    it("the service role is not restricted (the nightly no-show job)", async () => {
      const appt = await appointment({ status: "completed" });
      expect((await raw.from("appointments").update({ status: "no_show" }).eq("id", appt.id)).error).toBeNull();
    });
  });

  // ── F13b / F13c / F13d: no hard delete, no payment edits ────────────────────
  describe("no hard delete and no payment edits from a session", () => {
    it("the dentist cannot hard-delete a patient, appointment, treatment, payment or follow-up", async () => {
      const patient = await insertOne("patients", { clinic_id: CLINIC, name: "Delete target" });
      const appt = await appointment({ patient_id: patient.id });
      const rows: Array<[string, string]> = [
        ["patients", patient.id],
        ["appointments", appt.id],
        ["treatments", (await insertOne("treatments", { clinic_id: CLINIC, patient_id: patient.id, appointment_id: appt.id, treatment_type: "Cleaning", cost: 100, status: "planned" })).id],
        ["payments", (await insertOne("payments", { clinic_id: CLINIC, patient_id: patient.id, amount: 50, method: "cash", payment_date: "2026-08-01" })).id],
        ["follow_ups", (await followUp({ patient_id: patient.id })).id],
      ];
      for (const [table, id] of rows.reverse()) {
        for (const role of ["dentist", "receptionist", "patient"] as const) {
          await as(role).from(table).delete().eq("id", id);
        }
        expect({ table, kept: (await read(table, id)) !== null }).toEqual({ table, kept: true });
      }
    });

    it("no staff session can change a recorded payment; recording one still works", async () => {
      const { data: inserted, error } = await as("receptionist")
        .from("payments")
        .insert({ clinic_id: CLINIC, patient_id: PATIENT, amount: 75, method: "upi", payment_date: "2026-08-02" })
        .select("id")
        .single();
      expect(error).toBeNull();
      for (const role of ["dentist", "receptionist"] as const) {
        await as(role).from("payments").update({ amount: 1, payment_date: "2026-01-01" }).eq("id", inserted.id);
        await as(role).from("payments").update({ deleted_at: new Date().toISOString() }).eq("id", inserted.id);
      }
      expect(await read("payments", inserted.id)).toMatchObject({ amount: 75, payment_date: "2026-08-02", deleted_at: null });
    });

    it("no session can erase a queue entry; staff still update it", async () => {
      const appt = await appointment({ status: "checked_in" });
      const entry = await insertOne("queue_entries", {
        clinic_id: CLINIC, appointment_id: appt.id, patient_id: PATIENT, position: 4, status: "waiting",
        checked_in_at: "2026-08-03T04:00:00.000Z", queue_date: "2026-08-12",
      });
      for (const role of ["dentist", "receptionist", "patient"] as const) {
        await as(role).from("queue_entries").delete().eq("id", entry.id);
      }
      expect(await read("queue_entries", entry.id)).not.toBeNull();
      expect((await as("receptionist").from("queue_entries").update({ position: 2 }).eq("id", entry.id)).error).toBeNull();
      expect((await read("queue_entries", entry.id)).position).toBe(2);
      const { data: visible } = await as("dentist").from("queue_entries").select("id").eq("id", entry.id);
      expect(visible).toHaveLength(1);
    });
  });

  // ── F9: booking validation against real sessions ────────────────────────────
  describe("booking validation on the real stack", () => {
    const NOW = new Date("2026-09-14T04:35:00.000Z"); // Monday 10:05 IST

    beforeAll(async () => {
      const hours = { open: "09:00", close: "13:00", is_open: true };
      const { error } = await raw.from("clinic_settings").upsert({
        clinic_id: CLINIC,
        clinic_name: `Hardening ${RUN}`,
        timezone: "Asia/Kolkata",
        average_appointment_duration: 30,
        clinic_hours: { monday: hours, tuesday: hours, wednesday: hours, thursday: hours, friday: hours, saturday: { open: null, close: null, is_open: false }, sunday: { open: null, close: null, is_open: false } },
      });
      if (error) throw new Error(`seed clinic_settings: ${error.message}`);
      await insertOne("unavailable_dates", { clinic_id: CLINIC, date: "2026-09-16" });
      const other = await insertOne("patients", { clinic_id: CLINIC, name: "Someone else" });
      // Tuesday 10:00 IST, booked by another patient.
      await insertOne("appointments", {
        clinic_id: CLINIC, patient_id: other.id, dentist_id: USERS.dentist.id, scheduled_at: "2026-09-15T04:30:00.000Z",
        duration_minutes: 30, source: "phone_call", status: "scheduled",
      });
    });

    const req = (localSlot: string) => ({
      clinicId: CLINIC, dentistId: USERS.dentist.id, localSlot, durationMinutes: 30, patientFacing: true, now: NOW,
    });

    it("a portal patient's booking is checked against every patient's visits, not only their own", async () => {
      const { checkBookingSlot } = await import("@/lib/scheduling/booking-validation");
      const patient = as("patient");
      // The patient's own session cannot see the other booking...
      const { data: seen } = await patient.from("appointments").select("id").eq("scheduled_at", "2026-09-15T04:30:00.000Z");
      expect(seen).toHaveLength(0);
      // ...but validation reads occupancy server-side and refuses it.
      expect(await checkBookingSlot(patient, service, req("2026-09-15T10:00"))).toMatchObject({ ok: false, reason: "taken" });
      expect(await checkBookingSlot(patient, service, req("2026-09-15T09:45"))).toMatchObject({ ok: false, reason: "unavailable" });
      expect(await checkBookingSlot(patient, service, req("2026-09-15T11:00"))).toMatchObject({ ok: true });
    });

    it("reads the clinic's holidays and hours through the patient's own session", async () => {
      const { checkBookingSlot } = await import("@/lib/scheduling/booking-validation");
      const patient = as("patient");
      expect(await checkBookingSlot(patient, service, req("2026-09-16T10:00"))).toMatchObject({ ok: false, reason: "closed" });
      expect(await checkBookingSlot(patient, service, req("2026-09-19T10:00"))).toMatchObject({ ok: false, reason: "closed" });
      expect(await checkBookingSlot(patient, service, req("2026-09-17T13:30"))).toMatchObject({ ok: false, reason: "unavailable" });
    });

    it("another clinic's schedule is not this clinic's", async () => {
      const { checkBookingSlot } = await import("@/lib/scheduling/booking-validation");
      // The other clinic has no settings or rules at all: closed, never borrowed.
      expect(await checkBookingSlot(as("other_dentist"), service, { ...req("2026-09-15T11:00"), clinicId: OTHER_CLINIC, dentistId: USERS.other_dentist.id })).toMatchObject({ ok: false, reason: "closed" });
    });
  });

  // ── F11: a deleted patient's history ────────────────────────────────────────
  describe("patient deletion cause", () => {
    let deletedPayment = "";
    let manualPayment = "";
    let deletedTreatment = "";

    beforeAll(async () => {
      const gone = await insertOne("patients", { clinic_id: CLINIC, name: "Deleted with history" });
      const appt = await appointment({ patient_id: gone.id, status: "completed", scheduled_at: "2026-07-01T04:30:00.000Z" });
      deletedTreatment = (await insertOne("treatments", {
        clinic_id: CLINIC, patient_id: gone.id, appointment_id: appt.id, treatment_type: "Crown", cost: 3000,
        status: "completed", performed_at: "2026-07-01T05:00:00.000Z",
      })).id;
      deletedPayment = (await insertOne("payments", { clinic_id: CLINIC, patient_id: gone.id, amount: 1500, method: "cash", payment_date: "2026-07-01" })).id;
      manualPayment = (await insertOne("payments", { clinic_id: CLINIC, patient_id: gone.id, amount: 99, method: "cash", payment_date: "2026-07-01" })).id;
      // A payment deleted on its own first (cause not recorded), then the patient.
      await raw.from("payments").update({ deleted_at: new Date().toISOString() }).eq("id", manualPayment);
      const now = new Date().toISOString();
      for (const table of ["appointments", "treatments", "payments"]) {
        const { error } = await raw.from(table).update({ deleted_at: now, deletion_cause: "patient_deleted" }).eq("patient_id", gone.id).is("deleted_at", null);
        if (error) throw new Error(`cascade ${table}: ${error.message}`);
      }
      await raw.from("patients").update({ deleted_at: now }).eq("id", gone.id);
    });

    it("the history projection answers only the clinic's dentist and the service role", async () => {
      const ids = async (client: any) => {
        const { data, error } = await client.rpc("patient_deleted_payments", { p_clinic_id: CLINIC });
        return error ? null : (data as Array<{ payment_id: string }>).map((r) => r.payment_id);
      };
      expect(await ids(service)).toContain(deletedPayment);
      expect(await ids(as("dentist"))).toContain(deletedPayment);
      for (const role of ["receptionist", "patient", "other_dentist"] as const) {
        expect({ role, rows: (await ids(as(role)))?.length ?? 0 }).toEqual({ role, rows: 0 });
      }
      const anon = createClient<Database>(URL, ANON_KEY, options) as any;
      expect(await ids(anon)).toBeNull();
    });

    it("returns only records deleted with their patient, and never a patient id", async () => {
      const { data } = await as("dentist").rpc("patient_deleted_payments", { p_clinic_id: CLINIC });
      const rows = data as Array<Record<string, unknown>>;
      expect(rows.map((r) => r.payment_id)).not.toContain(manualPayment);
      expect(Object.keys(rows[0]).sort()).toEqual(["amount", "payment_date", "payment_id"]);
      const { data: tx } = await as("dentist").rpc("patient_deleted_treatments", { p_clinic_id: CLINIC });
      expect((tx as Array<{ treatment_id: string }>).map((r) => r.treatment_id)).toContain(deletedTreatment);
      expect(Object.keys((tx as Array<Record<string, unknown>>)[0])).not.toContain("patient_id");
    });

    it("answers as known at a moment: nothing before the record existed", async () => {
      const { data } = await as("dentist").rpc("patient_deleted_payments", { p_clinic_id: CLINIC, p_known_at: "2020-01-01T00:00:00.000Z" });
      expect(data).toEqual([]);
    });

    it("no signed-in session can set or change the cause, and the cause needs a deletion", async () => {
      const fu = await followUp();
      await as("dentist").from("follow_ups").update({ deletion_cause: "patient_deleted" }).eq("id", fu.id);
      expect((await read("follow_ups", fu.id)).deletion_cause).toBeNull();
      const { error } = await raw.from("follow_ups").update({ deletion_cause: "patient_deleted" }).eq("id", fu.id);
      expect(error?.message ?? "").toMatch(/chk_follow_ups_deletion_cause/);
    });

    it("the metrics snapshot keeps the money and the work, and none of the debt", async () => {
      const { SupabaseMetricsDataRepository } = await import("@/lib/business-brain/metrics-repository");
      const repo = new SupabaseMetricsDataRepository(as("dentist"), { asOf: "2026-07-01T12:00:00.000Z" });
      const s = await repo.getClinicSnapshot(CLINIC, "2026-07-01");
      expect(s.payments.find((p) => p.id === deletedPayment)).toMatchObject({ amount: 1500, patientDeleted: true });
      expect(s.payments.find((p) => p.id === manualPayment)).toBeUndefined();
      const tx = s.treatments.find((t) => t.id === deletedTreatment);
      expect(tx).toMatchObject({ cost: 3000, status: "completed", patientDeleted: true });
      expect(tx).not.toHaveProperty("patientId");
    });
  });

  // ── F19: reminder subject ───────────────────────────────────────────────────
  describe("reminder subject", () => {
    it("is resolved from the send-list populations through the staff session", async () => {
      const { resolveReminderSubject } = await import("@/lib/messaging/reminder-subject");
      const p = await insertOne("patients", { clinic_id: CLINIC, name: "Reminded" });
      const older = await followUp({ patient_id: p.id, due_date: "2026-08-01" });
      await followUp({ patient_id: p.id, due_date: "2026-08-05" });
      await followUp({ patient_id: p.id, due_date: "2026-12-01" });
      const appt = await appointment({ patient_id: p.id, status: "completed" });
      await insertOne("treatments", { clinic_id: CLINIC, patient_id: p.id, appointment_id: appt.id, treatment_type: "Crown", cost: 2000, status: "planned", created_at: "2026-08-01T00:00:00Z" });
      const newest = await insertOne("treatments", { clinic_id: CLINIC, patient_id: p.id, appointment_id: appt.id, treatment_type: "Implant", cost: 9000, status: "planned", created_at: "2026-08-02T00:00:00Z" });
      await insertOne("treatments", { clinic_id: CLINIC, patient_id: p.id, appointment_id: appt.id, treatment_type: "Filling", cost: 700, status: "completed", performed_at: "2026-08-02T05:00:00Z" });

      const receptionist = as("receptionist");
      const params = { clinicId: CLINIC, patientId: p.id, today: "2026-09-14" };
      expect(await resolveReminderSubject(receptionist, { ...params, kind: "recall_invitation" })).toEqual({ subject_follow_up_id: older.id, subject_treatment_id: null, subject_amount: null });
      expect(await resolveReminderSubject(receptionist, { ...params, kind: "treatment_plan_follow_up" })).toEqual({ subject_follow_up_id: null, subject_treatment_id: newest.id, subject_amount: null });
      expect(await resolveReminderSubject(receptionist, { ...params, kind: "payment_reminder" })).toEqual({ subject_follow_up_id: null, subject_treatment_id: null, subject_amount: 700 });

      const nobody = await insertOne("patients", { clinic_id: CLINIC, name: "Nothing owed" });
      expect(await resolveReminderSubject(receptionist, { ...params, patientId: nobody.id, kind: "payment_reminder" })).toMatchObject({ subject_amount: null });
      expect(await resolveReminderSubject(receptionist, { ...params, patientId: nobody.id, kind: "recall_invitation" })).toMatchObject({ subject_follow_up_id: null });
    });

    it("a subject must belong to the patient and fit the reminder's kind", async () => {
      const p = await insertOne("patients", { clinic_id: CLINIC, name: "Subject owner" });
      const other = await insertOne("patients", { clinic_id: CLINIC, name: "Someone else's follow-up" });
      const foreign = await followUp({ patient_id: other.id });
      const own = await followUp({ patient_id: p.id });
      const log = (values: Record<string, unknown>) =>
        as("receptionist").from("reminder_logs").insert({ clinic_id: CLINIC, patient_id: p.id, sent_by: USERS.receptionist.id, ...values });
      expect((await log({ kind: "recall_invitation", subject_follow_up_id: foreign.id })).error).not.toBeNull();
      expect((await log({ kind: "payment_reminder", subject_follow_up_id: own.id })).error).not.toBeNull();
      expect((await log({ kind: "payment_reminder", subject_amount: -5 })).error).not.toBeNull();
      expect((await log({ kind: "recall_invitation", subject_follow_up_id: own.id })).error).toBeNull();
    });
  });

  // ── F6 / F7 / F16 / F17 / F20 / F21: what records are evidence of ───────────
  describe("record evidence on the real stack", () => {
    // Seeded in the other clinic, in October, so no earlier case shares the window.
    const C2 = OTHER_CLINIC;
    let P2 = "";
    const at = (iso: string) => ({
      clinic_id: C2, patient_id: P2, dentist_id: USERS.other_dentist.id, scheduled_at: iso, duration_minutes: 30, source: "phone_call",
    });
    const history = (appointmentId: string, status: string, performedBy: string | null) =>
      raw.from("appointment_history").insert({
        appointment_id: appointmentId, action: status === "cancelled" ? "cancelled" : "status_changed",
        old_value: { status: "scheduled" }, new_value: { status }, performed_by: performedBy,
      });

    const ids: Record<string, string> = {};

    beforeAll(async () => {
      P2 = (await insertOne("patients", { clinic_id: C2, name: "Evidence" })).id;
      await insertOne("unavailable_dates", { clinic_id: C2, date: "2026-10-07" });
      ids.patientCancel = (await insertOne("appointments", { ...at("2026-10-05T04:30:00.000Z"), status: "cancelled" })).id;
      ids.clinicCancel = (await insertOne("appointments", { ...at("2026-10-07T04:30:00.000Z"), status: "cancelled" })).id;
      ids.staffCancel = (await insertOne("appointments", { ...at("2026-10-08T04:30:00.000Z"), status: "cancelled" })).id;
      ids.inferredNoShow = (await insertOne("appointments", { ...at("2026-10-09T04:30:00.000Z"), status: "no_show" })).id;
      ids.recordedNoShow = (await insertOne("appointments", { ...at("2026-10-12T04:30:00.000Z"), status: "no_show" })).id;
      await history(ids.patientCancel, "cancelled", USERS.patient.id);
      await history(ids.clinicCancel, "cancelled", USERS.other_dentist.id);
      await history(ids.staffCancel, "cancelled", USERS.other_dentist.id);
      await history(ids.inferredNoShow, "no_show", null);
      await history(ids.recordedNoShow, "no_show", USERS.other_dentist.id);

      ids.clicked = (await insertOne("appointments", { ...at("2026-10-13T04:30:00.000Z"), status: "completed" })).id;
      ids.real = (await insertOne("appointments", { ...at("2026-10-14T04:30:00.000Z"), status: "completed" })).id;
      await insertOne("queue_entries", { clinic_id: C2, appointment_id: ids.clicked, patient_id: P2, position: 1, status: "completed", queue_date: "2026-10-13", checked_in_at: "2026-10-20T09:00:00.000Z", completed_at: "2026-10-20T09:00:02.000Z" });
      await insertOne("queue_entries", { clinic_id: C2, appointment_id: ids.real, patient_id: P2, position: 1, status: "completed", queue_date: "2026-10-14", checked_in_at: "2026-10-14T04:20:00.000Z", called_at: "2026-10-14T04:35:00.000Z", completed_at: "2026-10-14T05:05:00.000Z" });
    });

    it("the history stamps the actor's role, and none for a system change", async () => {
      const { data } = await raw.from("appointment_history").select("appointment_id, performed_by_role").in("appointment_id", [ids.patientCancel, ids.staffCancel, ids.inferredNoShow]);
      const role = (id: string) => (data as Array<{ appointment_id: string; performed_by_role: string | null }>).find((r) => r.appointment_id === id)?.performed_by_role;
      expect(role(ids.patientCancel)).toBe("patient");
      expect(role(ids.staffCancel)).toBe("dentist");
      expect(role(ids.inferredNoShow)).toBeNull();
    });

    it("cancellations carry their side and no-shows their basis, read through the dentist's session", async () => {
      const { SupabaseDiagnosisContext } = await import("@/lib/business-brain/diagnosis-context");
      const ctx = new SupabaseDiagnosisContext(as("other_dentist"), "Asia/Kolkata");
      const events = (await ctx.listCancellationEvents({ clinicId: C2, from: "2026-10-01", to: "2026-10-31", limit: 500 })) ?? [];
      const byId = new Map(events.map((e) => [e.appointmentId, e]));
      expect(byId.get(ids.patientCancel)).toMatchObject({ outcome: "cancelled", side: "patient" });
      expect(byId.get(ids.clinicCancel)).toMatchObject({ outcome: "cancelled", side: "clinic" });
      expect(byId.get(ids.staffCancel)).toMatchObject({ outcome: "cancelled", side: "unknown" });
      expect(byId.get(ids.inferredNoShow)).toMatchObject({ outcome: "no_show", noShowBasis: "inferred" });
      expect(byId.get(ids.recordedNoShow)).toMatchObject({ outcome: "no_show", noShowBasis: "recorded" });
      expect(byId.get(ids.inferredNoShow)).not.toHaveProperty("side");
    });

    it("a clicked-through visit records no arrival; a real one keeps its arrival", async () => {
      const { SupabaseDiagnosisContext } = await import("@/lib/business-brain/diagnosis-context");
      const ctx = new SupabaseDiagnosisContext(as("other_dentist"), "Asia/Kolkata");
      const rows = (await ctx.listAppointmentArrivals({ clinicId: C2, from: "2026-10-13", to: "2026-10-14", limit: 500 })) ?? [];
      expect(rows.find((r) => r.appointmentId === ids.clicked)).toMatchObject({ arrivedAt: null, arrivalDeltaMinutes: null, actualMinutes: null });
      expect(rows.find((r) => r.appointmentId === ids.real)).toMatchObject({ arrivalDeltaMinutes: -10, actualMinutes: 30 });
    });

    it("a completed treatment with no performed_at is dated by its recorded completion, labelled as such", async () => {
      const appt = await insertOne("appointments", { ...at("2026-10-15T04:30:00.000Z"), status: "completed" });
      const t = await insertOne("treatments", { clinic_id: C2, patient_id: P2, appointment_id: appt.id, treatment_type: "root canal", cost: 4000, status: "planned" });
      await raw.from("treatments").update({ status: "completed" }).eq("id", t.id);
      const { SupabaseDiagnosisContext } = await import("@/lib/business-brain/diagnosis-context");
      const ctx = new SupabaseDiagnosisContext(as("other_dentist"), "UTC");
      const today = new Date().toISOString().slice(0, 10);
      const rows = (await ctx.listCompletedTreatments({ clinicId: C2, from: today, to: today, limit: 500 })) ?? [];
      expect(rows.find((r) => r.treatmentId === t.id)).toMatchObject({ date: today, dateBasis: "recorded", treatmentType: "Root Canal" });
      // Not in a window before its completion was recorded.
      const earlier = (await ctx.listCompletedTreatments({ clinicId: C2, from: "2026-10-15", to: "2026-10-15", limit: 500 })) ?? [];
      expect(earlier.find((r) => r.treatmentId === t.id)).toBeUndefined();
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
