/**
 * Root-cause intelligence against the LOCAL Supabase stack. Skips, loudly, when
 * it is not reachable.
 *
 * Two clinics, each seeded with one real concentration, run through the whole
 * pipeline — metrics, signals, diagnoses, constraints, findings — with the
 * Root-Cause Engine reading the real clinic ledger:
 *
 *   A  lost appointments concentrated in evening appointments (Asia/Kolkata)
 *   B  overruns concentrated in root canal visits
 *
 * Checked on what the engine actually receives: soft-deleted rows never count,
 * clinic-local time is used, analyses attach to the finding they explain, one
 * clinic never sees the other's rows, and the same rows explain the same way twice.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import {
  BusinessBrain,
  buildLedgerGraph,
  deriveRootCauses,
  type BusinessBrainResult,
  type RankedFinding,
  type RootCauseAnalysis,
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
if (!LOCAL_UP) console.warn(`\n[root-causes] SKIPPED — local Supabase not reachable at ${URL}.\n`);

const db: SupabaseClient<Database> = createClient<Database>(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
/* eslint-disable @typescript-eslint/no-explicit-any */
const raw = db as any;
async function insert(table: string, values: unknown) {
  const { error } = await raw.from(table).insert(values);
  if (error) throw new Error(`seed ${table}: ${error.message}`);
}

/** See findings.spec.ts: fixed dentists, whose previous runs' appointments are retired. */
async function retirePreviousRuns(dentistIds: readonly string[]) {
  const { error } = await raw
    .from("appointments")
    .update({ deleted_at: new Date().toISOString() })
    .in("dentist_id", dentistIds as string[])
    .is("deleted_at", null);
  if (error) throw new Error(`retire previous runs: ${error.message}`);
}

const TZ = "Asia/Kolkata";
/** Monday. The window is 6 Sep … 5 Oct; 7 Sep … 2 Oct holds 20 weekdays. */
const D = "2026-10-05";
/** 22:30 in Kolkata: everything booked today has happened. */
const NOW = "2026-10-05T17:00:00.000Z";
const id = () => crypto.randomUUID();
const RUN = id().slice(0, 8);

interface ClinicFixture {
  readonly clinic: string;
  readonly dentist: string;
  readonly email: string;
  readonly patients: readonly string[];
}

function fixture(label: "a" | "b"): ClinicFixture {
  return {
    clinic: id(),
    dentist: `7c0a0000-0000-4000-8000-0000000000${label}1`,
    email: `root-cause-${label}@test.local`,
    patients: Array.from({ length: 10 }, id),
  };
}
const A = fixture("a");
const B = fixture("b");

