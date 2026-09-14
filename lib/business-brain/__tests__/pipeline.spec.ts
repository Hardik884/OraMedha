/**
 * Full-pipeline integration specs.
 *
 *   Supabase -> SupabaseMetricsDataRepository -> Metrics -> Signals
 *            -> Diagnosis -> BusinessBrainResult
 *
 * Everything upstream of the result is real: a real Postgres, the real adapter,
 * and the three real engines. Only the clock is injected, so the run is
 * reproducible.
 *
 * The seeded clinic is deliberately unhealthy — low volume, no revenue, a queue
 * backlog, a large unstarted treatment pipeline — so signals actually fire and
 * the diagnosis stage has something to correlate. A healthy fixture would make
 * the pipeline look like it works while proving only that it returns nothing.
 *
 * Skips (loudly) when the local stack is not running.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/types/database.types";
import { BusinessBrain, MetricKey, SignalType } from "@/business-brain";
import { SupabaseMetricsDataRepository } from "../metrics-repository";

const URL = process.env.SUPABASE_TEST_URL ?? "http://127.0.0.1:55321";
const KEY =
  process.env.SUPABASE_TEST_SERVICE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${URL}/rest/v1/`, {
      headers: { apikey: KEY },
      signal: AbortSignal.timeout(2500),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

const LOCAL_UP = await reachable();
if (!LOCAL_UP) {
  console.warn(
    `\n[pipeline] SKIPPED — local Supabase not reachable at ${URL}.` +
      `\n           Start it with: npm run db:start\n`,
  );
}

const CLINIC = "9f000000-0000-4000-8000-000000000101";
const DENTIST = "9f000000-0000-4000-8000-000000000110";
const PATIENT = "9f000000-0000-4000-8000-000000000121";
const DATE = "2026-03-16";
const AS_OF = "2026-03-16T06:30:00.000Z"; // 12:00 IST
const DOW = new Date(`${DATE}T12:00:00.000Z`).getUTCDay();

const db: SupabaseClient<Database> = createClient<Database>(URL, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/* eslint-disable @typescript-eslint/no-explicit-any */
const raw = db as any;

async function insert(table: string, values: unknown) {
  const { error } = await raw.from(table).insert(values);
  if (error) throw new Error(`seed ${table}: ${error.message}`);
}

async function cleanup() {
  await raw.from("clinics").delete().eq("id", CLINIC);
  await raw.auth.admin.deleteUser(DENTIST).catch(() => undefined);
}

async function seed() {
  await cleanup();

  const { error: userErr } = await raw.auth.admin.createUser({
    id: DENTIST,
    email: "bb-pipeline@test.local",
    password: "password123",
    email_confirm: true,
  });
  if (userErr && !/already/i.test(userErr.message)) throw new Error(userErr.message);

  await insert("clinics", { id: CLINIC, name: "Pipeline Clinic" });
  await insert("clinic_settings", {
    clinic_id: CLINIC,
    clinic_name: "Pipeline Clinic",
    timezone: "Asia/Kolkata",
    average_appointment_duration: 30,
  });
  await insert("profiles", {
    id: DENTIST,
    clinic_id: CLINIC,
    full_name: "Pipeline Dentist",
    role: "dentist",
  });

  // 09:00–17:00 at 30 min => 16 slots offered.
  await insert("availability_rules", {
    clinic_id: CLINIC,
    day_of_week: DOW,
    start_time: "09:00",
    end_time: "17:00",
    slot_duration_minutes: 30,
  });

  await insert("patients", {
    id: PATIENT,
    clinic_id: CLINIC,
    name: "Pipeline Patient",
    created_at: "2026-01-02T10:00:00Z",
  });

  // Two appointments against 16 slots => 12.5% utilization (low), and volume
  // below the minimum daily threshold.
  await insert("appointments", [
    { id: "9f000000-0000-4000-8000-000000000131", clinic_id: CLINIC, patient_id: PATIENT, dentist_id: DENTIST, scheduled_at: "2026-03-16T04:00:00Z", source: "walk_in", status: "completed" },
    { id: "9f000000-0000-4000-8000-000000000132", clinic_id: CLINIC, patient_id: PATIENT, dentist_id: DENTIST, scheduled_at: "2026-03-16T05:00:00Z", source: "walk_in", status: "scheduled" },
  ]);

  // A large accepted-but-unstarted pipeline, and no payments at all today.
  await insert("treatments", {
    id: "9f000000-0000-4000-8000-000000000141",
    clinic_id: CLINIC,
    appointment_id: "9f000000-0000-4000-8000-000000000131",
    patient_id: PATIENT,
    treatment_type: "Full Mouth Rehab",
    cost: 80000,
    status: "planned",
    // Explicit: a planned treatment has no performed_at, so `created_at` is what
    // places it on the clinic's books. Left to default it would be stamped with
    // the real wall clock and fall outside this scenario's date entirely.
    created_at: "2026-03-16T04:30:00Z",
  });

  // Two patients waiting since well before the capture moment.
  await insert("queue_entries", [
    { id: "9f000000-0000-4000-8000-000000000161", clinic_id: CLINIC, appointment_id: "9f000000-0000-4000-8000-000000000131", patient_id: PATIENT, position: 1, status: "waiting", queue_date: DATE, checked_in_at: "2026-03-16T05:00:00Z", called_at: null },
    { id: "9f000000-0000-4000-8000-000000000162", clinic_id: CLINIC, appointment_id: "9f000000-0000-4000-8000-000000000132", patient_id: PATIENT, position: 2, status: "waiting", queue_date: DATE, checked_in_at: "2026-03-16T05:15:00Z", called_at: null },
  ]);
}

