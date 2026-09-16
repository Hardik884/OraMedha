/**
 * Opportunity Engine v1 against the LOCAL Supabase stack. Skips, loudly, when it
 * is not reachable.
 *
 * Proven against real rows, in an Asia/Kolkata clinic so every clinic-local hour
 * has to survive conversion:
 *
 *   - the capacity window agrees with `capacity.booked_next_7d` and the open-work
 *     balances agree with `revenue.outstanding` — two routes, one number
 *   - open work is discovered from recorded facts only, excludes soft-deleted
 *     patients and other clinics, and carries consent and phone reachability
 *   - the full service run detects exactly the three opportunities the rows
 *     support, with the numbers a pencil gives
 *   - the same holds on a signed-in dentist's session under RLS
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BusinessBrain,
  buildLedgerGraph,
  DentGrowMetricsEngine,
  MetricKey,
  OpportunityType,
  type Opportunity,
} from "@/business-brain";
import type { Database } from "@/types/database.types";
import { SupabaseClinicLedger } from "../clinic-ledger";
import { SupabaseMetricsDataRepository } from "../metrics-repository";

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
if (!LOCAL_UP) {
  console.warn(`\n[opportunities] SKIPPED — local Supabase not reachable at ${URL}.\n`);
}

const db: SupabaseClient<Database> = createClient<Database>(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
/* eslint-disable @typescript-eslint/no-explicit-any */
const raw = db as any;
async function insert(table: string, values: unknown) {
  const { error } = await raw.from(table).insert(values);
  if (error) throw new Error(`seed ${table}: ${error.message}`);
}
async function upsert(table: string, values: unknown) {
  const { error } = await raw.from(table).upsert(values);
  if (error) throw new Error(`seed ${table}: ${error.message}`);
}

/**
 * Soft-delete a fixed dentist's appointments left by earlier runs. Appointment
 * slots are unique per (dentist, start time) among live rows, and a reused
 * dentist would otherwise collide with its own previous run's fixtures. Earlier
 * runs' clinics are abandoned test data; nothing reads them.
 */
async function retirePreviousRuns(dentistIds: readonly string[]) {
  const { error } = await raw
    .from("appointments")
    .update({ deleted_at: new Date().toISOString() })
    .in("dentist_id", dentistIds as string[])
    .is("deleted_at", null);
  if (error) throw new Error(`retire previous runs: ${error.message}`);
}


const TZ = "Asia/Kolkata";
/** Monday. Tomorrow … +7 is Tue 6th to Mon 12th: five open weekdays. */
const D = "2026-10-05";
/** 09:00 in the clinic. */
const NOW = "2026-10-05T03:30:00.000Z";

const id = () => crypto.randomUUID();
const RUN = id().slice(0, 8);
const SECRET = `OPP-SECRET-${RUN}`;
const CLINIC_A = id();
const CLINIC_B = id();
/**
 * Auth users are FIXED per spec and reused across runs, not created per run.
 *
 * Each run's clinic is new (the append-only audit tables refuse a clinic delete),
 * and a dentist whose profile those rows reference cannot be deleted either — so
 * per-run users could never be cleaned up, and they accumulated until specs that
 * look users up on the first page of `auth.admin.listUsers()` stopped finding
 * theirs. A fixed user's profile is simply upserted onto the new clinic.
 */
const DENTIST_A = "0aa00000-0000-4000-8000-0000000000a1";
const DENTIST_B = "0aa00000-0000-4000-8000-0000000000b1";
const DENTIST_A_EMAIL = "opp-a@test.local";

const P_PLAN = id();
const P_RECALL = id();
const P_BOOKED = id();
const P_WITHDRAWN = id();
const P_NOPHONE = id();
const P_OWES = id();
const P_PLANPAY = id();
const P_DELETED = id();
const P_CANCELLER = id();
const PB = id();

const A_CONSULT = id();
const A_BOOKED = id();
const A_CANCELLED = id();
const AB_CONSULT = id();
const AB_CANCELLED = id();

