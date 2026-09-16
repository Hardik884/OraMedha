/**
 * Integration specs for metric persistence.
 *
 * Run against the LOCAL Supabase stack and skip, loudly, when it is not
 * reachable — same contract as the sibling repository specs.
 *
 * The behaviours worth pinning down are the ones that decide whether stored
 * history can be TRUSTED as history:
 *
 *   - a day that was never measured must stay absent, not arrive as zeros,
 *     because the Diagnosis Engine reads an absent day as `unknown` and a zero
 *     day as a real quiet day
 *   - re-measuring must correct, not duplicate
 *   - a store failure must degrade to recomputation, never cost the run
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/types/database.types";
import { BusinessBrain, MetricKey } from "@/business-brain";
import type { MetricHistoryStore, StoredMetricDay } from "@/business-brain";
import { SupabaseMetricsDataRepository } from "../metrics-repository";
import { SupabaseMetricHistoryStore } from "../metric-history-store";
import {
  persistMetricDay,
  persistMetricRange,
  recordRecomputedHistory,
} from "../persist-metrics";

const URL = process.env.SUPABASE_TEST_URL ?? "http://127.0.0.1:55321";
const KEY =
  process.env.SUPABASE_TEST_SERVICE_KEY ??
  // Standard local-development service key — published in Supabase's own docs,
  // identical on every local stack, and worthless against any hosted project.
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
    `\n[metric-history] SKIPPED — local Supabase not reachable at ${URL}.` +
      `\n                 Start it with: npm run db:start\n`,
  );
}

const CLINIC = "9fb00000-0000-4000-8000-000000000001";
const DENTIST = "9fb00000-0000-4000-8000-000000000010";
const PATIENT = "9fb00000-0000-4000-8000-000000000021";
const APPT = "9fb00000-0000-4000-8000-000000000031";
const TREATMENT = "9fb00000-0000-4000-8000-000000000041";

const TZ = "Asia/Kolkata";
/** The day the crown is performed. Everything before it is a quiet day. */
const BUSY = "2026-03-18";
const QUIET = "2026-03-16";
const AS_OF = "2026-03-20T06:30:00.000Z";

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
  const { error } = await raw.auth.admin.createUser({
    id: DENTIST,
    email: "bb-history@test.local",
    password: "password123",
    email_confirm: true,
  });
  if (error && !/already/i.test(error.message)) throw new Error(`seed user: ${error.message}`);

  await insert("clinics", { id: CLINIC, name: "History Clinic" });
  await insert("clinic_settings", {
    clinic_id: CLINIC,
    clinic_name: "History Clinic",
    timezone: TZ,
    average_appointment_duration: 30,
  });
  await insert("profiles", {
    id: DENTIST,
    clinic_id: CLINIC,
    full_name: "History Dentist",
    role: "dentist",
  });
  await insert("patients", {
    id: PATIENT,
    clinic_id: CLINIC,
    name: "History Patient",
    created_at: "2026-01-01T00:00:00Z",
  });
  await insert("appointments", {
    id: APPT,
    clinic_id: CLINIC,
    patient_id: PATIENT,
    dentist_id: DENTIST,
    scheduled_at: `${BUSY}T05:00:00Z`,
    source: "walk_in",
    status: "completed",
  });
  // 20,000 of unpaid work, performed on BUSY. Before that the balance is zero —
  // which is what makes stored history distinguishable from a flat line.
  await insert("treatments", {
    id: TREATMENT,
    clinic_id: CLINIC,
    patient_id: PATIENT,
    appointment_id: APPT,
    treatment_type: "Crown",
    cost: 20000,
    status: "completed",
    performed_at: `${BUSY}T05:00:00Z`,
    created_at: `${BUSY}T05:00:00Z`,
  });
}

const ANON_KEY =
  process.env.SUPABASE_TEST_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const store = new SupabaseMetricHistoryStore(db);
const outstanding = (day: StoredMetricDay | undefined) =>
  day?.metrics.find((m) => m.key === MetricKey.REVENUE_OUTSTANDING)?.value;

