/**
 * The action-history read, against the LOCAL Supabase stack: what it refuses to
 * treat as known at `asOf`. Skips, loudly, when the stack is not reachable.
 *
 *   - a completion recorded after asOf, whatever moment it names
 *   - a snapshot recorded after asOf
 *   - an empty snapshot from before run health was tracked: it may be a failed
 *     run, so that day is unknown rather than "nothing was shown"
 *   - readings carry their stored provenance
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { MetricKey } from "@/business-brain";
import type { Database } from "@/types/database.types";
import { SupabaseActionHistory } from "../action-history";

const URL = process.env.SUPABASE_TEST_URL ?? "http://127.0.0.1:55321";
const KEY =
  process.env.SUPABASE_TEST_SERVICE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${URL}/rest/v1/`, { headers: { apikey: KEY }, signal: AbortSignal.timeout(2500) });
    return res.status < 500;
  } catch {
    return false;
  }
}
const LOCAL_UP = await reachable();
if (!LOCAL_UP) console.warn(`\n[action-history-snapshots] SKIPPED — local Supabase not reachable at ${URL}.\n`);

const db: SupabaseClient<Database> = createClient<Database>(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
/* eslint-disable @typescript-eslint/no-explicit-any */
const raw = db as any;
const CLINIC = crypto.randomUUID();
const AS_OF = "2026-08-20T12:00:00.000Z";

async function insert(table: string, values: unknown) {
  const { error } = await raw.from(table).insert(values);
  if (error) throw new Error(`seed ${table}: ${error.message}`);
}

const finding = { findingId: "finding.problem:x", kind: "problem", polarity: "negative", category: "retention", role: "top", rank: 1, severity: "high", actionable: true, suppressed: false };

beforeAll(async () => {
  if (!LOCAL_UP) return;
  await insert("clinics", { id: CLINIC, name: "History read" });
  await insert("clinic_settings", { clinic_id: CLINIC, clinic_name: "History read", timezone: "UTC", average_appointment_duration: 30, chair_count: 1 });
  await insert("finding_snapshots", [
    // Before run health: an empty one may be a failed run; one with findings was shown.
    { clinic_id: CLINIC, business_date: "2026-08-10", findings: [], run_health: "unknown", run_started_at: null, brain_version: null, recorded_at: "2026-08-10T06:00:00.000Z" },
    { clinic_id: CLINIC, business_date: "2026-08-11", findings: [finding], run_health: "unknown", run_started_at: null, brain_version: null, recorded_at: "2026-08-11T06:00:00.000Z" },
    // A healthy run that genuinely showed nothing.
    { clinic_id: CLINIC, business_date: "2026-08-12", findings: [], run_health: "healthy", run_started_at: "2026-08-12T06:00:00.000Z", recorded_at: "2026-08-12T06:01:00.000Z", brain_version: "test" },
    // Recorded after asOf.
    { clinic_id: CLINIC, business_date: "2026-08-20", findings: [finding], run_health: "healthy", run_started_at: "2026-08-20T13:00:00.000Z", recorded_at: "2026-08-20T13:01:00.000Z", brain_version: "test" },
  ]);
  await insert("action_completions", [
    { clinic_id: CLINIC, category: "capacity", constraint_id: `constraint.capacity:${CLINIC}:2026-08-15`, source: "inferred", completed_at: "2026-08-15T09:00:00.000Z", created_at: "2026-08-15T09:00:00.000Z" },
    // Names the 16th, recorded on the 25th: not known on the 20th.
    { clinic_id: CLINIC, category: "capacity", constraint_id: `constraint.capacity:${CLINIC}:2026-08-16`, source: "inferred", completed_at: "2026-08-16T09:00:00.000Z", created_at: "2026-08-25T09:00:00.000Z" },
  ]);
  await insert("metric_history", [
    { clinic_id: CLINIC, metric_date: "2026-08-14", metric_key: MetricKey.FOLLOWUPS_OVERDUE, value: 4, measured_at: "2026-08-14T23:59:59.999Z", provenance: "unknown", produced_at: null, knowledge_as_of: null },
    {
      clinic_id: CLINIC,
      metric_date: "2026-08-15",
      metric_key: MetricKey.FOLLOWUPS_OVERDUE,
      value: 5,
      measured_at: "2026-08-15T23:59:59.999Z",
      provenance: "observed_at_time",
      produced_at: "2026-08-16T00:40:00.000Z",
      knowledge_as_of: "2026-08-15T23:59:59.999Z",
    },
  ]);
}, 60_000);

describe.skipIf(!LOCAL_UP)("action history read as of a moment", () => {
  it("reads only what was on record at asOf, and no empty snapshot it cannot vouch for", async () => {
    const slice = await new SupabaseActionHistory(db, "UTC").readActionHistory({
      clinicId: CLINIC,
      from: "2026-08-01",
      to: "2026-08-20",
      asOf: AS_OF,
      limit: 100,
      metricKeys: [MetricKey.FOLLOWUPS_OVERDUE],
    });
    expect(slice.snapshots.map((s) => [s.date, s.runHealth, s.findings.length])).toEqual([
      ["2026-08-11", "unknown", 1],
      ["2026-08-12", "healthy", 0],
    ]);
    expect(slice.completions.map((c) => c.completedAt.slice(0, 10))).toEqual(["2026-08-15"]);
    expect(slice.metricDays).toEqual([
      { date: "2026-08-14", values: { [MetricKey.FOLLOWUPS_OVERDUE]: 4 }, provenance: { [MetricKey.FOLLOWUPS_OVERDUE]: "unknown" } },
      { date: "2026-08-15", values: { [MetricKey.FOLLOWUPS_OVERDUE]: 5 }, provenance: { [MetricKey.FOLLOWUPS_OVERDUE]: "observed_at_time" } },
    ]);
  });

  it("refuses a snapshot written long after the run that supposedly showed it, or for another day", async () => {
    const regenerated = { clinic_id: CLINIC, business_date: "2026-08-13", findings: [finding], run_health: "healthy", brain_version: "test" };
    const late = await raw.from("finding_snapshots").insert({ ...regenerated, run_started_at: "2026-08-13T06:00:00.000Z", recorded_at: "2026-08-14T06:00:00.000Z" });
    expect(late.error?.message ?? "").toMatch(/not regenerated later/);
    const wrongDay = await raw.from("finding_snapshots").insert({ ...regenerated, run_started_at: "2026-08-14T06:00:00.000Z", recorded_at: "2026-08-14T06:01:00.000Z" });
    expect(wrongDay.error?.message ?? "").toMatch(/started on the business day/);
    const healthyWithoutRun = await raw.from("finding_snapshots").insert({ ...regenerated, run_started_at: null });
    expect(healthyWithoutRun.error).not.toBeNull();
  });
});