async function seed() {
  for (const [uid, email] of [[DENTIST_A, DENTIST_A_EMAIL], [DENTIST_B, "opp-b@test.local"]] as const) {
    const { error } = await raw.auth.admin.createUser({ id: uid, email, password: "password123", email_confirm: true });
    if (error && !/already/i.test(error.message)) throw new Error(`seed user: ${error.message}`);
  }
  await insert("clinics", [{ id: CLINIC_A, name: "Opp Clinic A" }, { id: CLINIC_B, name: "Opp Clinic B" }]);
  await insert("clinic_settings", [CLINIC_A, CLINIC_B].map((clinic_id) => ({
    clinic_id, clinic_name: "Opp", timezone: TZ, average_appointment_duration: 30, chair_count: 1,
  })));
  await upsert("profiles", [
    { id: DENTIST_A, clinic_id: CLINIC_A, full_name: "Opp Dentist A", role: "dentist" },
    { id: DENTIST_B, clinic_id: CLINIC_B, full_name: "Opp Dentist B", role: "dentist" },
  ]);
  await retirePreviousRuns([DENTIST_A, DENTIST_B]);
  await insert("availability_rules", [CLINIC_A, CLINIC_B].flatMap((clinic_id) =>
    [1, 2, 3, 4, 5].map((day_of_week) => ({ clinic_id, day_of_week, start_time: "09:00", end_time: "13:00", slot_duration_minutes: 30, is_active: true })),
  ));

  const p = (pid: string, clinic: string, phone: string | null, extra: Record<string, unknown> = {}) => ({
    id: pid, clinic_id: clinic, name: `${SECRET} name`, notes: `${SECRET} notes`, phone,
    created_at: "2026-01-01T00:00:00.000Z", deleted_at: null, payment_plan_until: null, ...extra,
  });
  await insert("patients", [
    p(P_PLAN, CLINIC_A, "9990011101"),
    p(P_RECALL, CLINIC_A, "9990011102"),
    p(P_BOOKED, CLINIC_A, "9990011103"),
    p(P_WITHDRAWN, CLINIC_A, "9990011104"),
    p(P_NOPHONE, CLINIC_A, null),
    p(P_OWES, CLINIC_A, "9990011106"),
    p(P_PLANPAY, CLINIC_A, "9990011107", { payment_plan_until: "2026-12-31" }),
    p(P_DELETED, CLINIC_A, "9990011108", { deleted_at: "2026-09-20T00:00:00.000Z" }),
    p(P_CANCELLER, CLINIC_A, "9990011109"),
    p(PB, CLINIC_B, "9990011110"),
  ]);

  const appt = (aid: string, clinic: string, dentist: string, patient: string, at: string, status: string) => ({
    id: aid, clinic_id: clinic, patient_id: patient, dentist_id: dentist, scheduled_at: at,
    duration_minutes: 30, source: "phone_call", status, notes: `${SECRET} appt`, created_at: "2026-09-01T00:00:00.000Z",
  });
  await insert("appointments", [
    appt(A_CONSULT, CLINIC_A, DENTIST_A, P_OWES, "2026-09-01T04:30:00.000Z", "completed"),
    // Wed 7th 10:00 IST: books one gap, and puts P_BOOKED on the schedule.
    appt(A_BOOKED, CLINIC_A, DENTIST_A, P_BOOKED, "2026-10-07T04:30:00.000Z", "scheduled"),
    // Tue 6th 10:00 IST, cancelled: the freed slot.
    appt(A_CANCELLED, CLINIC_A, DENTIST_A, P_CANCELLER, "2026-10-06T04:30:00.000Z", "cancelled"),
    appt(AB_CONSULT, CLINIC_B, DENTIST_B, PB, "2026-09-01T04:30:00.000Z", "completed"),
    appt(AB_CANCELLED, CLINIC_B, DENTIST_B, PB, "2026-10-06T05:30:00.000Z", "cancelled"),
  ]);

  const t = (clinic: string, patient: string, status: string, cost: number, extra: Record<string, unknown> = {}) => ({
    id: id(), clinic_id: clinic, appointment_id: clinic === CLINIC_A ? A_CONSULT : AB_CONSULT, patient_id: patient,
    treatment_type: "Crown", status, cost, internal_notes: `${SECRET} internal`, patient_visible_notes: null,
    performed_at: status === "completed" ? "2026-09-01T05:00:00.000Z" : null, created_at: "2026-09-01T05:00:00.000Z",
    deleted_at: null, opd_charged: false, opd_fee: 0, xray_taken: false, xray_cost: 0, ...extra,
  });
  await insert("treatments", [
    t(CLINIC_A, P_PLAN, "planned", 22000),
    t(CLINIC_A, P_BOOKED, "planned", 4000),
    t(CLINIC_A, P_WITHDRAWN, "planned", 6000),
    t(CLINIC_A, P_OWES, "completed", 9000, { opd_charged: true, opd_fee: 300 }),
    t(CLINIC_A, P_PLANPAY, "completed", 5000),
    t(CLINIC_A, P_DELETED, "planned", 7000, { deleted_at: "2026-09-20T00:00:00.000Z" }),
    t(CLINIC_B, PB, "planned", 99000),
  ]);

  const f = (clinic: string, patient: string, due: string) => ({
    id: id(), clinic_id: clinic, patient_id: patient, due_date: due, status: "pending", notes: `${SECRET} fu`,
    created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z",
  });
  await insert("follow_ups", [f(CLINIC_A, P_RECALL, "2026-09-20"), f(CLINIC_A, P_NOPHONE, "2026-09-25"), f(CLINIC_B, PB, "2026-09-20")]);

  await insert("payments", [
    { id: id(), clinic_id: CLINIC_A, patient_id: P_OWES, amount: 2000, method: "upi", payment_date: "2026-09-02", notes: null, deleted_at: null },
  ]);

  await insert("data_consent_records", [{
    clinic_id: CLINIC_A, patient_id: P_WITHDRAWN, category: "communications", decision: "withdrawn",
    actor: "staff", recorded_by: DENTIST_A, recorded_by_role: "dentist", source: "spec",
    notice_version: 1, notice_snapshot: { text: "Communications about your care." },
  }]);
}