/**
 * Row counts for every table the pipeline reads, scoped to THIS suite's clinic.
 *
 * Scoped deliberately: vitest runs spec files in parallel, so a global census
 * also observes another suite's setup and teardown and would report their
 * deletions as if this run had caused them.
 */
async function rowCensus(): Promise<Record<string, number>> {
  const tables = [
    "appointments",
    "patients",
    "treatments",
    "payments",
    "queue_entries",
    "follow_ups",
    "availability_rules",
    "clinic_settings",
    "consultancy_schedules",
    "unavailable_dates",
  ];
  const census: Record<string, number> = {};
  for (const table of tables) {
    const { count, error } = await raw
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq("clinic_id", CLINIC);
    if (error) throw new Error(`census ${table}: ${error.message}`);
    census[table] = count ?? 0;
  }
  return census;
}

const repository = new SupabaseMetricsDataRepository(db, { asOf: AS_OF });
const brain = new BusinessBrain({ repository });

describe.skipIf(!LOCAL_UP)("Business Brain pipeline (integration)", () => {
  beforeAll(async () => {
    await seed();
  });
  afterAll(async () => {
    await cleanup();
  });

  it("runs Supabase -> metrics -> signals -> diagnoses end to end", async () => {
    const result = await brain.runBusinessBrain(CLINIC, DATE, { startedAt: AS_OF });

    expect(result.ok).toBe(true);
    expect(result.clinicId).toBe(CLINIC);
    expect(result.date).toBe(DATE);
    expect(result.metrics.length).toBeGreaterThan(0);
    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.execution.stages.every((s) => s.executed && s.ok)).toBe(true);
  });

  it("computes metrics from the seeded rows", async () => {
    const { metrics } = await brain.runBusinessBrain(CLINIC, DATE, { startedAt: AS_OF });
    const v = (key: string) => metrics.find((m) => m.id.startsWith(`${key}:`))?.value;

    expect(v(MetricKey.APPOINTMENTS_TOTAL_TODAY)).toBe(2);
    expect(v(MetricKey.REVENUE_COLLECTED_TODAY)).toBe(0);
    expect(v(MetricKey.REVENUE_PENDING_TREATMENT_VALUE)).toBe(80000);
    // Two entries still marked waiting, but the first one's appointment is
    // already completed: its call-in was never recorded, and it is not a patient
    // waiting.
    expect(v(MetricKey.QUEUE_PATIENTS_WAITING)).toBe(1);
    expect(v(MetricKey.CAPACITY_CHAIR_UTILIZATION)).toBe(12.5);
    expect(v(MetricKey.CAPACITY_AVAILABLE_SLOTS_TODAY)).toBe(14);
  });

  it("measures accepted_pending_scheduling now that bookings are recorded", async () => {
    const result = await brain.runBusinessBrain(CLINIC, DATE, { startedAt: AS_OF });

    // The metric is produced rather than withheld: the seeded plan has no
    // booking, so it is genuinely pending scheduling.
    const metric = result.metrics.find((m) =>
      m.id.startsWith(`${MetricKey.TREATMENT_ACCEPTED_PENDING_SCHEDULING}:`),
    );
    expect(metric?.value).toBe(1);

    // The dependent evaluator now reaches a verdict instead of skipping for
    // missing input. One pending treatment is below the threshold, so it
    // correctly reports "no signal" rather than raising one.
    const step = result.trace.find(
      (t) => t.step === SignalType.CLINICAL_ACCEPTED_TREATMENTS_UNSCHEDULED,
    );
    expect(step?.reasoning.startsWith("Skipped:")).toBe(false);
    expect(step?.reasoning.startsWith("No signal:")).toBe(true);
  });

  it("derives signals the seeded conditions should trigger", async () => {
    const { signals } = await brain.runBusinessBrain(CLINIC, DATE, { startedAt: AS_OF });
    const types = signals.map((s) => s.title);
    expect(signals.length).toBeGreaterThan(0);
    // 2 appointments against a minimum of 5, and 12.5% utilization against 50%.
    const ids = signals.map((s) => s.id);
    expect(ids.some((id) => id.includes("low_appointment_volume"))).toBe(true);
    expect(ids.some((id) => id.includes("low_chair_utilization"))).toBe(true);
    expect(types.every((t) => typeof t === "string" && t.length > 0)).toBe(true);
  });

  it("correlates those signals into at least one diagnosis", async () => {
    const { diagnoses } = await brain.runBusinessBrain(CLINIC, DATE, { startedAt: AS_OF });
    expect(diagnoses.length).toBeGreaterThan(0);
    for (const d of diagnoses) {
      // Every diagnosis must carry competing hypotheses and never a priority.
      expect(d.hypotheses.length).toBeGreaterThan(0);
      expect("priority" in d).toBe(false);
      // With no history supplied, persistence must be reported honestly.
      expect(d.persistence).toBe("insufficient_history");
    }
  });

  it("produces byte-identical results across repeated runs", async () => {
    const a = await brain.runBusinessBrain(CLINIC, DATE, { startedAt: AS_OF, correlationId: "c" });
    const b = await brain.runBusinessBrain(CLINIC, DATE, { startedAt: AS_OF, correlationId: "c" });
    expect(b.metrics).toEqual(a.metrics);
    expect(b.signals).toEqual(a.signals);
    expect(b.diagnoses).toEqual(a.diagnoses);
    expect(b.trace).toEqual(a.trace);
  });

  it("PERFORMS NO WRITES — every table's row count is unchanged", async () => {
    const before = await rowCensus();
    // Guard against a vacuous pass: an all-zero census would satisfy toEqual
    // even if seeding had silently failed and the pipeline read nothing.
    expect(Object.values(before).reduce((n, c) => n + c, 0)).toBeGreaterThan(0);

    await brain.runBusinessBrain(CLINIC, DATE, { startedAt: AS_OF, historyDays: 3 });

    const after = await rowCensus();
    expect(after).toEqual(before);
  });

  it("loads history and reports how many days it actually read", async () => {
    const result = await brain.runBusinessBrain(CLINIC, DATE, {
      startedAt: AS_OF,
      historyDays: 4,
    });
    expect(result.execution.historyDaysRequested).toBe(4);
    expect(result.execution.historyDaysLoaded).toBe(4);
    expect(result.ok).toBe(true);
  });

  it("records execution metadata for the whole run", async () => {
    const result = await brain.runBusinessBrain(CLINIC, DATE, {
      startedAt: AS_OF,
      correlationId: "corr-pipeline",
    });
    expect(result.execution.correlationId).toBe("corr-pipeline");
    expect(result.execution.startedAt).toBe(AS_OF);
    expect(result.execution.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result.execution.durationMs).toBeGreaterThanOrEqual(0);
    // "actions" is the fifth and last stage — prepared actions are mechanical,
    // advisory, and run after strategy. business-brain-service.spec.ts already
    // listed it; this copy of the expectation was missed when it was added.
    expect(result.execution.stages.map((s) => s.stage)).toEqual([
      "metrics",
      "signals",
      "diagnosis",
      "strategy",
      "actions",
    ]);
    for (const s of result.execution.stages) {
      expect(s.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns a recorded failure for an unknown clinic rather than throwing", async () => {
    const result = await brain.runBusinessBrain(
      "9f000000-0000-4000-8000-0000000009ff",
      DATE,
      { startedAt: AS_OF },
    );
    // An unknown clinic simply has no rows — a valid, empty day, not an error.
    expect(result.ok).toBe(true);
    expect(result.metrics.length).toBeGreaterThan(0);
    expect(result.metrics.every((m) => m.value === 0)).toBe(true);
  });

  /**
   * Strategy is the only advisory output the pipeline produces, so the limit on
   * that licence is worth asserting against real data rather than only against
   * hand-built diagnoses.
   */
  describe("strategy", () => {
    it("never recommends acting on a cause the engine did not settle", async () => {
      const result = await brain.runBusinessBrain(CLINIC, DATE, {
        startedAt: AS_OF,
        historyDays: 3,
      });

      const settled = new Set(
        result.diagnoses.flatMap((d) =>
          d.hypotheses.filter((h) => h.status === "supported").map((h) => h.id),
        ),
      );

      for (const strategy of result.strategies) {
        if (strategy.kind === "corrective") {
          expect(strategy.basedOn.length).toBeGreaterThan(0);
          for (const id of strategy.basedOn) {
            expect(settled.has(id), `${strategy.id} acts on an unsettled hypothesis`).toBe(true);
          }
        } else {
          // Investigative strategies propose a measurement, never an action, so
          // they must not claim to rest on a cause.
          expect(strategy.basedOn).toEqual([]);
        }
      }
    });

    it("derives constraints only from patterns the diagnoses actually produced", async () => {
      const result = await brain.runBusinessBrain(CLINIC, DATE, { startedAt: AS_OF });
      const diagnosisIds = new Set(result.diagnoses.map((d) => d.id));
      for (const constraint of result.constraints) {
        expect((constraint.relatedDiagnosisIds ?? []).length).toBeGreaterThan(0);
        for (const id of constraint.relatedDiagnosisIds ?? []) {
          expect(diagnosisIds.has(id)).toBe(true);
        }
      }
    });

    it("ties every strategy to a constraint that exists in the same run", async () => {
      const result = await brain.runBusinessBrain(CLINIC, DATE, { startedAt: AS_OF });
      const constraintIds = new Set(result.constraints.map((c) => c.id));
      for (const strategy of result.strategies) {
        expect(constraintIds.has(strategy.constraintId)).toBe(true);
      }
    });
  });
});
