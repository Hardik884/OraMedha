/**
 * Point-in-time history against the LOCAL Supabase stack. Skips, loudly, when it
 * is not reachable.
 *
 * Everything here is RECORDED as the test runs, by the database's own triggers,
 * so "known at T" is measured against real recording times rather than seeded
 * ones. Every moment T is read back from the database, never from this process's
 * clock, which may disagree with the database's by seconds.
 *
 *   A  a later cancellation does not reach an earlier observation
 *   B  late recording: effective earlier, known only once recorded
 *   C  a later payment does not rewrite an earlier balance
 *   D  a recomputation never takes the place of a reading measured at the time
 *   E  two payments from one target count once
 *   G  one clinic's history answers nothing about another's
 *   H  a later soft delete does not remove a record from an earlier moment
 *   I  a follow-up closed without an attended visit is a staff declaration
 *   J  a moment before capture began is read from current records, and says so
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { CompletionSource, DentGrowMetricsEngine, MetricKey, type ActionCompletionRecord } from "@/business-brain";
import type { Database } from "@/types/database.types";
import { verifyCompletions } from "../action-outcomes";
import { SupabaseMetricsDataRepository } from "../metrics-repository";
import { recordRecomputedHistory } from "../persist-metrics";

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
if (!LOCAL_UP) console.warn(`\n[point-in-time] SKIPPED — local Supabase not reachable at ${URL}.\n`);

const options = { auth: { persistSession: false, autoRefreshToken: false } };
const db: SupabaseClient<Database> = createClient<Database>(URL, KEY, options);
/* eslint-disable @typescript-eslint/no-explicit-any */
const raw = db as any;

const CLINIC = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const DENTIST = "7e2b0000-0000-4000-8000-0000000000d1";
const DENTIST_EMAIL = "pit-dentist@test.local";
const P = Array.from({ length: 6 }, () => crypto.randomUUID());
const FAR_FUTURE = "2100-01-01T00:00:00.000Z";

async function insert(table: string, values: unknown): Promise<any[]> {
  const { data, error } = await raw.from(table).insert(values).select();
  if (error) throw new Error(`seed ${table}: ${error.message}`);
  return data;
}

async function update(table: string, id: string, values: unknown) {
  const { error } = await raw.from(table).update(values).eq("id", id);
  if (error) throw new Error(`update ${table}: ${error.message}`);
}

/** The latest recording moment for one record, from the database's own clock. */
async function recordedAt(table: string, column: string, id: string): Promise<string> {
  const { data, error } = await raw.from(table).select("recorded_at, seq").eq(column, id).order("seq", { ascending: false }).limit(1);
  if (error || data.length === 0) throw new Error(`no history in ${table} for ${id}`);
  return data[0].recorded_at as string;
}

const pause = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
/** The UTC business date of a moment: the test clinic runs on UTC. */
const dayOf = (iso: string) => iso.slice(0, 10);
const plusMs = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

function repository(client: SupabaseClient<Database>, asOf?: string) {
  return new SupabaseMetricsDataRepository(client, asOf === undefined ? {} : { asOf, now: FAR_FUTURE });
}

async function metricAt(key: MetricKey, date: string, asOf?: string, client: SupabaseClient<Database> = db): Promise<number | undefined> {
  const { metrics } = await new DentGrowMetricsEngine(repository(client, asOf)).measureDay(CLINIC, date);
  return metrics.find((m) => m.id.startsWith(`${key}:`))?.value;
}

let appointmentSeq = 0;
/** Slots unique to this run: the test dentist is reused, and a dentist cannot be double-booked. */
const RUN_OFFSET_MS = Math.floor(Math.random() * 3_000_000);
function appointment(patient: string, day: string, status = "scheduled") {
  appointmentSeq += 1;
  return {
    clinic_id: CLINIC,
    patient_id: patient,
    dentist_id: DENTIST,
    scheduled_at: new Date(Date.parse(`${day}T08:00:00.000Z`) + RUN_OFFSET_MS + appointmentSeq * 3_600_000).toISOString(),
    duration_minutes: 30,
    source: "phone_call",
    status,
  };
}