beforeAll(async () => {
  if (LOCAL_UP) await seed();
}, 60_000);

afterAll(async () => {
  if (!LOCAL_UP) return;
  // Users are fixed and reused; see the note on their ids.
}, 60_000);

const ledger = new SupabaseClinicLedger(db, TZ);

async function run(client: SupabaseClient<Database>) {
  const brain = new BusinessBrain({
    repository: new SupabaseMetricsDataRepository(client, { asOf: NOW }),
    ledgerPort: new SupabaseClinicLedger(client, TZ),
  });
  return brain.runBusinessBrain(CLINIC_A, D, { startedAt: NOW, opportunities: { now: NOW } });
}

const byType = (list: readonly Opportunity[], type: Opportunity["type"]) => list.filter((o) => o.type === type);

describe.skipIf(!LOCAL_UP)("ledger reads behind opportunities agree with the aggregate path", () => {
  it("publishes open time as clinic-local hours converted to instants", async () => {
    const window = await ledger.readCapacityWindow({ clinicId: CLINIC_A, from: D, to: "2026-10-12" });
    const tuesday = window.days.find((d) => d.date === "2026-10-06");
    expect(tuesday?.openSpans).toEqual([{ start: "2026-10-06T03:30:00.000Z", end: "2026-10-06T07:30:00.000Z" }]);
    expect(window.days.find((d) => d.date === "2026-10-10")?.openSpans).toEqual([]);
    expect(window).toMatchObject({ chairCount: 1, typicalAppointmentMinutes: 30, availabilityConfigured: true });
  });

  it("agrees with capacity.booked_next_7d on open and booked chair time", async () => {
    const metrics = await new DentGrowMetricsEngine(new SupabaseMetricsDataRepository(db, { asOf: NOW })).calculateMetrics(CLINIC_A, D);
    const metric = metrics.find((m) => m.id.startsWith(`${MetricKey.CAPACITY_BOOKED_NEXT_7D}:`))?.value;

    const window = await ledger.readCapacityWindow({ clinicId: CLINIC_A, from: "2026-10-06", to: "2026-10-12" });
    const open = window.days.reduce((s, d) => s + d.openMinutesPerChair, 0) * window.chairCount;
    const book = await ledger.readAppointmentWindow({ kind: "appointment_window", clinicId: CLINIC_A, from: "2026-10-06", to: "2026-10-12", asOf: NOW, limit: 500 });
    const booked = book.appointments.filter((a) => a.status !== "cancelled" && a.status !== "no_show").reduce((s, a) => s + a.durationMinutes, 0);

    expect(open).toBe(5 * 240);
    expect(metric).toBe(Math.round(Math.min(100, (booked / open) * 100) * 10) / 10);
  });

  it("agrees with revenue.outstanding on what is owed", async () => {
    const metrics = await new DentGrowMetricsEngine(new SupabaseMetricsDataRepository(db, { asOf: NOW })).calculateMetrics(CLINIC_A, D);
    const metric = metrics.find((m) => m.id.startsWith(`${MetricKey.REVENUE_OUTSTANDING}:`))?.value;
    const graph = buildLedgerGraph(await ledger.readOpenWorkLedger({ clinicId: CLINIC_A, asOf: NOW, maxPatients: 100, limit: 1000 }));
    let owed = 0;
    for (const patient of graph.slice.patients) {
      const t = graph.treatmentsOfPatient(patient.id);
      const p = graph.paymentsOfPatient(patient.id);
      if (t.status !== "known" || p.status !== "known") throw new Error("open-work patient not fully loaded");
      const charged = t.value.reduce((s, x) => s + x.charge.total, 0);
      if (charged > 0) owed += Math.max(0, charged - p.value.reduce((s, x) => s + x.amount, 0));
    }
    expect(owed).toBe(12300);
    expect(owed).toBe(metric);
  });

  it("discovers open work from recorded facts only, never deleted patients or another clinic", async () => {
    const slice = await ledger.readOpenWorkLedger({ clinicId: CLINIC_A, asOf: NOW, maxPatients: 100, limit: 1000 });
    expect(slice.patients.map((p) => p.id).sort()).toEqual([P_PLAN, P_RECALL, P_BOOKED, P_WITHDRAWN, P_NOPHONE, P_OWES, P_PLANPAY].sort());
    expect(slice.patients.every((p) => p.clinicId === CLINIC_A)).toBe(true);
    const byId = new Map(slice.patients.map((p) => [p.id, p]));
    expect(byId.get(P_WITHDRAWN)?.communicationsWithdrawn).toBe(true);
    expect(byId.get(P_NOPHONE)?.reachableByPhone).toBe(false);
    expect(byId.get(P_PLAN)).toMatchObject({ reachableByPhone: true, communicationsWithdrawn: false });
    expect(JSON.stringify(slice)).not.toContain(SECRET);
    expect(JSON.stringify(slice)).not.toContain("99900111");
  });

  it("reports a cut population instead of silently dropping it", async () => {
    const slice = await ledger.readOpenWorkLedger({ clinicId: CLINIC_A, asOf: NOW, maxPatients: 2, limit: 1000 });
    expect(slice.patients).toHaveLength(2);
    expect(slice.truncated).toContain("patient");
  });
});

