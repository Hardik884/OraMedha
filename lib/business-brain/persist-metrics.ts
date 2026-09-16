/**
 * Recording measured metrics.
 *
 * Separate from the pipeline on purpose. Running the Business Brain is
 * read-only — `pipeline.spec.ts` asserts the whole run leaves every table's row
 * count unchanged — so every write lives here instead.
 *
 * Two callers, both explicit:
 *
 *   recordRecomputedHistory  the dashboard, via `after()`, once the response has
 *                            been sent. This is what makes history self-healing
 *                            without any scheduler: the run already measured the
 *                            days the store lacked, so writing them back means
 *                            nobody measures them again.
 *   persistMetricRange       a backfill or, if one is ever added, a daily job.
 *
 * Neither runs DURING a render — `after()` is deferred past the response, so the
 * page itself still writes nothing and the dentist never waits on a write.
 *
 * Uses the SERVICE ROLE, because `metric_history` grants SELECT to a dentist and
 * INSERT to nobody: a client that could write here could fabricate the clinic's
 * own history. Every function takes an explicit `clinicId` and scopes to it —
 * the service role bypasses RLS, so the scoping is the caller's responsibility
 * and is done in one place here rather than at each query.
 */

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database.types";
import { createAdminClient } from "@/lib/supabase/admin";
import { DentGrowMetricsEngine, addDays, classifyMetricReading, type Metric, type SnapshotKnowledge, type StoredMetric } from "@/business-brain";
import { DEFAULT_TIMEZONE } from "@/lib/clinic/constants";
import { SupabaseMetricsDataRepository } from "./metrics-repository";
import { SupabaseMetricHistoryStore } from "./metric-history-store";

export interface PersistResult {
  /** Business dates written, ascending. */
  readonly written: readonly string[];
  /** Dates that could not be measured, with the reason. */
  readonly failed: readonly { date: string; error: string }[];
}

/**
 * Measure one clinic-day and record it.
 *
 * Intended for COMPLETED days. Today's figures are still moving — a snapshot
 * taken at 11:00 does not describe the day — so recording today would freeze a
 * half-finished number as if it were the day's result. The scheduled caller
 * should ask for yesterday; {@link persistYesterday} does exactly that.
 *
 * Idempotent on (clinic, date, key). Every write is kept in metric_observations
 * with its provenance, and the current row prefers the better provenance, so a
 * late re-run cannot overwrite what was measured at the time.
 */
export async function persistMetricDay(
  clinicId: string,
  date: string,
  db?: SupabaseClient<Database>,
): Promise<void> {
  const client = db ?? (createAdminClient() as unknown as SupabaseClient<Database>);
  const engine = new DentGrowMetricsEngine(new SupabaseMetricsDataRepository(client));
  const store = new SupabaseMetricHistoryStore(client);

  const { metrics, knowledge, timezone } = await engine.measureDay(clinicId, date);
  if (metrics.length === 0) return;

  await store.writeMetricDay(clinicId, {
    date,
    metrics: withProvenance(metrics, date, timezone ?? DEFAULT_TIMEZONE, knowledge, new Date().toISOString()),
  });
}

/**
 * Each reading with how it came to exist: measured within the grace window from
 * state as known at the end of its day, reconstructed later from that same state,
 * or recomputed from today's records. See `classifyMetricReading`.
 */
export function withProvenance(
  metrics: readonly Pick<Metric, "id" | "value" | "timestamp">[],
  date: string,
  timezone: string,
  knowledge: SnapshotKnowledge | undefined,
  producedAt: string,
): StoredMetric[] {
  return metrics.map((m) => {
    // Metric ids are `key:clinicId:date`. The key contains dots but never a
    // colon, so the first segment is the key.
    const key = m.id.slice(0, m.id.indexOf(":"));
    const reading = classifyMetricReading({ metricKey: key, date, timezone, producedAt, knowledge });
    return {
      key,
      value: m.value,
      measuredAt: m.timestamp,
      provenance: reading.provenance,
      producedAt: reading.producedAt,
      knowledgeAsOf: reading.knowledgeAsOf,
      unversionedInputs: reading.unversionedInputs,
    };
  });
}

/**
 * Record an inclusive range of days, oldest first.
 *
 * Used to backfill history so the Diagnosis Engine has something to classify
 * persistence against before the daily job has run for a week.
 *
 * Days are written SEQUENTIALLY and a failure does not stop the run: one
 * unreadable day should cost that day, not the other six. Failures are returned
 * rather than thrown so the caller can report exactly which dates are missing —
 * a partially-filled history is honest, and the Diagnosis Engine already treats
 * an absent day as `unknown` rather than as a quiet one.
 */
export async function persistMetricRange(
  clinicId: string,
  from: string,
  to: string,
  db?: SupabaseClient<Database>,
): Promise<PersistResult> {
  const client = db ?? (createAdminClient() as unknown as SupabaseClient<Database>);
  const written: string[] = [];
  const failed: { date: string; error: string }[] = [];

  for (let date = from; date <= to; date = addDays(date, 1)) {
    try {
      await persistMetricDay(clinicId, date, client);
      written.push(date);
    } catch (error) {
      failed.push({ date, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { written, failed };
}

/**
 * Record the day that just finished, in the clinic's own timezone.
 *
 * The timezone matters: "yesterday" for a clinic in IST is not yesterday for the
 * server, and a job running at 00:30 UTC would otherwise record the wrong day.
 */
export async function persistYesterday(
  clinicId: string,
  todayInClinicTimezone: string,
  db?: SupabaseClient<Database>,
): Promise<void> {
  await persistMetricDay(clinicId, addDays(todayInClinicTimezone, -1), db);
}

/**
 * Record history days a run had to measure itself.
 *
 * The pipeline returns the days it could not read from the store, with the
 * metrics it measured for them. Writing those back is what makes history
 * self-healing: the first person to open the dashboard after a gap closes it,
 * and every load after that reads instead of measures. No scheduler involved.
 *
 * Best-effort by design, and never thrown from. The caller runs this after the
 * response has already been sent, so there is nobody left to tell — a failed
 * write costs the next load some time, not its result.
 *
 * The caller is responsible for passing COMPLETED days only. Recording today
 * would freeze a half-finished figure as if it were the day's result.
 */
export async function recordRecomputedHistory(
  clinicId: string,
  days: readonly {
    date: string;
    metrics: readonly { id: string; value: number; timestamp: string }[];
    knowledge?: SnapshotKnowledge;
    timezone?: string;
  }[],
  db?: SupabaseClient<Database>,
  producedAt: string = new Date().toISOString(),
): Promise<void> {
  if (days.length === 0) return;
  try {
    const client = db ?? (createAdminClient() as unknown as SupabaseClient<Database>);
    const store = new SupabaseMetricHistoryStore(client);
    for (const day of days) {
      if (day.metrics.length === 0) continue;
      // Measured by a dashboard load, so rarely inside the grace window: it is a
      // point-in-time reconstruction where history covered the day, and a
      // recomputation otherwise. Never recorded as measured at the time unless
      // it genuinely was.
      await store.writeMetricDay(clinicId, {
        date: day.date,
        metrics: withProvenance(day.metrics, day.date, day.timezone ?? DEFAULT_TIMEZONE, day.knowledge, producedAt),
      });
    }
  } catch (error) {
    console.error("[recordRecomputedHistory]", error);
  }
}