let today: string;

beforeAll(async () => {
  if (!LOCAL_UP) return;
  const { error: userError } = await raw.auth.admin.createUser({ id: DENTIST, email: DENTIST_EMAIL, password: "password123", email_confirm: true });
  if (userError && !/already/i.test(userError.message)) throw new Error(userError.message);
  await insert("clinics", [
    { id: CLINIC, name: "Point in time" },
    { id: OTHER, name: "Point in time (other)" },
  ]);
  await insert("clinic_settings", [
    { clinic_id: CLINIC, clinic_name: "PIT", timezone: "UTC", average_appointment_duration: 30, chair_count: 1 },
    { clinic_id: OTHER, clinic_name: "PIT other", timezone: "UTC", average_appointment_duration: 30, chair_count: 1 },
  ]);
  const { error: profileError } = await raw.from("profiles").upsert({ id: DENTIST, clinic_id: CLINIC, full_name: "PIT Dentist", role: "dentist" });
  if (profileError) throw new Error(profileError.message);
  await insert("patients", P.map((id, i) => ({ id, clinic_id: CLINIC, name: `PIT ${i}` })));
  today = dayOf(await recordedAt("patient_state_history", "patient_id", P[0]));
}, 60_000);

describe.skipIf(!LOCAL_UP)("point-in-time history on real rows", { shuffle: false }, () => {
  it("captures every change with the database's recording time, and no one can rewrite it", async () => {
    const [appt] = await insert("appointments", appointment(P[0], today));
    await pause();
    await update("appointments", appt.id, { status: "checked_in" });
    const { data } = await raw.from("appointment_status_history").select("change, old_status, new_status, provenance, effective_at_basis, recorded_at, effective_at").eq("appointment_id", appt.id).order("seq");
    expect(data.map((r: any) => [r.change, r.old_status, r.new_status, r.provenance, r.effective_at_basis])).toEqual([
      ["created", null, "scheduled", "observed", "recorded"],
      ["status_changed", "scheduled", "checked_in", "observed", "recorded"],
    ]);
    expect(data.every((r: any) => r.effective_at === r.recorded_at)).toBe(true);
    // An edit that changes nothing tracked records nothing.
    await update("appointments", appt.id, { notes: "running late" });
    const { count } = await raw.from("appointment_status_history").select("id", { count: "exact", head: true }).eq("appointment_id", appt.id);
    expect(count).toBe(2);
    // Refused twice over: no role holds a write grant, and the trigger would refuse anyway.
    const { error } = await raw.from("appointment_status_history").update({ new_status: "completed" }).eq("appointment_id", appt.id);
    expect(error?.message).toMatch(/permission denied|append-only/);
    const { error: forged } = await raw.from("appointment_status_history").insert({ ...data[0], appointment_id: appt.id, clinic_id: CLINIC });
    expect(forged).not.toBeNull();
  });

  it("A: a cancellation recorded later does not reach an observation made before it", async () => {
    const [appt] = await insert("appointments", appointment(P[1], today));
    const t1 = await recordedAt("appointment_status_history", "appointment_id", appt.id);
    const before = await metricAt(MetricKey.APPOINTMENTS_CANCELLED_TODAY, today, t1);
    await pause();
    await update("appointments", appt.id, { status: "cancelled" });

    const snapshot = await repository(db, t1).getClinicSnapshot(CLINIC, today);
    expect(snapshot.knowledge).toEqual({ mode: "point_in_time", knownAt: t1 });
    expect(snapshot.appointmentsToday.find((a) => a.id === appt.id)?.status).toBe("scheduled");
    expect(await metricAt(MetricKey.APPOINTMENTS_CANCELLED_TODAY, today, t1)).toBe(before);
    // The present sees the cancellation.
    const now = await repository(db).getClinicSnapshot(CLINIC, today);
    expect(now.knowledge?.mode).toBe("current_state");
    expect(now.appointmentsToday.find((a) => a.id === appt.id)?.status).toBe("cancelled");
    // A dentist's own session under RLS answers the same moment the same way.
    const session = createClient<Database>(URL, ANON_KEY, options);
    await session.auth.signInWithPassword({ email: DENTIST_EMAIL, password: "password123" });
    expect((await repository(session, t1).getClinicSnapshot(CLINIC, today)).appointmentsToday).toEqual(snapshot.appointmentsToday);
    await session.auth.signOut();
  });

  it("B: work performed earlier but keyed in later is dated earlier and known only once recorded", async () => {
    const [anchor] = await insert("appointments", appointment(P[2], today, "completed"));
    const beforeRecording = await recordedAt("appointment_status_history", "appointment_id", anchor.id);
    await pause();
    const performed = `${today}T00:05:00.000Z`;
    const [treatment] = await insert("treatments", {
      clinic_id: CLINIC,
      patient_id: P[2],
      appointment_id: anchor.id,
      treatment_type: "Filling",
      cost: 2500,
      status: "completed",
      performed_at: performed,
    });
    const { data } = await raw.from("treatment_status_history").select("effective_at, effective_at_basis, recorded_at").eq("treatment_id", treatment.id);
    expect(data[0]).toMatchObject({ effective_at_basis: "performed_at" });
    expect(Date.parse(data[0].effective_at)).toBe(Date.parse(performed));
    expect(Date.parse(data[0].recorded_at)).toBeGreaterThan(Date.parse(data[0].effective_at));

    const [payment] = await insert("payments", { clinic_id: CLINIC, patient_id: P[2], amount: 500, method: "cash", payment_date: "2026-01-02" });
    const { data: paid } = await raw.from("payment_state_history").select("effective_at, effective_at_basis").eq("payment_id", payment.id);
    expect(paid[0].effective_at_basis).toBe("payment_date");
    expect(Date.parse(paid[0].effective_at)).toBe(Date.parse("2026-01-02T00:00:00.000Z"));

    const early = await raw.rpc("treatment_states_as_of", { p_clinic_id: CLINIC, p_known_at: beforeRecording });
    expect(early.data.some((t: any) => t.treatment_id === treatment.id)).toBe(false);
    const late = await raw.rpc("treatment_states_as_of", { p_clinic_id: CLINIC, p_known_at: FAR_FUTURE });
    expect(late.data.find((t: any) => t.treatment_id === treatment.id)?.status).toBe("completed");
  });

  it("C: a payment recorded later does not rewrite an earlier outstanding balance", async () => {
    const [anchor] = await insert("appointments", appointment(P[3], today, "completed"));
    await insert("treatments", {
      clinic_id: CLINIC,
      patient_id: P[3],
      appointment_id: anchor.id,
      treatment_type: "Crown",
      cost: 10000,
      status: "completed",
      performed_at: `${today}T00:10:00.000Z`,
    });
    await pause();
    const [probe] = await insert("follow_ups", { clinic_id: CLINIC, patient_id: P[3], due_date: today, status: "pending" });
    const t = await recordedAt("follow_up_status_history", "follow_up_id", probe.id);
    const before = await metricAt(MetricKey.REVENUE_OUTSTANDING, today, t);
    await pause();
    // Keyed in later, dated today: it was not on the books at t.
    await insert("payments", { clinic_id: CLINIC, patient_id: P[3], amount: 4000, method: "upi", payment_date: today });
    expect(await metricAt(MetricKey.REVENUE_OUTSTANDING, today, t)).toBe(before);
    expect(await metricAt(MetricKey.REVENUE_OUTSTANDING, today)).toBe((before as number) - 4000);

    // And a follow-up completed later does not make an earlier overdue count disappear.
    const pendingAtT = await metricAt(MetricKey.FOLLOWUPS_DUE_TODAY, today, t);
    await update("follow_ups", probe.id, { status: "completed" });
    expect(await metricAt(MetricKey.FOLLOWUPS_DUE_TODAY, today, t)).toBe(pendingAtT);
    expect(await metricAt(MetricKey.FOLLOWUPS_DUE_TODAY, today)).toBe((pendingAtT as number) - 1);
  });

  it("H: a soft delete recorded later leaves the record in place at an earlier moment", async () => {
    const [appt] = await insert("appointments", appointment(P[4], today));
    const t = await recordedAt("appointment_status_history", "appointment_id", appt.id);
    await pause();
    await update("appointments", appt.id, { deleted_at: new Date().toISOString() });
    expect((await repository(db, t).getClinicSnapshot(CLINIC, today)).appointmentsToday.some((a) => a.id === appt.id)).toBe(true);
    expect((await repository(db).getClinicSnapshot(CLINIC, today)).appointmentsToday.some((a) => a.id === appt.id)).toBe(false);
  });

  it("E and I: results count once per patient, and a closure with no attended visit is only a declaration", async () => {
    const [marker] = await insert("follow_ups", { clinic_id: CLINIC, patient_id: P[5], due_date: today, status: "pending" });
    const since = await recordedAt("follow_up_status_history", "follow_up_id", marker.id);
    await pause();

    // Revenue: two payments from one target.
    await insert("payments", [
      { clinic_id: CLINIC, patient_id: P[5], amount: 100, method: "cash", payment_date: today },
      { clinic_id: CLINIC, patient_id: P[5], amount: 200, method: "cash", payment_date: today },
    ]);
    // Retention: P[5] closes a follow-up with no visit; P[4] closes one after an attended visit.
    await update("follow_ups", marker.id, { status: "completed" });
    const [visit] = await insert("appointments", appointment(P[4], today));
    await update("appointments", visit.id, { status: "completed" });
    const [closed] = await insert("follow_ups", { clinic_id: CLINIC, patient_id: P[4], due_date: today, status: "pending" });
    await update("follow_ups", closed.id, { status: "completed" });

    const completion = (id: string, category: string, targets: string[]): ActionCompletionRecord => ({
      id,
      category,
      constraintId: `constraint.${category}:${CLINIC}:${today}`,
      completedAt: since,
      source: CompletionSource.DECLARED,
      targetPatientIds: targets,
    });
    const verified = await verifyCompletions(db, CLINIC, [completion("rev", "revenue_leakage", [P[5]]), completion("ret", "retention", [P[4], P[5]])], FAR_FUTURE);
    expect(verified.get("rev")).toMatchObject({ resolvable: 1, confirmed: 1, observed: 1, timing: "point_in_time" });
    expect(verified.get("ret")).toMatchObject({ resolvable: 2, confirmed: 2, observed: 1, timing: "point_in_time" });

    // Nothing recorded after the moment asked about confirms anything.
    const atSince = await verifyCompletions(db, CLINIC, [completion("rev", "revenue_leakage", [P[5]])], since);
    expect(atSince.get("rev")).toMatchObject({ confirmed: 0, observed: 0 });
  });

  it("G: one clinic's point-in-time readers answer nothing about another's records", async () => {
    for (const fn of ["appointment_states_as_of", "treatment_states_as_of", "payment_states_as_of", "patient_states_as_of", "follow_up_states_as_of"]) {
      const { data, error } = await raw.rpc(fn, { p_clinic_id: OTHER, p_known_at: FAR_FUTURE });
      expect({ fn, error, rows: data.length }).toEqual({ fn, error: null, rows: 0 });
    }
    const { data } = await raw.rpc("action_result_events", { p_clinic_id: OTHER, p_target: "payment_recorded", p_patient_ids: P, p_since: "2000-01-01T00:00:00Z", p_known_at: FAR_FUTURE });
    expect(data).toEqual([]);
  });

  it("J: a moment before history capture began is read from current records, and the reading says it was recomputed", async () => {
    const snapshot = await repository(db, "2026-01-10T12:00:00.000Z").getClinicSnapshot(CLINIC, "2026-01-10");
    expect(snapshot.knowledge).toMatchObject({ mode: "current_state", reason: "before_history_capture" });
    const { metrics, knowledge } = await new DentGrowMetricsEngine(repository(db, "2026-01-10T12:00:00.000Z")).measureDay(CLINIC, "2026-01-10");
    await recordRecomputedHistory(CLINIC, [{ date: "2026-01-10", metrics, knowledge, timezone: "UTC" }], db);
    const { data } = await raw.from("metric_history").select("provenance, knowledge_as_of, produced_at").eq("clinic_id", CLINIC).eq("metric_date", "2026-01-10");
    expect(data.length).toBeGreaterThan(0);
    expect(new Set(data.map((r: any) => r.provenance))).toEqual(new Set(["recomputed_later"]));
  });

  it("D: a later recomputation is kept beside a reading measured at the time, never in its place", async () => {
    const day = "2026-09-01";
    const row = (value: number, provenance: string, producedAt: string, knowledgeAsOf: string) => ({
      clinic_id: CLINIC,
      metric_date: day,
      metric_key: MetricKey.FOLLOWUPS_OVERDUE,
      value,
      measured_at: "2026-09-01T23:59:59.999Z",
      provenance,
      produced_at: producedAt,
      knowledge_as_of: knowledgeAsOf,
      unversioned_inputs: [],
    });
    const upsert = (r: unknown) => raw.from("metric_history").upsert(r, { onConflict: "clinic_id,metric_date,metric_key" });
    expect((await upsert(row(12, "observed_at_time", "2026-09-02T00:30:00.000Z", "2026-09-01T23:59:59.999Z"))).error).toBeNull();
    const nowIso = new Date().toISOString();
    expect((await upsert(row(9, "recomputed_later", nowIso, nowIso))).error).toBeNull();
    const current = await raw.from("metric_history").select("value, provenance").eq("clinic_id", CLINIC).eq("metric_date", day).single();
    expect(current.data).toEqual({ value: 12, provenance: "observed_at_time" });
    const versions = await raw.from("metric_observations").select("value, provenance, applied_to_current").eq("clinic_id", CLINIC).eq("metric_date", day).order("seq");
    expect(versions.data).toEqual([
      { value: 12, provenance: "observed_at_time", applied_to_current: true },
      { value: 9, provenance: "recomputed_later", applied_to_current: false },
    ]);

    // Provenance a writer cannot claim.
    const claims: [string, ReturnType<typeof row>][] = [
      ["measured the next afternoon", row(1, "observed_at_time", "2026-09-02T15:00:00.000Z", "2026-09-01T23:59:59.999Z")],
      ["knowing the next day", row(1, "point_in_time_reconstruction", nowIso, "2026-09-02T08:00:00.000Z")],
      ["produced in the future", row(1, "recomputed_later", "2099-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z")],
      ["with no production moment", { ...row(1, "recomputed_later", nowIso, nowIso), produced_at: null } as never],
    ];
    for (const [label, claim] of claims) {
      const { error } = await upsert({ ...claim, metric_date: "2026-08-15" });
      expect({ label, refused: error !== null }).toEqual({ label, refused: true });
    }
    const { error } = await raw.from("metric_observations").delete().eq("clinic_id", CLINIC);
    expect(error?.message).toMatch(/permission denied|retention purge/);
  });

  it("stamps a client's snooze with the database clock and refuses a completion dated after its recording", async () => {
    const session = createClient<Database>(URL, ANON_KEY, options);
    await session.auth.signInWithPassword({ email: DENTIST_EMAIL, password: "password123" });
    const { data, error } = await (session as any)
      .from("problem_dismissals")
      .insert({ clinic_id: CLINIC, category: "retention", severity_at_dismissal: "high", reason: "Handled", expires_at: FAR_FUTURE, dismissed_by: DENTIST, created_at: "2020-01-01T00:00:00.000Z" })
      .select("created_at")
      .single();
    expect(error).toBeNull();
    expect(Date.parse(data.created_at)).toBeGreaterThan(Date.parse("2026-01-01T00:00:00.000Z"));
    await session.auth.signOut();

    const { error: future } = await raw.from("action_completions").insert({
      clinic_id: CLINIC,
      category: "retention",
      constraint_id: `constraint.retention:${CLINIC}:${today}`,
      source: "declared",
      completed_by: DENTIST,
      completed_at: plusMs(new Date().toISOString(), 3_600_000 * 24),
    });
    expect(future?.message ?? "").toMatch(/declared_not_after_recording|violates check/);
  });
});
