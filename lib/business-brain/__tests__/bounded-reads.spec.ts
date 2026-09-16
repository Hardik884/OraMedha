/**
 * Reads larger than the PostgREST row cap, against the LOCAL Supabase stack.
 * Skips, loudly, when it is not reachable.
 *
 * The server returns at most 1000 rows per response and says nothing when it
 * stops. Every case here seeds more than that and checks the adapter either
 * returns all of it or says plainly that it could not.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { addDays, buildMetric, DentGrowMetricsEngine, MetricKey } from "@/business-brain";
import type { Database } from "@/types/database.types";
import { SupabaseActionHistory } from "../action-history";
import { SupabaseClinicLedger } from "../clinic-ledger";
import { SupabaseMetricHistoryStore } from "../metric-history-store";
import { SupabaseMetricsDataRepository } from "../metrics-repository";

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
if (!LOCAL_UP) console.warn(`\n[bounded-reads] SKIPPED — local Supabase not reachable at ${URL}.\n`);

const db: SupabaseClient<Database> = createClient<Database>(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
/* eslint-disable @typescript-eslint/no-explicit-any */
const raw = db as any;
async function insert(table: string, values: unknown[]) {
  for (let i = 0; i < values.length; i += 500) {
    const { error } = await raw.from(table).insert(values.slice(i, i + 500));
    if (error) throw new Error(`seed ${table}: ${error.message}`);
  }
}

const id = () => crypto.randomUUID();
const CLINIC = id();
const PATIENT = id();
const DENTIST = "7a9b0000-0000-4000-8000-0000000000a1";
const D = "2026-09-14";
const AS_OF = "2026-09-14T12:00:00.000Z";
const KEYS = Object.values(MetricKey);

beforeAll(async () => {
  if (!LOCAL_UP) return;
  const { error } = await raw.auth.admin.createUser({ id: DENTIST, email: "bounded-reads@test.local", password: "password123", email_confirm: true });
  if (error && !/already/i.test(error.message)) throw new Error(error.message);
  await raw.from("clinics").insert({ id: CLINIC, name: "Bounded reads" });
  await raw.from("clinic_settings").insert({ clinic_id: CLINIC, clinic_name: "Bounded", timezone: "UTC", average_appointment_duration: 30, chair_count: 1 });
  await raw.from("profiles").upsert({ id: DENTIST, clinic_id: CLINIC, full_name: "Bounded", role: "dentist" });
  await raw.from("appointments").update({ deleted_at: new Date().toISOString() }).eq("dentist_id", DENTIST).is("deleted_at", null);
  await raw.from("patients").insert({ id: PATIENT, clinic_id: CLINIC, name: "Bounded", created_at: "2026-01-01T00:00:00.000Z" });

  // 35 days x every metric key: more than one response can carry.
  const history: Record<string, unknown>[] = [];
  for (let back = 35; back >= 1; back -= 1) {
    const date = addDays(D, -back);
    for (const key of KEYS) history.push({ clinic_id: CLINIC, metric_date: date, metric_key: key, value: back, measured_at: `${date}T18:00:00.000Z` });
  }
  await insert("metric_history", history);

  // 1200 appointments in one month: one per 30 minutes across 25 days.
  const appointments: Record<string, unknown>[] = [];
  for (let i = 0; i < 1200; i += 1) {
    const at = new Date(Date.parse("2026-08-20T00:00:00.000Z") + i * 30 * 60_000).toISOString();
    appointments.push({ id: id(), clinic_id: CLINIC, patient_id: PATIENT, dentist_id: DENTIST, scheduled_at: at, duration_minutes: 30, source: "phone_call", status: "completed", created_at: "2026-08-01T00:00:00.000Z" });
  }
  await insert("appointments", appointments);

  // 1300 completed treatments of 100 and 1100 payments of 50 for one patient:
  // outstanding is exactly 130000 - 55000 = 75000. Capped at 1000 rows each it
  // would read 100000 - 50000 = 50000.
  const visit = appointments[0].id;
  await insert(
    "treatments",
    Array.from({ length: 1300 }, () => ({
      id: id(), clinic_id: CLINIC, appointment_id: visit, patient_id: PATIENT, treatment_type: "Cleaning", status: "completed", cost: 100,
      performed_at: "2026-08-20T10:00:00.000Z", created_at: "2026-08-20T10:00:00.000Z", opd_charged: false, opd_fee: 0, xray_taken: false, xray_cost: 0,
    })),
  );
  await insert("payments", Array.from({ length: 1100 }, () => ({ id: id(), clinic_id: CLINIC, patient_id: PATIENT, amount: 50, method: "cash", payment_date: "2026-08-21" })));

  // 1100 completions, for the history read's truncation report.
  await insert(
    "action_completions",
    Array.from({ length: 1100 }, (_, i) => ({
      clinic_id: CLINIC, category: "capacity", constraint_id: `constraint.capacity:${CLINIC}:2026-09-01`,
      completed_at: new Date(Date.parse("2026-08-01T00:00:00.000Z") + i * 60_000).toISOString(),
      // Recorded when completed, so the as-of read keeps them whatever today's date is.
      created_at: new Date(Date.parse("2026-08-01T00:00:00.000Z") + i * 60_000).toISOString(),
      completed_by: DENTIST, source: "declared",
    })),
  );
}, 180_000);

describe.skipIf(!LOCAL_UP)("reads past the server's row cap", () => {
  it("reads every stored history day whole", async () => {
    const days = await new SupabaseMetricHistoryStore(db).readMetricDays(CLINIC, addDays(D, -35), addDays(D, -1));
    expect(days).toHaveLength(35);
    expect(days.every((d) => d.metrics.length === KEYS.length)).toBe(true);
    expect(days[days.length - 1]).toMatchObject({ date: addDays(D, -1) });
  });

  it("measures a cumulative balance from every treatment and payment", async () => {
    const metrics = await new DentGrowMetricsEngine(new SupabaseMetricsDataRepository(db, { asOf: AS_OF })).calculateMetrics(CLINIC, D);
    const outstanding = metrics.find((m) => m.id === buildMetric(MetricKey.REVENUE_OUTSTANDING, 0, CLINIC, D, AS_OF).id);
    expect(outstanding?.value).toBe(75_000);
  });

  it("returns a whole ledger window under a larger limit, and reports truncation under a smaller one", async () => {
    const ledger = new SupabaseClinicLedger(db, "UTC");
    const scope = { kind: "appointment_window" as const, clinicId: CLINIC, from: "2026-08-20", to: "2026-09-14", asOf: AS_OF };
    const whole = await ledger.readAppointmentWindow({ ...scope, limit: 5000 });
    expect(whole.appointments).toHaveLength(1200);
    expect(whole.truncated).not.toContain("appointment");
    const cut = await ledger.readAppointmentWindow({ ...scope, limit: 1100 });
    expect(cut.appointments).toHaveLength(1100);
    expect(cut.truncated).toContain("appointment");
  });

  it("reports a history read cut at its limit as truncated", async () => {
    const slice = await new SupabaseActionHistory(db, "UTC").readActionHistory({
      clinicId: CLINIC, from: "2026-07-01", to: D, asOf: AS_OF, limit: 1050, metricKeys: [],
    });
    expect(slice.completions).toHaveLength(1050);
    expect(slice.truncated).toContain("action_completion");
  });
});
