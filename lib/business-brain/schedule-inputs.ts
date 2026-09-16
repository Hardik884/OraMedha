/**
 * lib/business-brain/schedule-inputs.ts
 *
 * The clinic's published hours for a date range, read once, and the two
 * questions asked of them: how many minutes is one chair open on a date, and
 * WHEN.
 *
 * Shared by the metrics repository (which needs the minutes, for utilization)
 * and the clinic ledger (which needs the spans, for opportunity gaps). One
 * definition, so a gap the Opportunity Engine finds can never sit in time the
 * utilization metric does not count as open — and so a change to how
 * consultancy blocks or closed dates are applied lands in both at once.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { dateRange } from "@/business-brain";
import type { Database } from "@/types/database.types";
import { openSpans, type AvailabilityRule } from "@/lib/scheduling/slots";
import { loadClinicSchedule, rulesForWeekday, weekdayOf } from "@/lib/scheduling/schedule-source";

export interface ScheduleInputs {
  readonly rulesByDow: ReadonlyMap<number, AvailabilityRule[]>;
  readonly closedDates: ReadonlySet<string>;
  readonly blocksByDate: ReadonlyMap<string, Array<{ start: string; end: string }>>;
}

/**
 * Schedule inputs for a date RANGE, fetched once.
 *
 * Capacity is per-day, but querying per day would issue round-trips for every
 * date in a 30-day window. Instead the schedule is read once for the widest
 * range needed, and each day is computed from it in memory.
 *
 * The schedule is booking's own (`lib/scheduling/schedule-source.ts`): active
 * availability rules for a weekday, otherwise the clinic's opening hours, less
 * holidays and consultancy blocks. The Business Brain never keeps a second idea
 * of when the clinic is open — a clinic configured by opening hours alone used
 * to read here as closed every day while it took bookings.
 */
export async function fetchScheduleInputs(
  db: SupabaseClient<Database>,
  clinicId: string,
  from: string,
  to: string,
): Promise<ScheduleInputs> {
  const schedule = await loadClinicSchedule(db, clinicId, from, to);
  const rulesByDow = new Map<number, AvailabilityRule[]>();
  for (let dow = 0; dow < 7; dow += 1) {
    const rules = rulesForWeekday(schedule, dow);
    if (rules.length > 0) rulesByDow.set(dow, rules);
  }
  const blocksByDate = new Map<string, Array<{ start: string; end: string }>>();
  for (const [date, blocks] of schedule.blocksByDate) blocksByDate.set(date, [...blocks]);
  return { rulesByDow, closedDates: new Set(schedule.closedDates), blocksByDate };
}

/**
 * One chair's open periods on a date, as [start, end) minutes since midnight in
 * the clinic's local time. Empty when the clinic is closed.
 */
export function openSpansOnDate(date: string, inputs: ScheduleInputs): Array<[number, number]> {
  if (inputs.closedDates.has(date)) return [];
  const rules = inputs.rulesByDow.get(weekdayOf(date)) ?? [];
  if (rules.length === 0) return [];
  return openSpans(rules, inputs.blocksByDate.get(date) ?? []);
}

/**
 * Minutes one chair is open on a date: the union of that weekday's active
 * rules, less any consultancy block, zero when the clinic is shut.
 *
 * Deliberately NOT `getAvailableSlots(...).length` — its return is a list of
 * overlapping candidate START TIMES, and counting them inflates capacity by the
 * ratio of appointment length to step size. See CLAUDE.md §5.10.
 */
export function openMinutesOnDate(date: string, inputs: ScheduleInputs): number {
  return openSpansOnDate(date, inputs).reduce((sum, [start, end]) => sum + (end - start), 0);
}

/** Open minutes per chair summed across an inclusive date range. */
export function openMinutesInRange(from: string, to: string, inputs: ScheduleInputs): number {
  return dateRange(from, to).reduce((sum, d) => sum + openMinutesOnDate(d, inputs), 0);
}