describe.skipIf(!LOCAL_UP)("the full run detects what the rows support", () => {
  it("finds the forward match, the freed slot and the unpaid work — with pencil numbers", async () => {
    const result = await run(db);
    expect(result.opportunityAssessments.map((a) => [a.type, a.outcome])).toEqual([
      [OpportunityType.FORWARD_CAPACITY_MATCH, "detected"],
      [OpportunityType.FREED_SLOT_REFILL, "detected"],
      [OpportunityType.UNPAID_DELIVERED_WORK, "detected"],
    ]);

    const [forward] = byType(result.opportunities, OpportunityType.FORWARD_CAPACITY_MATCH);
    // 5 weekdays × 8 gaps, less Wednesday's one booked half-hour.
    expect(forward.surplus.measured[0].value).toBe(39);
    // P_PLAN and P_RECALL. Not P_BOOKED (booked), P_WITHDRAWN (consent), P_NOPHONE (no number), P_DELETED.
    expect(forward.entities.map((e) => e.id).sort()).toEqual([P_PLAN, P_RECALL].sort());
    expect(forward.measuredValue.value).toBe(2);
    expect(forward.impact?.amount.value).toBe(22000);

    const [freed] = byType(result.opportunities, OpportunityType.FREED_SLOT_REFILL);
    expect(freed.entities[0]).toMatchObject({ type: "appointment", id: A_CANCELLED });
    expect(freed.window.expiresAt).toBe("2026-10-06T02:30:00.000Z");
    expect(freed.overlapsWith).toEqual([forward.id]);

    const [unpaid] = byType(result.opportunities, OpportunityType.UNPAID_DELIVERED_WORK);
    // 9000 + 300 OPD − 2000; the payment-plan balance is reported, not chased.
    expect(unpaid.measuredValue.value).toBe(7300);
    expect(unpaid.entities.map((e) => e.id)).toEqual([P_OWES]);

    const text = JSON.stringify(result.opportunities);
    for (const foreign of [CLINIC_B, PB, AB_CANCELLED, P_DELETED]) expect(text).not.toContain(foreign);
    expect(text).not.toContain(SECRET);
  });

  it("detects the same under RLS on the dentist's own session", async () => {
    const client = createClient<Database>(URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await client.auth.signInWithPassword({ email: DENTIST_A_EMAIL, password: "password123" });
    if (error) throw new Error(`sign in: ${error.message}`);

    const asDentist = await run(client);
    const asService = await run(db);
    const summary = (r: typeof asDentist) => r.opportunities.map((o) => [o.type, o.measuredValue.value, o.entities.map((e) => e.id).sort()]);
    expect(summary(asDentist)).toEqual(summary(asService));
    await client.auth.signOut();
  });
});