function weekdays(): string[] {
  const out: string[] = [];
  for (let t = Date.parse("2026-09-07T00:00:00Z"); t <= Date.parse("2026-10-02T00:00:00Z"); t += 86_400_000) {
    const day = new Date(t).getUTCDay();
    if (day >= 1 && day <= 5) out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** A Kolkata wall-clock time as a UTC instant (IST is UTC+05:30, no DST). */
const ist = (date: string, hhmm: string, plusMinutes = 0) =>
  new Date(Date.parse(`${date}T${hhmm}:00.000+05:30`) + plusMinutes * 60_000).toISOString();

async function seedBase(f: ClinicFixture) {
  const { error } = await raw.auth.admin.createUser({ id: f.dentist, email: f.email, password: "password123", email_confirm: true });
  if (error && !/already/i.test(error.message)) throw new Error(`seed user: ${error.message}`);
  await insert("clinics", { id: f.clinic, name: `Root cause ${RUN}` });
  await insert("clinic_settings", { clinic_id: f.clinic, clinic_name: "Root cause", timezone: TZ, average_appointment_duration: 30, chair_count: 1 });
  const { error: profileError } = await raw
    .from("profiles")
    .upsert({ id: f.dentist, clinic_id: f.clinic, full_name: "Root Cause Dentist", role: "dentist" });
  if (profileError) throw new Error(`seed profiles: ${profileError.message}`);
  await retirePreviousRuns([f.dentist]);
  await insert("availability_rules", [1, 2, 3, 4, 5].map((day_of_week) => ({
    clinic_id: f.clinic, day_of_week, start_time: "09:00", end_time: "20:00", slot_duration_minutes: 30, is_active: true,
  })));
  await insert("patients", f.patients.map((pid, i) => ({
    id: pid, clinic_id: f.clinic, name: `Root cause ${i}`, phone: `99900300${String(i).padStart(2, "0")}`, created_at: "2026-01-01T00:00:00.000Z",
  })));
}

function appointmentRow(f: ClinicFixture, n: number, scheduledAt: string, status: string, over: Record<string, unknown> = {}) {
  return {
    id: id(),
    clinic_id: f.clinic,
    patient_id: f.patients[n % f.patients.length],
    dentist_id: f.dentist,
    scheduled_at: scheduledAt,
    duration_minutes: 30,
    source: "phone_call",
    status,
    created_at: new Date(Date.parse(scheduledAt) - 3 * 86_400_000).toISOString(),
    ...over,
  };
}

/**
 * Clinic A: 60 morning appointments (2 cancelled) and 20 evening ones at 18:00
 * Kolkata (12 cancelled). Plus five cancelled evening appointments that were
 * soft-deleted — if they counted, the evening figures would read 17 of 25.
 */
async function seedEveningAttrition(f: ClinicFixture) {
  await seedBase(f);
  const rows: Record<string, unknown>[] = [];
  let n = 0;
  weekdays().forEach((date, i) => {
    ["09:00", "09:30", "10:00"].forEach((t, j) => {
      rows.push(appointmentRow(f, n++, ist(date, t), (i === 3 && j === 0) || (i === 11 && j === 2) ? "cancelled" : "completed"));
    });
    rows.push(appointmentRow(f, n++, ist(date, "18:00"), i < 12 ? "cancelled" : "completed"));
    if (i < 5) rows.push(appointmentRow(f, n++, ist(date, "19:00"), "cancelled", { deleted_at: "2026-10-01T00:00:00.000Z" }));
  });
  await insert("appointments", rows);
}

/**
 * Clinic B: 32 visits booked for 30 minutes. The 16 root canals stay 55 minutes
 * in the chair, the 16 cleanings 30. Four cleaning visits also carry a
 * soft-deleted "Root Canal" row — counted, they would give those visits two types.
 */
async function seedRootCanalOverruns(f: ClinicFixture) {
  await seedBase(f);
  const appointments: Record<string, unknown>[] = [];
  const queue: Record<string, unknown>[] = [];
  const treatments: Record<string, unknown>[] = [];
  let n = 0;
  weekdays().slice(0, 16).forEach((date, i) => {
    ["09:00", "14:00"].forEach((t, j) => {
      const rootCanal = (i + j) % 2 === 0;
      const scheduledAt = ist(date, t);
      const a = appointmentRow(f, n++, scheduledAt, "completed");
      appointments.push(a);
      const calledAt = ist(date, t, 5);
      queue.push({
        id: id(), clinic_id: f.clinic, appointment_id: a.id, patient_id: a.patient_id, position: j + 1, status: "completed",
        queue_date: date, checked_in_at: scheduledAt, called_at: calledAt, completed_at: ist(date, t, 5 + (rootCanal ? 55 : 30)),
      });
      const treatment = (type: string, deleted: boolean) => ({
        id: id(), clinic_id: f.clinic, appointment_id: a.id, patient_id: a.patient_id, treatment_type: type, status: "completed",
        cost: 2000, performed_at: calledAt, created_at: calledAt, opd_charged: false, opd_fee: 0, xray_taken: false, xray_cost: 0,
        deleted_at: deleted ? "2026-10-01T00:00:00.000Z" : null,
      });
      treatments.push(treatment(rootCanal ? "Root Canal" : "Cleaning", false));
      if (!rootCanal && i < 8 && j === 1) treatments.push(treatment("Root Canal", true));
    });
  });
  await insert("appointments", appointments);
  await insert("queue_entries", queue);
  await insert("treatments", treatments);
}

async function run(client: SupabaseClient<Database>, clinic: string): Promise<BusinessBrainResult> {
  return new BusinessBrain({
    repository: new SupabaseMetricsDataRepository(client, { asOf: NOW }),
    ledgerPort: new SupabaseClinicLedger(client, TZ),
  }).runBusinessBrain(clinic, D, { startedAt: NOW, rootCauses: { now: NOW, timezone: TZ } });
}

/** The engine on a real ledger read, for a named question — independent of which constraints fire. */
async function investigate(client: SupabaseClient<Database>, clinic: string, category: "scheduling" | "schedule_accuracy") {
  const slice = await new SupabaseClinicLedger(client, TZ).readAppointmentWindow({
    kind: "appointment_window", clinicId: clinic, from: "2026-09-06", to: D, asOf: NOW, limit: 5000,
  });
  const [analysis] = deriveRootCauses({
    clinicId: clinic,
    date: D,
    now: NOW,
    timezone: TZ,
    subjects: [{ parentFindingId: `finding.test:${category}`, category, focus: "lost" }],
    schedule: buildLedgerGraph(slice),
    capacity: null,
  });
  return analysis;
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
  await seedEveningAttrition(A);
  await seedRootCanalOverruns(B);
}, 90_000);

describe.skipIf(!LOCAL_UP)("root causes on real rows", () => {
  let a: BusinessBrainResult;
  let b: BusinessBrainResult;
  beforeAll(async () => {
    [a, b] = await Promise.all([run(db, A.clinic), run(db, B.clinic)]);
  }, 90_000);

  it("A: locates lost appointments in Kolkata evenings, without the soft-deleted rows", async () => {
    const analysis = await investigate(db, A.clinic, "scheduling");
    expect(analysis.outcome).toBe("explained");
    expect(analysis.population).toMatchObject({ n: 80, events: 14 });
    expect(analysis.associations.map((x) => [x.dimension, x.group.label])).toEqual([["session", "Evening (17:00 onwards)"]]);
    expect(analysis.associations[0].group).toMatchObject({ n: 20, events: 12, rate: 60 });
    expect(analysis.associations[0].comparison).toMatchObject({ n: 60, events: 2, rate: 3.3 });
  });

  it("A: attaches the analysis to the scheduling finding the run produced", () => {
    const attrition = a.rootCauses.find((r) => r.question === "attrition");
    expect(attrition, `constraints: ${a.constraints.map((c) => c.category).join(", ")}`).toBeDefined();
    const parent = all(a).filter((x) => x.finding.id === attrition?.parentFindingId);
    expect(parent).toHaveLength(1);
    expect(parent[0].finding.category).toBe("scheduling");
    expect(parent[0].finding.evidence.rootCauses).toEqual([attrition]);
    expect(parent[0].explanation).toContain("Lost appointments are concentrated in evening appointments (17:00 onwards): 60% (12 of 20)");
    // No new finding: every finding still traces to a producer's object.
    const sources = all(a).map((x) => x.finding.source.id);
    expect(new Set(sources).size).toBe(sources.length);
  });

  it("B: locates overruns in root canal visits, ignoring soft-deleted treatments", async () => {
    const analysis = await investigate(db, B.clinic, "schedule_accuracy");
    expect(analysis.outcome).toBe("explained");
    expect(analysis.population.n).toBe(32);
    const type = analysis.dimensions.find((d) => d.dimension === "treatment_type");
    expect(type?.coverage).toBe(1);
    expect(analysis.associations.map((x) => [x.dimension, x.group.label])).toEqual([["treatment_type", "Root Canal"]]);
    expect(analysis.associations[0].group).toMatchObject({ n: 16, median: 25 });
    expect(analysis.associations[0].comparison).toMatchObject({ n: 16, median: 0 });
  });

  it("B: explains whatever explainable findings its run produced, each on its own parent", () => {
    for (const analysis of b.rootCauses) {
      const parents = all(b).filter((x) => x.finding.id === analysis.parentFindingId);
      expect(parents).toHaveLength(1);
      expect(parents[0].finding.evidence.rootCauses).toContainEqual(analysis);
    }
    const overrun = b.rootCauses.find((r) => r.question === "overrun");
    if (overrun !== undefined) expect(overrun.statement).toMatch(/root canal visits/);
  });

  it("uses association wording and names no patient", () => {
    const causes: RootCauseAnalysis[] = [...a.rootCauses, ...b.rootCauses];
    const text = JSON.stringify(causes);
    expect(text).not.toMatch(/caused by|because of|will cause|due to/i);
    for (const pid of [...A.patients, ...B.patients]) expect(text).not.toContain(pid);
  });

  it("never lets one clinic's rows reach another's analysis", async () => {
    expect(JSON.stringify(b.rootCauses)).not.toContain(A.clinic);
    expect(JSON.stringify(a.rootCauses)).not.toContain(B.clinic);
    // B's dentist asking about A's clinic under RLS sees nothing — insufficient, never A's figures.
    const client = createClient<Database>(URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await client.auth.signInWithPassword({ email: B.email, password: "password123" });
    if (error) throw new Error(`sign in: ${error.message}`);
    const leaked = await investigate(client, A.clinic, "scheduling");
    expect(leaked.outcome).toBe("insufficient_evidence");
    expect(leaked.population.n).toBe(0);
    await client.auth.signOut();
  });

  it("gives the dentist's own session under RLS the same analyses", async () => {
    const client = createClient<Database>(URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await client.auth.signInWithPassword({ email: A.email, password: "password123" });
    if (error) throw new Error(`sign in: ${error.message}`);
    expect(await investigate(client, A.clinic, "scheduling")).toEqual(await investigate(db, A.clinic, "scheduling"));
    await client.auth.signOut();
  });

  it("explains the same rows the same way twice", async () => {
    const again = await run(db, A.clinic);
    expect(again.rootCauses).toEqual(a.rootCauses);
    expect(again.findings).toEqual(a.findings);
  });
});
