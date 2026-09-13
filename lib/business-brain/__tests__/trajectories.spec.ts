/**
 * Trajectories against the LOCAL Supabase stack. Skips, loudly, when it is not
 * reachable.
 *
 * Real `metric_history` rows, real follow-ups, the real repository and history
 * store, the real service:
 *
 *   - a climbing stored history plus today's real rows becomes a worsening
 *     trajectory with the evidence a pencil gives, and reaches exactly one finding
 *   - a flat clinic stays stable; a clinic with a few stored days is insufficient
 *   - today's value respects soft deletes, and one clinic's history never reaches
 *     another's trajectory
 *   - the dentist's own session under RLS reads the same history and agrees
 *   - a rerun is identical
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { BusinessBrain, type BusinessBrainResult, addDays } from "@/business-brain";
import type { Database } from "@/types/database.types";
import { SupabaseMetricHistoryStore } from "../metric-history-store";
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
if (!LOCAL_UP) console.warn(`\n[trajectories] SKIPPED — local Supabase not reachable at ${URL}.\n`);

const db: SupabaseClient<Database> = createClient<Database>(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
/* eslint-disable @typescript-eslint/no-explicit-any */
const raw = db as any;
async function write(table: string, values: unknown, upsert = false) {
  const { error } = upsert ? await raw.from(table).upsert(values) : await raw.from(table).insert(values);
  if (error) throw new Error(`seed ${table}: ${error.message}`);
}

const D = "2026-10-05";
const NOW = "2026-10-05T03:30:00.000Z";
const TZ = "Asia/Kolkata";
const id = () => crypto.randomUUID();
const OVERDUE = "followups.overdue";

/**
 * Auth users are FIXED and reused across runs (see clinic-ledger.spec.ts for why):
 * a per-run user referenced by clinic rows can never be deleted, and they pile up.
 */
const DENTIST_A = "7a300000-0000-4000-8000-0000000000a1";
const DENTIST_A_EMAIL = "trajectory-a@test.local";

interface Clinic {
  readonly id: string;
  /** Weekly stored levels, oldest week first, for the 35 days before D. */
  readonly weeks: readonly number[] | null;
  /** Stored days before D, when only a few exist. */
  readonly storedDays?: number;
  readonly overdueToday: number;
}

const A: Clinic = { id: id(), weeks: [2, 3, 4, 7, 9], overdueToday: 10 };
const B: Clinic = { id: id(), weeks: [2, 2, 2, 2, 2], overdueToday: 2 };
const C: Clinic = { id: id(), weeks: null, storedDays: 5, overdueToday: 6 };

async function seedClinic(c: Clinic) {
  await write("clinics", { id: c.id, name: `Trajectory ${c.id.slice(0, 8)}` });
  await write("clinic_settings", { clinic_id: c.id, clinic_name: "Trajectory", timezone: TZ, average_appointment_duration: 30, chair_count: 1 });

  const patients = Array.from({ length: c.overdueToday + 1 }, id);
  await write("patients", patients.map((pid, i) => ({ id: pid, clinic_id: c.id, name: `Trajectory ${i}`, created_at: "2026-01-01T00:00:00.000Z" })));
  await write(
    "follow_ups",
    patients.map((patient, i) => ({
      id: id(),
      clinic_id: c.id,
      patient_id: patient,
      due_date: "2026-09-20",
      status: "pending",
      created_at: "2026-09-01T00:00:00.000Z",
      // The extra one is soft-deleted: today's value must not count it.
      deleted_at: i === c.overdueToday ? "2026-09-25T00:00:00.000Z" : null,
    })),
  );

  const rows: Record<string, unknown>[] = [];
  for (let back = 35; back >= 1; back -= 1) {
    const date = addDays(D, -back);
    if (c.weeks === null && back > (c.storedDays ?? 0)) continue;
    const value = c.weeks === null ? c.overdueToday : c.weeks[Math.min(4, Math.floor((35 - back) / 7))];
    rows.push({ clinic_id: c.id, metric_date: date, metric_key: OVERDUE, value, measured_at: `${date}T18:00:00.000Z` });
  }
  if (rows.length > 0) await write("metric_history", rows);
}

/**
 * `storeOnly` disables recomputation of days the store lacks. Without it the run
 * rebuilds missing days from live rows — correctly — which would turn "five stored
 * days" into a full real history and hide the thin-history case under test.
 */
async function run(client: SupabaseClient<Database>, clinic: string, storeOnly = false): Promise<BusinessBrainResult> {
  return new BusinessBrain({
    repository: new SupabaseMetricsDataRepository(client, { asOf: NOW }),
    historyStore: new SupabaseMetricHistoryStore(client),
  }).runBusinessBrain(clinic, D, { startedAt: NOW, historyDays: 35, ...(storeOnly ? { maxRecomputedHistoryDays: 0 } : {}) });
}