// In order, never shuffled: the persistence tests write the same clinic-days the RLS tests then check are untouched.
describe.skipIf(!LOCAL_UP)("metric history (integration)", { shuffle: false }, () => {
  beforeAll(seed);
  afterAll(cleanup);

  describe("store round-trip", () => {
    it("writes a measured day and reads it back", async () => {
      await persistMetricDay(CLINIC, BUSY, db);
      const days = await store.readMetricDays(CLINIC, BUSY, BUSY);
      expect(days).toHaveLength(1);
      expect(days[0].date).toBe(BUSY);
      expect(outstanding(days[0])).toBe(20000);
    });

    it("records what was true that day, not what is true now", async () => {
      await persistMetricRange(CLINIC, QUIET, BUSY, db);
      const days = await store.readMetricDays(CLINIC, QUIET, BUSY);
      // The crown lands on BUSY, so the balance must step rather than sit flat.
      expect(outstanding(days.find((d) => d.date === QUIET))).toBe(0);
      expect(outstanding(days.find((d) => d.date === BUSY))).toBe(20000);
    });

    it("OMITS a day that was never measured rather than returning it empty", async () => {
      // The distinction the Diagnosis Engine depends on: an absent day is
      // `unknown` and caps persistence at intermittent; a day of zeros is a real
      // quiet day. Conflating them invents history.
      const days = await store.readMetricDays(CLINIC, "2026-03-01", BUSY);
      expect(days.map((d) => d.date)).not.toContain("2026-03-01");
      expect(days.every((d) => d.metrics.length > 0)).toBe(true);
    });

    it("returns days ascending, so a caller can walk them for gaps", async () => {
      const days = await store.readMetricDays(CLINIC, QUIET, BUSY);
      expect([...days].map((d) => d.date).sort()).toEqual(days.map((d) => d.date));
    });

    it("corrects a re-measured day instead of duplicating it", async () => {
      await persistMetricDay(CLINIC, BUSY, db);
      await persistMetricDay(CLINIC, BUSY, db);
      const days = await store.readMetricDays(CLINIC, BUSY, BUSY);
      expect(days).toHaveLength(1);
      const keys = days[0].metrics.map((m) => m.key);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("scopes reads to one clinic", async () => {
      const days = await store.readMetricDays(
        "9fb00000-0000-4000-8000-0000000000ff",
        QUIET,
        BUSY,
      );
      expect(days).toEqual([]);
    });

    it("reports which days a backfill could not measure", async () => {
      const result = await persistMetricRange(CLINIC, QUIET, BUSY, db);
      expect(result.failed).toEqual([]);
      expect(result.written).toContain(QUIET);
      expect(result.written).toContain(BUSY);
    });
  });

  describe("orchestrator history", () => {
    const repository = new SupabaseMetricsDataRepository(db, { asOf: AS_OF });

    it("reads a stored day instead of recomputing it", async () => {
      // The store here is IN-MEMORY, deliberately. What is under test is the
      // orchestrator's choice of stored-over-recomputed, and asserting an exact
      // query count against the real store would silently also be asserting
      // that the store never fails — which the design explicitly permits, since
      // a failed read degrades to recomputation rather than costing the run.
      // The Supabase store's own round-trip is covered above.
      const stored: Record<string, number> = { "2026-03-16": 111, "2026-03-18": 222 };
      const inMemory: MetricHistoryStore = {
        readMetricDays: async (_c, from, to) =>
          Object.entries(stored)
            .filter(([d]) => d >= from && d <= to)
            .map(([date, value]) => ({
              date,
              metrics: [
                { key: MetricKey.REVENUE_OUTSTANDING, value, measuredAt: `${date}T12:00:00Z` },
              ],
            })),
        writeMetricDay: () => Promise.resolve(),
      };

      const requested: string[] = [];
      const counting = {
        getClinicSnapshot: (clinicId: string, date: string) => {
          requested.push(date);
          return repository.getClinicSnapshot(clinicId, date);
        },
      };
      const brain = new BusinessBrain({ repository: counting, historyStore: inMemory });
      await brain.runBusinessBrain(CLINIC, "2026-03-20", {
        startedAt: AS_OF,
        historyDays: 4, // 16, 17, 18, 19
      });

      // Asserting WHICH days were measured, not how many: a count says the same
      // thing but names nothing when it breaks.
      expect(requested.sort()).toEqual(["2026-03-17", "2026-03-19", "2026-03-20"]);
      expect(requested).not.toContain("2026-03-16");
      expect(requested).not.toContain("2026-03-18");
    });

    it("reports the STORED value, not a fresh one", async () => {
      // Proves the stored row is genuinely used rather than read and discarded:
      // plant a figure the live database could never produce and look for it.
      await raw.from("metric_history").delete().eq("clinic_id", CLINIC);
      await store.writeMetricDay(CLINIC, {
        date: QUIET,
        metrics: [
          { key: MetricKey.REVENUE_OUTSTANDING, value: 123456, measuredAt: `${QUIET}T12:00:00Z` },
        ],
      });

      const seen: number[] = [];
      const brain = new BusinessBrain({
        repository,
        historyStore: {
          readMetricDays: async (c, f, t) => {
            const days = await store.readMetricDays(c, f, t);
            for (const d of days) {
              const v = outstanding(d);
              if (v !== undefined) seen.push(v);
            }
            return days;
          },
          writeMetricDay: () => Promise.resolve(),
        },
      });
      await brain.runBusinessBrain(CLINIC, "2026-03-20", { startedAt: AS_OF, historyDays: 4 });
      expect(seen).toContain(123456);

      await raw.from("metric_history").delete().eq("clinic_id", CLINIC);
    });

    it("still answers when the store is unavailable", async () => {
      // Losing the cache must never cost a dentist their dashboard.
      const broken: MetricHistoryStore = {
        readMetricDays: () => Promise.reject(new Error("store down")),
        writeMetricDay: () => Promise.reject(new Error("store down")),
      };
      const brain = new BusinessBrain({ repository, historyStore: broken });
      const result = await brain.runBusinessBrain(CLINIC, "2026-03-20", {
        startedAt: AS_OF,
        historyDays: 3,
      });
      expect(result.ok).toBe(true);
      expect(result.metrics.length).toBeGreaterThan(0);
    });

    it("produces the same result with and without a store", async () => {
      // Persistence is an optimisation. It must not change what is concluded.
      const withStore = new BusinessBrain({ repository, historyStore: store });
      const without = new BusinessBrain({ repository });
      const opts = { startedAt: AS_OF, historyDays: 4, correlationId: "fixed" };

      const a = await withStore.runBusinessBrain(CLINIC, "2026-03-20", opts);
      const b = await without.runBusinessBrain(CLINIC, "2026-03-20", opts);

      expect(a.metrics).toEqual(b.metrics);
      expect(a.signals).toEqual(b.signals);
      expect(a.diagnoses.map((d) => d.pattern)).toEqual(b.diagnoses.map((d) => d.pattern));
    });

    it("does not write during a run", async () => {
      // The run is read-only, and pipeline.spec.ts asserts it globally. This
      // guards the specific risk introduced here: a store handed to the
      // orchestrator must only ever be read from.
      let writes = 0;
      const readOnly: MetricHistoryStore = {
        readMetricDays: (c, f, t) => store.readMetricDays(c, f, t),
        writeMetricDay: async () => {
          writes += 1;
        },
      };
      const brain = new BusinessBrain({ repository, historyStore: readOnly });
      await brain.runBusinessBrain(CLINIC, "2026-03-20", { startedAt: AS_OF, historyDays: 4 });
      expect(writes).toBe(0);
    });
  });

  /**
   * The table's own protection, not the application's.
   *
   * `metric_history` is a clinic's business performance over time. The read
   * policy is dentist-and-own-clinic, matching Analytics; there is deliberately
   * NO write policy, because a client that could write here could fabricate the
   * history its own dashboard is judged against.
   */
  describe("row level security", () => {
    /** A client authenticated as the seeded dentist, holding only the anon key. */
    async function asDentist() {
      const client = createClient(URL, ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error } = await client.auth.signInWithPassword({
        email: "bb-history@test.local",
        password: "password123",
      });
      if (error) throw new Error(`sign in: ${error.message}`);
      return client;
    }

    it("lets a dentist read their own clinic's history", async () => {
      await persistMetricDay(CLINIC, BUSY, db);
      const client = await asDentist();
      const { data, error } = await (client as any)
        .from("metric_history")
        .select("metric_key")
        .eq("clinic_id", CLINIC);
      expect(error).toBeNull();
      expect((data ?? []).length).toBeGreaterThan(0);
    });

    it("returns nothing for another clinic, even when asked directly", async () => {
      const other = "9fb00000-0000-4000-8000-0000000000ee";
      await raw.from("clinics").insert({ id: other, name: "Someone else" });
      await raw.from("metric_history").insert({
        clinic_id: other,
        metric_date: BUSY,
        metric_key: MetricKey.REVENUE_OUTSTANDING,
        value: 999999,
        measured_at: `${BUSY}T12:00:00Z`,
      });
      try {
        const client = await asDentist();
        const { data, error } = await (client as any)
          .from("metric_history")
          .select("value")
          .eq("clinic_id", other);
        // RLS filters rather than errors: no rows, no leak.
        expect(error).toBeNull();
        expect(data).toEqual([]);
      } finally {
        await raw.from("clinics").delete().eq("id", other);
      }
    });

    it("REFUSES a write from an authenticated dentist", async () => {
      const client = await asDentist();
      const { error } = await (client as any).from("metric_history").insert({
        clinic_id: CLINIC,
        metric_date: "2026-03-19",
        metric_key: MetricKey.REVENUE_OUTSTANDING,
        value: 1,
        measured_at: `${BUSY}T12:00:00Z`,
      });
      expect(error).not.toBeNull();

      // And nothing landed.
      const { data } = await raw
        .from("metric_history")
        .select("metric_key")
        .eq("clinic_id", CLINIC)
        .eq("metric_date", "2026-03-19");
      expect(data ?? []).toEqual([]);
    });

    it("REFUSES an anonymous read", async () => {
      const anon = createClient(URL, ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data } = await (anon as any).from("metric_history").select("value");
      expect(data ?? []).toEqual([]);
    });
  });

  /**
   * History that fills itself.
   *
   * The run already measures every day the store could not supply, so writing
   * those back closes the gap permanently — the first person to open the
   * dashboard after a gap pays for it, and nobody pays again. This is why no
   * cron or external scheduler is needed for the performance win.
   */
  describe("self-healing history", () => {
    const repository = new SupabaseMetricsDataRepository(db, { asOf: AS_OF });

    it("reports the days it had to measure, so a caller can record them", async () => {
      await raw.from("metric_history").delete().eq("clinic_id", CLINIC);
      const brain = new BusinessBrain({ repository, historyStore: store });
      const result = await brain.runBusinessBrain(CLINIC, "2026-03-20", {
        startedAt: AS_OF,
        historyDays: 3, // 17, 18, 19
      });
      expect(result.recomputedHistory.map((d) => d.date)).toEqual([
        "2026-03-17",
        "2026-03-18",
        "2026-03-19",
      ]);
      expect(result.recomputedHistory.every((d) => d.metrics.length > 0)).toBe(true);
    });

    it("reports nothing once every day is stored", async () => {
      await persistMetricRange(CLINIC, "2026-03-17", "2026-03-19", db);
      const brain = new BusinessBrain({ repository, historyStore: store });
      const result = await brain.runBusinessBrain(CLINIC, "2026-03-20", {
        startedAt: AS_OF,
        historyDays: 3,
      });
      expect(result.recomputedHistory).toEqual([]);
    });

    it("closes the gap: a second run measures nothing", async () => {
      await raw.from("metric_history").delete().eq("clinic_id", CLINIC);

      let snapshots = 0;
      const counting = {
        getClinicSnapshot: (c: string, d: string) => {
          snapshots += 1;
          return repository.getClinicSnapshot(c, d);
        },
      };
      const brain = new BusinessBrain({ repository: counting, historyStore: store });
      const opts = { startedAt: AS_OF, historyDays: 3 };

      const first = await brain.runBusinessBrain(CLINIC, "2026-03-20", opts);
      // What the dashboard does after the response is sent.
      await recordRecomputedHistory(CLINIC, first.recomputedHistory, db);
      const afterFirst = snapshots;

      snapshots = 0;
      const second = await brain.runBusinessBrain(CLINIC, "2026-03-20", opts);

      expect(afterFirst).toBe(4); // 3 history days + the target day
      expect(second.recomputedHistory).toEqual([]);
      // The claim is that the gap CLOSED, not that it closed to an exact
      // number. A store read is allowed to fail and fall back to recomputing,
      // so an equality here would quietly also be asserting that the network
      // never hiccups.
      expect(snapshots).toBeLessThan(afterFirst);
    });

    it("records the same values the run reported", async () => {
      await raw.from("metric_history").delete().eq("clinic_id", CLINIC);
      const brain = new BusinessBrain({ repository, historyStore: store });
      const result = await brain.runBusinessBrain(CLINIC, "2026-03-20", {
        startedAt: AS_OF,
        historyDays: 3,
      });
      await recordRecomputedHistory(CLINIC, result.recomputedHistory, db);

      const stored = await store.readMetricDays(CLINIC, "2026-03-18", "2026-03-18");
      const measured = result.recomputedHistory.find((d) => d.date === "2026-03-18");
      const measuredOutstanding = measured?.metrics.find((m) =>
        m.id.startsWith(`${MetricKey.REVENUE_OUTSTANDING}:`),
      )?.value;
      expect(outstanding(stored[0])).toBe(measuredOutstanding);
      expect(outstanding(stored[0])).toBe(20000);
    });

    it("never throws, so a post-response write cannot break anything", async () => {
      // By the time this runs the response is already sent; there is nobody left
      // to report an error to, so it must swallow rather than reject.
      await expect(
        recordRecomputedHistory("not-a-uuid", [
          { date: "2026-03-18", metrics: [{ id: "x.y:c:d", value: 1, timestamp: AS_OF }] },
        ], db),
      ).resolves.toBeUndefined();
    });
  });
});
