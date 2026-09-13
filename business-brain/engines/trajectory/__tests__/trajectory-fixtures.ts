/**
 * Daily series for the trajectory specs.
 *
 * `daily(values)` lays values out oldest-first ending TODAY: the last element is
 * today's metric, the rest are history. `null` is a day nothing was measured — a
 * gap, never a zero. Thirty-six values give the full 35-day history plus today.
 */

import type { Metric } from "../../../domain";
import { buildMetric, MetricKey } from "../../metrics/metric-ids";
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

export function daily(
  values: readonly (number | null)[],
  key: MetricKey = CANCELLATIONS,
  clinicId: string = CLINIC,
  date: string = DATE,
): Pick<TrajectoryInput, "current" | "history"> {
  const history: { date: string; metrics: Metric[] }[] = [];
  let current: Metric[] = [];
  values.forEach((value, i) => {
    const day = addDays(date, i - (values.length - 1));
    if (value === null) return;
    const metric = buildMetric(key, value, clinicId, day, `${day}T12:00:00.000Z`);
    if (day === date) current = [metric];
    else history.push({ date: day, metrics: [metric] });
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
