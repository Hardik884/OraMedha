/**
 * Supabase adapter for the Business Brain's metric history port.
 *
 * The port lives in `business-brain/` and knows nothing about Postgres; this is
 * the only place the `metric_history` table is touched. Same split as
 * `metrics-repository.ts`: the contract belongs to the module, the data access
 * belongs to the app.
 *
 * Pass a SERVICE-ROLE client. The table has a read policy for dentists and no
 * write policy at all — by design, since a client that could write here could
 * fabricate the clinic's own history — so writes only work as the service role.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  MetricHistoryStore,
  StoredMetric,
  StoredMetricDay,
} from "@/business-brain";
import type { Database } from "@/types/database.types";
import { readAll } from "./paged-read";

/** Most history rows one read may return: a year of every metric key, with room. */
const MAX_HISTORY_ROWS = 50_000;

interface MetricHistoryRow {
  metric_date: string;
  metric_key: string;
  value: number | string | null;
  measured_at: string;
  provenance: string;
  produced_at: string | null;
  knowledge_as_of: string | null;
  unversioned_inputs: string[] | null;
}

export class SupabaseMetricHistoryStore implements MetricHistoryStore {
  private readonly db: SupabaseClient<Database>;

  constructor(db: SupabaseClient<Database>) {
    this.db = db;
  }

  async readMetricDays(
    clinicId: string,
    from: string,
    to: string,
  ): Promise<readonly StoredMetricDay[]> {
    // Paged: a 35-day history over every metric key is more rows than one
    // PostgREST response carries, and a capped response silently dropped the
    // most recent days. A history too large to read whole is refused, never
    // returned in part — a partial day reads as a day that was fully measured.
    const data = await readAll<MetricHistoryRow>(
      "metric_history read",
      (from_, to_) =>
        this.db
          .from("metric_history")
          .select("metric_date, metric_key, value, measured_at, provenance, produced_at, knowledge_as_of, unversioned_inputs")
          .eq("clinic_id", clinicId)
          .gte("metric_date", from)
          .lte("metric_date", to)
          .order("metric_date", { ascending: true })
          .order("metric_key", { ascending: true })
          .range(from_, to_),
      MAX_HISTORY_ROWS,
    );

    // Group into days. A date absent from the result stays absent from the
    // output — the caller must be able to tell "not measured" from "measured
    // zero", and an empty day would read as the latter.
    const byDate = new Map<string, StoredMetric[]>();
    for (const row of data) {
      // `value` is NOT NULL double precision; PostgREST can still hand back a
      // string. A value that does not parse is dropped — an unreadable reading
      // is not a zero.
      const value = Number(row.value);
      if (row.value === null || !Number.isFinite(value)) continue;
      const list = byDate.get(row.metric_date) ?? [];
      list.push({
        key: row.metric_key,
        value,
        measuredAt: row.measured_at,
        provenance: row.provenance as StoredMetric["provenance"],
        ...(row.produced_at === null ? {} : { producedAt: row.produced_at }),
        ...(row.knowledge_as_of === null ? {} : { knowledgeAsOf: row.knowledge_as_of }),
        unversionedInputs: row.unversioned_inputs ?? [],
      });
      byDate.set(row.metric_date, list);
    }

    return [...byDate.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([date, metrics]) => ({ date, metrics }));
  }

  async writeMetricDay(clinicId: string, day: StoredMetricDay): Promise<void> {
    if (day.metrics.length === 0) return;

    // Upsert on the primary key. Every write is also appended to
    // metric_observations by the database, and the current row keeps the better
    // provenance: a later recomputation never takes the place of a reading
    // measured at the time (migration 20260917100100). Provenance is always sent,
    // so an upsert can never leave an old label on a new value.
    const { error } = await this.db.from("metric_history").upsert(
      day.metrics.map((m) => ({
        clinic_id: clinicId,
        metric_date: day.date,
        metric_key: m.key,
        value: m.value,
        measured_at: m.measuredAt,
        provenance: m.provenance ?? "unknown",
        produced_at: m.producedAt ?? null,
        knowledge_as_of: m.knowledgeAsOf ?? null,
        unversioned_inputs: [...(m.unversionedInputs ?? [])],
      })),
      { onConflict: "clinic_id,metric_date,metric_key" },
    );
    if (error) throw new Error(`metric_history write: ${error.message}`);
  }
}
