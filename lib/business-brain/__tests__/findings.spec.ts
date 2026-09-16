/**
 * Unified findings against the LOCAL Supabase stack. Skips, loudly, when it is
 * not reachable.
 *
 * The whole pipeline runs on real rows — metrics, signals, diagnoses,
 * constraints, the Opportunity Engine over the clinic ledger — and the findings
 * layer is checked on what it actually receives:
 *
 *   - every constraint and opportunity the run produced appears exactly once
 *   - an opportunity that measures a constraint collapses into it
 *   - wins never occupy the ranked places; every ranked place carries a reason
 *   - two clinics' runs never share a finding, and RLS changes nothing
 *   - the same run ranks the same way twice
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BusinessBrain, type BusinessBrainResult, type RankedFinding } from "@/business-brain";
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
if (!LOCAL_UP) console.warn(`\n[findings] SKIPPED — local Supabase not reachable at ${URL}.\n`);

const db: SupabaseClient<Database> = createClient<Database>(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
/* eslint-disable @typescript-eslint/no-explicit-any */
const raw = db as any;
async function insert(table: string, values: unknown) {
  const { error } = await raw.from(table).insert(values);
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
const D = "2026-10-05";
const NOW = "2026-10-05T03:30:00.000Z";
const id = () => crypto.randomUUID();
const RUN = id().slice(0, 8);

interface ClinicFixture {
  readonly clinic: string;
  readonly dentist: string;
  readonly email: string;
  readonly patients: readonly string[];
}

/**
 * Auth users are FIXED per spec and reused across runs, not created per run.
 *
 * Each run's clinic is new (the append-only audit tables refuse a clinic delete),
 * and a dentist whose profile those rows reference cannot be deleted either — so
 * per-run users could never be cleaned up, and they accumulated until specs that
 * look users up on the first page of `auth.admin.listUsers()` stopped finding
 * theirs. A fixed user's profile is simply upserted onto the new clinic.
 */
function fixture(label: "a" | "b"): ClinicFixture {
  return {
    clinic: id(),
    dentist: `f1d00000-0000-4000-8000-0000000000${label}1`,
    email: `findings-${label}@test.local`,
    patients: Array.from({ length: 6 }, id),
  };
}
const A = fixture("a");
const B = fixture("b");

/**
 * An empty coming week, planned treatment nobody has booked, overdue recalls and
 * an unpaid completed treatment: enough for real constraints and real
 * opportunities to form from the same rows.
 */
async function seedClinic(f: ClinicFixture) {
  const { error } = await raw.auth.admin.createUser({ id: f.dentist, email: f.email, password: "password123", email_confirm: true });
  if (error && !/already/i.test(error.message)) throw new Error(`seed user: ${error.message}`);
  await insert("clinics", { id: f.clinic, name: `Findings ${RUN}` });
  await insert("clinic_settings", { clinic_id: f.clinic, clinic_name: "Findings", timezone: TZ, average_appointment_duration: 30, chair_count: 1 });
  const { error: profileError } = await raw
    .from("profiles")
    .upsert({ id: f.dentist, clinic_id: f.clinic, full_name: "Findings Dentist", role: "dentist" });
  if (profileError) throw new Error(`seed profiles: ${profileError.message}`);
  await retirePreviousRuns([f.dentist]);
  await insert("availability_rules", [1, 2, 3, 4, 5].map((day_of_week) => ({
    clinic_id: f.clinic, day_of_week, start_time: "09:00", end_time: "17:00", slot_duration_minutes: 30, is_active: true,
  })));
  await insert("patients", f.patients.map((pid, i) => ({
    id: pid, clinic_id: f.clinic, name: `Findings ${i}`, phone: `99900200${String(i).padStart(2, "0")}`, created_at: "2026-01-01T00:00:00.000Z",
  })));
  const consult = id();
  await insert("appointments", {
    id: consult, clinic_id: f.clinic, patient_id: f.patients[0], dentist_id: f.dentist, scheduled_at: "2026-09-01T04:30:00.000Z",
    duration_minutes: 30, source: "phone_call", status: "completed", created_at: "2026-09-01T00:00:00.000Z",
  });
  const t = (patient: string, status: string, cost: number) => ({
    id: id(), clinic_id: f.clinic, appointment_id: consult, patient_id: patient, treatment_type: "Crown", status, cost,
    performed_at: status === "completed" ? "2026-09-01T05:00:00.000Z" : null, created_at: "2026-09-01T05:00:00.000Z",
    opd_charged: false, opd_fee: 0, xray_taken: false, xray_cost: 0,
  });
  await insert("treatments", [
    t(f.patients[0], "completed", 60000),
    t(f.patients[1], "planned", 25000),
    t(f.patients[2], "planned", 30000),
    t(f.patients[3], "planned", 18000),
  ]);
  await insert("follow_ups", [f.patients[4], f.patients[5]].map((patient) => ({
    id: id(), clinic_id: f.clinic, patient_id: patient, due_date: "2026-09-10", status: "pending", created_at: "2026-09-01T00:00:00.000Z",
  })));
}

async function run(client: SupabaseClient<Database>, clinic: string): Promise<BusinessBrainResult> {
  return new BusinessBrain({
    repository: new SupabaseMetricsDataRepository(client, { asOf: NOW }),
    ledgerPort: new SupabaseClinicLedger(client, TZ),
  }).runBusinessBrain(clinic, D, { startedAt: NOW, opportunities: { now: NOW } });
}

const all = (r: BusinessBrainResult): RankedFinding[] => [
  ...(r.findings.top ? [r.findings.top] : []),
  ...r.findings.next,
  ...r.findings.supporting,
  ...r.findings.wins,
  ...r.findings.noActionRequired,
];

beforeAll(async () => {
  if (!LOCAL_UP) return;
  await seedClinic(A);
  await seedClinic(B);
}, 60_000);

afterAll(async () => {
  if (!LOCAL_UP) return;
  // Users are fixed and reused; see the note on their ids.
}, 60_000);

describe.skipIf(!LOCAL_UP)("unified findings on a real pipeline run", () => {
  let result: BusinessBrainResult;
  beforeAll(async () => {
    result = await run(db, A.clinic);
  }, 60_000);

  it("forms real constraints and real opportunities from the same rows", () => {
    expect(result.constraints.map((c) => c.category)).toContain("forward_schedule");
    expect(result.opportunities.map((o) => o.type).sort()).toEqual(["forward_capacity_match", "unpaid_delivered_work"]);
  });

  it("accounts for every constraint and opportunity exactly once", () => {
    const sources = all(result).map((x) => x.finding.source.id);
    expect(new Set(sources).size).toBe(sources.length);
    expect(sources.sort()).toEqual(
      [...result.constraints.map((c) => c.id), ...result.opportunities.map((o) => o.id), ...result.achievements.map((a) => a.id)].sort(),
    );
  });

  it("collapses the capacity match into the next-week finding it measures", () => {
    const warning = all(result).find((x) => x.finding.category === "forward_schedule" && x.finding.source.producer === "constraint");
    const match = all(result).find((x) => x.finding.source.producer === "opportunity" && x.finding.kind === "opportunity" && x.finding.resource === "chair_time_ahead");
    expect(warning && match).toBeTruthy();
    const lead = warning?.supports === null ? warning : match;
    const member = lead === warning ? match : warning;
    expect(member?.supports).toBe(lead?.finding.id);
    expect(member?.role).toBe("supporting");
    expect([result.findings.top, ...result.findings.next].filter((x) => x?.finding.id === member?.finding.id)).toEqual([]);
  });

  it("keeps wins out of the ranked places and gives every ranked place a reason", () => {
    const ranked = [result.findings.top, ...result.findings.next].filter((x): x is RankedFinding => x !== null);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.every((x) => x.finding.polarity !== "positive")).toBe(true);
    ranked.forEach((x, i) => {
      expect(x.rank).toBe(i + 1);
      expect(x.explanation).toMatch(new RegExp(`^Ranked ${i + 1}(st|nd|rd|th): `));
    });
    for (const x of ranked.slice(0, -1)) expect(x.comparedWithNext).toMatch(/^Above “.+” because /);
  });

  it("ranks the same rows the same way twice", async () => {
    const again = await run(db, A.clinic);
    expect(again.findings).toEqual(result.findings);
  });

  it("never lets one clinic's findings reach another's", async () => {
    const other = await run(db, B.clinic);
    expect(other.findings.clinicId).toBe(B.clinic);
    expect(all(other).every((x) => x.finding.clinicId === B.clinic)).toBe(true);
    const text = JSON.stringify(other.findings);
    for (const idA of [A.clinic, ...A.patients]) expect(text).not.toContain(idA);
    expect(JSON.stringify(result.findings)).not.toContain(B.clinic);
  });

  it("produces the same findings on the dentist's own session under RLS", async () => {
    const client = createClient<Database>(URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await client.auth.signInWithPassword({ email: A.email, password: "password123" });
    if (error) throw new Error(`sign in: ${error.message}`);
    const asDentist = await run(client, A.clinic);
    const shape = (r: BusinessBrainResult) => all(r).map((x) => [x.finding.id, x.role, x.rank]);
    expect(shape(asDentist)).toEqual(shape(result));
    await client.auth.signOut();
  });
});
