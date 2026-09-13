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

/** Narrow `unknown` PostgREST payloads to the row shape a query selected. */
function rows<T>(data: unknown): T[] {
  return (data ?? []) as T[];
}

interface AvailabilityRuleRow {
  day_of_week: number;
  start_time: string;
  end_time: string;
  slot_duration_minutes: number;
}

interface UnavailableDateRow {
  date: string;
}

interface ConsultancyBlockDatedRow {
  date: string;
  start_time: string;
  end_time: string;
}

/** Postgres `time` columns arrive as "HH:MM:SS"; the slot engine wants "HH:MM". */
function toHhMm(time: string): string {
  return time.slice(0, 5);
}

/**
 * Day-of-week (0 = Sunday) for a "YYYY-MM-DD" business date.
 * Read from the date string itself — the business date is already clinic-local,
 * so converting it through a timezone again would shift it.
 */
function dayOfWeek(date: string): number {
  return new Date(`${date}T12:00:00.000Z`).getUTCDay();
}

export interface ScheduleInputs {
  readonly rulesByDow: ReadonlyMap<number, AvailabilityRule[]>;
  readonly closedDates: ReadonlySet<string>;
  readonly blocksByDate: ReadonlyMap<string, Array<{ start: string; end: string }>>;
}

/**
 * Schedule inputs for a date RANGE, fetched once.
 *
 * Capacity is per-day, but querying per day would issue three round-trips for
 * every date in a 30-day window. Instead the rules, holidays and consultancy
 * blocks are read once for the widest range needed, and each day is computed
 * from them in memory. Query count is constant however long the window is.
 */
export async function fetchScheduleInputs(
  db: SupabaseClient<Database>,
  clinicId: string,
  from: string,
  to: string,
): Promise<ScheduleInputs> {
  const [rulesResult, unavailableResult, blocksResult] = await Promise.all([
    db
      .from("availability_rules")
      .select("day_of_week, start_time, end_time, slot_duration_minutes")
      .eq("clinic_id", clinicId)
      .eq("is_active", true),
    db.from("unavailable_dates").select("date").eq("clinic_id", clinicId).gte("date", from).lte("date", to),
    db
      .from("consultancy_schedules")
      .select("date, start_time, end_time")
      .eq("clinic_id", clinicId)
      .eq("is_active", true)
      .gte("date", from)
      .lte("date", to),
  ]);

  if (rulesResult.error) throw new Error(`availability_rules: ${rulesResult.error.message}`);
  if (unavailableResult.error) {
    throw new Error(`unavailable_dates: ${unavailableResult.error.message}`);
  }
  if (blocksResult.error) {
    throw new Error(`consultancy_schedules: ${blocksResult.error.message}`);
  }

  const rulesByDow = new Map<number, AvailabilityRule[]>();
  for (const r of rows<AvailabilityRuleRow>(rulesResult.data)) {
    const list = rulesByDow.get(r.day_of_week) ?? [];
    list.push({
      startTime: toHhMm(r.start_time),
      endTime: toHhMm(r.end_time),
      slotDurationMinutes: r.slot_duration_minutes,
    });
    rulesByDow.set(r.day_of_week, list);
  }

  const closedDates = new Set(rows<UnavailableDateRow>(unavailableResult.data).map((u) => u.date));

  const blocksByDate = new Map<string, Array<{ start: string; end: string }>>();
  for (const b of rows<ConsultancyBlockDatedRow>(blocksResult.data)) {
    const list = blocksByDate.get(b.date) ?? [];
    list.push({ start: toHhMm(b.start_time), end: toHhMm(b.end_time) });
    blocksByDate.set(b.date, list);
  }

  return { rulesByDow, closedDates, blocksByDate };
}

/**
 * One chair's open periods on a date, as [start, end) minutes since midnight in
 * the clinic's local time. Empty when the clinic is closed.
 */
export function openSpansOnDate(date: string, inputs: ScheduleInputs): Array<[number, number]> {
  if (inputs.closedDates.has(date)) return [];
  const rules = inputs.rulesByDow.get(dayOfWeek(date)) ?? [];
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
