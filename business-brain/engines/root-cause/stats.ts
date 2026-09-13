/**
 * Business Brain — Root-Cause Engine: the only statistics it uses.
 *
 * Medians and quartiles for minutes (robust to one very long visit), and Wilson
 * score intervals for rates (honest at small n, never below 0% or above 100%).
 * Nothing here is a model; each function can be checked by hand.
 */

import { median } from "../metrics/support/windows";

export { median };

/** Linear-interpolated quantile of a non-empty list. */
export function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/** Wilson score interval for `events` out of `n`, as proportions in [0, 1]. */
export function wilson(events: number, n: number, z: number): { lower: number; upper: number } {
  if (n === 0) return { lower: 0, upper: 1 };
  const p = events / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}

export const round1 = (n: number) => Math.round(n * 10) / 10;
export const round2 = (n: number) => Math.round(n * 100) / 100;
