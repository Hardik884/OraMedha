/**
 * Business Brain — Repositories: Metric History Port
 *
 * The port through which measured metrics are stored and read back.
 *
 * The Business Brain currently recomputes every history day from the live
 * database on each run, which is both slow — a week of history is a week of
 * full clinic snapshots — and, for anything the schema does not version, only an
 * approximation. A measurement that was recorded when it was taken needs no
 * reconstruction at all.
 *
 * An interface, like every other repository here, so the engines and the
 * orchestrator never touch a database client. The Supabase implementation lives
 * in `lib/`, where the rest of the app's data access lives.
 *
 * Deliberately stores MEASUREMENTS ONLY. Signals and diagnoses are pure
 * functions of metrics, so persisting them would create a second source of truth
 * that silently disagrees with the engine the moment a threshold changes. Store
 * what was measured; recompute what was concluded.
 */

import type { MetricReadingProvenance } from "../provenance/metric-provenance";

/** One measured metric on one day. */
export interface StoredMetric {
  /** The engine's MetricKey, e.g. "revenue.outstanding". */
  readonly key: string;
  readonly value: number;
  /** The snapshot moment the measurement was taken at, ISO-8601. */
  readonly measuredAt: string;
  /**
   * How the reading came to exist. Absent on write means unknown; a store never
   * guesses a better provenance than it was given. See migration 20260917100100.
   */
  readonly provenance?: MetricReadingProvenance["provenance"];
  readonly producedAt?: string;
  readonly knowledgeAsOf?: string;
  readonly unversionedInputs?: readonly string[];
}

/** Every metric measured for one clinic on one business date. */
export interface StoredMetricDay {
  /** Business date, "YYYY-MM-DD". */
  readonly date: string;
  readonly metrics: readonly StoredMetric[];
}

export interface MetricHistoryStore {
  /**
   * Read stored measurements for an inclusive date range, ascending by date.
   *
   * A date with no stored row is OMITTED rather than returned empty. The
   * distinction is load-bearing: the Diagnosis Engine reconstructs calendar gaps
   * explicitly and treats a missing day as `unknown`, capping persistence at
   * `intermittent`. A day returned with zero metrics would instead read as a day
   * on which everything measured zero — inventing a quiet day that never
   * happened.
   */
  readMetricDays(
    clinicId: string,
    from: string,
    to: string,
  ): Promise<readonly StoredMetricDay[]>;

  /**
   * Store the measurements for one clinic-day.
   *
   * MUST be idempotent on (clinic, date, key): a day can legitimately be written
   * twice — once by the scheduled job and once by a backfill — and the second
   * write must replace the first rather than duplicate or fail. Re-measuring a
   * past day is also how a correction propagates.
   */
  writeMetricDay(clinicId: string, day: StoredMetricDay): Promise<void>;
}
