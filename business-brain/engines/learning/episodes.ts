/**
 * Business Brain — episodes of a flagged condition across recorded days.
 *
 * Shared by the Learning Engine and Clinic Memory so "an episode" means one thing.
 *
 * Only recorded days count. An episode starts on a flagged day and ends on the
 * first recorded clear day after it. One already running when the records begin
 * is LEFT-CENSORED (its start is unknown); one still running on the last recorded
 * day is open (its end is unknown). Neither has a known length, and neither is
 * given one.
 */

import { daysBetween } from "../../utils";

export interface FlagDay {
  readonly date: string;
  readonly flagged: boolean;
}

export interface Episode {
  readonly start: string;
  /** The first recorded clear day after it, or null while it is still running. */
  readonly end: string | null;
  readonly leftCensored: boolean;
  /** Days from start to end, only for a closed episode with a known start. */
  readonly length: number | null;
}

export function episodesOf(days: readonly FlagDay[]): Episode[] {
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const out: Episode[] = [];
  let start: string | null = null;
  let censored = false;
  let sawClear = false;
  for (const day of sorted) {
    if (day.flagged && start === null) {
      start = day.date;
      censored = !sawClear;
    }
    if (!day.flagged) {
      if (start !== null) out.push({ start, end: day.date, leftCensored: censored, length: censored ? null : daysBetween(start, day.date) });
      start = null;
      sawClear = true;
    }
  }
  if (start !== null) out.push({ start, end: null, leftCensored: censored, length: null });
  return out;
}