const overdueOf = (r: BusinessBrainResult) => r.trajectories.find((t) => t.metricKey === OVERDUE);
const allFindings = (r: BusinessBrainResult) => [
  ...(r.findings.top ? [r.findings.top] : []),
  ...r.findings.next,
  ...r.findings.supporting,
  ...r.findings.wins,
  ...r.findings.noActionRequired,
];

describe.skipIf(!LOCAL_UP)("trajectories from real stored history", () => {
  let a: BusinessBrainResult;
  let b: BusinessBrainResult;
  let c: BusinessBrainResult;

  beforeAll(async () => {
    const { error } = await raw.auth.admin.createUser({ id: DENTIST_A, email: DENTIST_A_EMAIL, password: "password123", email_confirm: true });
    if (error && !/already/i.test(error.message)) throw new Error(`seed user: ${error.message}`);
    for (const clinic of [A, B, C]) await seedClinic(clinic);
    await write("profiles", { id: DENTIST_A, clinic_id: A.id, full_name: "Trajectory Dentist", role: "dentist" }, true);
    [a, b, c] = await Promise.all([run(db, A.id), run(db, B.id), run(db, C.id, true)]);
  }, 90_000);

  it("turns a climbing history into a worsening trajectory with pencil-checkable evidence", () => {
    const t = overdueOf(a);
    expect(t?.state).toBe("worsening");
    expect(t?.weeks.map((w) => w.value)).toEqual([2, 3, 4, 7, 9]);
    expect(t?.current).toBe(10);
    expect(t?.reference).toMatchObject({ median: 3, lower: 1, upper: 5 });
    expect(t?.consecutiveWorseningWeeks).toBe(4);
    // The stored weeks sit one day off the engine's week boundaries, so the first
    // stored 7 — D−14 — opens the episode.
    expect(t?.firstDetectedDate).toBe(addDays(D, -14));
    expect(t?.observations).toBe(35);
    expect(t?.statement).toBe(
      "The number of overdue follow-ups is above your normal range (10; usual 1–5) and has worsened for 4 consecutive weeks.",
    );
  });

  it("carries the trajectory on exactly one finding — never a duplicate beside a constraint", () => {
    const carrying = allFindings(a).filter((x) => x.finding.evidence.trajectories.some((t) => t.metricKey === OVERDUE));
    expect(carrying).toHaveLength(1);
    const retention = a.constraints.find((constraint) => constraint.category === "retention");
    expect(carrying[0].finding.source.producer).toBe(retention ? "constraint" : "trajectory");
  });

  it("counts only live follow-ups for today's value", () => {
    expect(overdueOf(a)?.current).toBe(10);
    expect(overdueOf(b)?.current).toBe(2);
  });

  it("keeps a flat clinic stable, with nothing surfaced", () => {
    expect(overdueOf(b)?.state).toBe("stable");
    expect(allFindings(b).some((x) => x.finding.evidence.trajectories.some((t) => t.metricKey === OVERDUE))).toBe(false);
  });

  it("calls five stored days insufficient, never a trend, when history is not rebuilt", () => {
    expect(overdueOf(c)?.state).toBe("insufficient_data");
    expect(overdueOf(c)?.insufficientReason).toContain("normal range");
  });

  it("never lets one clinic's history reach another's trajectories", () => {
    expect(b.trajectories.every((t) => t.clinicId === B.id)).toBe(true);
    expect(JSON.stringify(b.trajectories)).not.toContain(A.id);
    expect(overdueOf(b)?.weeks.map((w) => w.value)).toEqual([2, 2, 2, 2, 2]);
  });

  it("reads the same history on the dentist's own session under RLS", async () => {
    const client = createClient<Database>(URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await client.auth.signInWithPassword({ email: DENTIST_A_EMAIL, password: "password123" });
    if (error) throw new Error(`sign in: ${error.message}`);
    const asDentist = await run(client, A.id);
    expect(overdueOf(asDentist)).toEqual(overdueOf(a));
    // The same dentist asking about another clinic reads none of its rows: not its
    // stored history, not its follow-ups. (The aggregate repository reports rows
    // RLS hides as zero — pre-existing behaviour — so the proof is that clinic B's
    // real values never appear, not that the state is insufficient.)
    const other = await run(client, B.id);
    expect(overdueOf(other)?.current).toBe(0);
    expect(overdueOf(other)?.weeks.some((w) => w.value === 2)).toBe(false);
    await client.auth.signOut();
  });

  it("is identical on a rerun", async () => {
    const again = await run(db, A.id);
    expect(again.trajectories).toEqual(a.trajectories);
    expect(again.findings).toEqual(a.findings);
  });
});
