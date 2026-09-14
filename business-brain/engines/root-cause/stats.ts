/**
 * Business Brain — Root-Cause Engine: the only statistics it uses.
 *
 * Medians and quartiles to describe minutes (robust to one very long visit), and
 * two exact one-sided tests to decide whether a difference is more than chance:
 *
 *   fisherGreater       rates: is the group's event rate higher than everyone
 *                       else's? Exact, from the hypergeometric distribution.
 *   rankSumGreater      measurements: do the group's values tend to be larger?
 *                       Mann-Whitney, exact for small samples, normal with a tie
 *                       correction beyond.
 *
 * An analysis compares many groups at once, so each test is judged against the
 * family's false-positive budget divided by the number of comparisons made
 * (Bonferroni). Without that, noise alone produced a "concentration" for a large
 * share of simulated clinics — see `false-positives.spec.ts`.
 *
 * Nothing here is a model and nothing is random; each function can be checked by
 * hand or against a statistics table.
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

export const round1 = (n: number) => Math.round(n * 10) / 10;
export const round2 = (n: number) => Math.round(n * 100) / 100;

const LOG_FACTORIALS: number[] = [0];
function logFactorial(n: number): number {
  for (let i = LOG_FACTORIALS.length; i <= n; i += 1) LOG_FACTORIALS[i] = LOG_FACTORIALS[i - 1] + Math.log(i);
  return LOG_FACTORIALS[n];
}

function logChoose(n: number, k: number): number {
  return k < 0 || k > n ? Number.NEGATIVE_INFINITY : logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

/**
 * One-sided Fisher exact test: the probability, if events were spread at random
 * across both groups, that the group would hold at least `groupEvents` of them.
 */
export function fisherGreater(groupEvents: number, groupSize: number, restEvents: number, restSize: number): number {
  const total = groupSize + restSize;
  const events = groupEvents + restEvents;
  const denominator = logChoose(total, groupSize);
  let p = 0;
  for (let k = groupEvents; k <= Math.min(events, groupSize); k += 1) {
    p += Math.exp(logChoose(events, k) + logChoose(total - events, groupSize - k) - denominator);
  }
  return Math.min(1, p);
}

/** Largest pooled sample for which the rank-sum distribution is computed exactly. */
const EXACT_RANK_LIMIT = 60;

/**
 * One-sided Mann-Whitney rank-sum test: the probability, if both samples came
 * from the same distribution, of the group's values ranking at least this high.
 *
 * Exact for pooled samples up to 60 (average ranks for ties, counted over every
 * way of choosing the group's ranks); beyond that, the normal approximation with
 * a tie correction and a continuity correction.
 */
export function rankSumGreater(group: readonly number[], rest: readonly number[]): number {
  const n1 = group.length;
  const n2 = rest.length;
  if (n1 === 0 || n2 === 0) return 1;
  const pooled = [...group.map((v) => ({ v, g: true })), ...rest.map((v) => ({ v, g: false }))].sort((a, b) => a.v - b.v);
  const N = pooled.length;
  // Doubled average ranks keep tied ranks integral.
  const doubled = new Array<number>(N);
  const tieSizes: number[] = [];
  for (let i = 0; i < N; ) {
    let j = i;
    while (j + 1 < N && pooled[j + 1].v === pooled[i].v) j += 1;
    for (let k = i; k <= j; k += 1) doubled[k] = i + j + 2;
    tieSizes.push(j - i + 1);
    i = j + 1;
  }
  const observed = pooled.reduce((sum, item, i) => (item.g ? sum + doubled[i] : sum), 0);

  if (N <= EXACT_RANK_LIMIT) {
    // ways[k][s]: ways to choose k of the ranks seen so far with doubled sum s.
    // Updated in place, k and s descending, so each rank is used at most once —
    // the 0/1 knapsack recurrence, with no table copies.
    const maxSum = doubled.reduce((a, b) => a + b, 0);
    const ways: Float64Array[] = Array.from({ length: n1 + 1 }, () => new Float64Array(maxSum + 1));
    ways[0][0] = 1;
    let reach = 0;
    doubled.forEach((r, index) => {
      reach += r;
      for (let k = Math.min(n1, index + 1); k >= 1; k -= 1) {
        const from = ways[k - 1];
        const to = ways[k];
        for (let s = reach; s >= r; s -= 1) to[s] += from[s - r];
      }
    });
    const counts = ways[n1];
    let atLeast = 0;
    let all = 0;
    for (let s = 0; s <= maxSum; s += 1) {
      all += counts[s];
      if (s >= observed) atLeast += counts[s];
    }
    return all === 0 ? 1 : Math.min(1, atLeast / all);
  }

  const rankSum = observed / 2;
  const mean = (n1 * (N + 1)) / 2;
  const tieTerm = tieSizes.reduce((sum, t) => sum + (t * t * t - t), 0) / (N * (N - 1));
  const variance = ((n1 * n2) / 12) * (N + 1 - tieTerm);
  if (variance <= 0) return 1;
  const z = (rankSum - mean - 0.5) / Math.sqrt(variance);
  return 1 - normalCdf(z);
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf), accurate to ~1e-7. */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** The per-comparison threshold for a family of `comparisons` sharing one false-positive budget. */
export function perComparisonAlpha(familyAlpha: number, comparisons: number): number {
  return familyAlpha / Math.max(1, comparisons);
}
