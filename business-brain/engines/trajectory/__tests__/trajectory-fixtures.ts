/**
 * Daily series for the trajectory specs.
 *
 * `daily(values)` lays values out oldest-first ending TODAY: the last element is
 * today's metric, the rest are history. `null` is a day nothing was measured — a
 * gap, never a zero. Thirty-six values give the full 35-day history plus today.
 */

import type { Metric } from "../../../domain";
import { buildMetric, MetricKey } from "../../metrics/metric-ids";
import { rateBasisFor } from "../../metrics/metric-bounds";
import { addDays } from "../../../utils";
import type { TrajectoryInput } from "../trajectory-engine";

export const CLINIC = "clinic_a";
export const OTHER = "clinic_b";
export const DATE = "2026-10-05";
export const CANCELLATIONS = MetricKey.SCHEDULING_CANCELLATION_RATE_30D;
export const UTILIZATION = MetricKey.CAPACITY_CHAIR_UTILIZATION_30D;

/** Repeat `value` for `days` days. */
export const flat = (value: number, days: number): number[] => Array.from({ length: days }, () => value);

/** A day-by-day ramp from `from` to `to`, inclusive, over `days` days. */
export const ramp = (from: number, to: number, days: number): number[] =>
  Array.from({ length: days }, (_, i) => Math.round((from + ((to - from) * i) / Math.max(1, days - 1)) * 100) / 100);

/**
 * Appointments behind each day's rate, unless a test says otherwise.
 *
 * CANCELLATIONS is a rate, and a rate never travels without its denominator in
 * production: the Baseline Engine behind the reference range drops days too
 * small to carry one. Supplying an ample denominator by default keeps every
 * scenario here about the TRAJECTORY, which is what it is testing.
 */
export const AMPLE_SAMPLE = 90;

export function daily(
  values: readonly (number | null)[],
  key: MetricKey = CANCELLATIONS,
  clinicId: string = CLINIC,
  date: string = DATE,
  /** Denominator per day, in the same order. Defaults to an ample one. */
  samples?: readonly (number | null)[],
): Pick<TrajectoryInput, "current" | "history"> {
  const basis = rateBasisFor(key);
  const history: { date: string; metrics: Metric[] }[] = [];
  let current: Metric[] = [];
  values.forEach((value, i) => {
    const day = addDays(date, i - (values.length - 1));
    if (value === null) return;
    const asOf = `${day}T12:00:00.000Z`;
    const sample = samples === undefined ? AMPLE_SAMPLE : samples[i];
    const metrics = [
      buildMetric(key, value, clinicId, day, asOf),
      ...(basis === undefined || sample === null || sample === undefined
        ? []
        : [buildMetric(basis.denominatorKey, sample, clinicId, day, asOf)]),
    ];
    if (day === date) current = metrics;
    else history.push({ date: day, metrics });
  });
  return { current, history };
}

/** Merge several single-metric series into one input. */
export function combine(...parts: Pick<TrajectoryInput, "current" | "history">[]): Pick<TrajectoryInput, "current" | "history"> {
  const byDate = new Map<string, Metric[]>();
  for (const part of parts) {
    for (const day of part.history) byDate.set(day.date, [...(byDate.get(day.date) ?? []), ...day.metrics]);
  }
  return {
    current: parts.flatMap((p) => p.current),
    history: [...byDate.entries()].map(([date, metrics]) => ({ date, metrics })),
  };
}
