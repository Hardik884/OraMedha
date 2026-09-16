/**
 * lib/scheduling/schedule-source.ts
 *
 * THE clinic schedule, as booking understands it. One place decides which hours
 * a clinic is open on a date, so booking validation, the slot picker and the
 * Business Brain's capacity can never disagree about it.
 *
 * The rule (unchanged from what booking already did):
 *
 *   1. Active `availability_rules` for the date's weekday, when any exist.
 *   2. Otherwise `clinic_settings.clinic_hours` for that weekday, stepped by
 *      `average_appointment_duration`.
 *   3. A date in `unavailable_dates` is closed whatever the rules say.
 *   4. Active `consultancy_schedules` blocks remove time within the open hours.
 *
 * Dates here are clinic-local calendar dates ("YYYY-MM-DD"). The weekday of a
 * calendar date is a property of the date itself, not of any timezone, so it is
 * computed in UTC from the date string and never from the server's clock.
 */

import { DEFAULT_TIMEZONE } from "@/lib/clinic/constants";
import type { AvailabilityRule } from "./slots";

export interface ClinicDayHours {
  readonly open: string | null;
  readonly close: string | null;
  readonly is_open: boolean;
}

export interface ClinicSchedule {
  readonly timezone: string;
  /** Active rules per weekday (0 = Sunday). A weekday with none is absent. */
  readonly rulesByDow: ReadonlyMap<number, readonly AvailabilityRule[]>;
  readonly clinicHours: Readonly<Record<string, ClinicDayHours>> | null;
  /** Step for slots generated from clinic hours. */
  readonly defaultSlotDurationMinutes: number;
  readonly closedDates: ReadonlySet<string>;
  readonly blocksByDate: ReadonlyMap<string, ReadonlyArray<{ start: string; end: string }>>;
}

const DAY_NAME_TO_DOW: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/** Weekday of a calendar date, 0 = Sunday. Independent of any timezone. */
export function weekdayOf(date: string): number {
  return new Date(`${date.slice(0, 10)}T12:00:00.000Z`).getUTCDay();
}

/** The open windows the clinic books against on a weekday, before closures and blocks. */
export function rulesForWeekday(schedule: ClinicSchedule, dow: number): AvailabilityRule[] {
  const explicit = schedule.rulesByDow.get(dow);
  if (explicit && explicit.length > 0) return [...explicit];
  if (!schedule.clinicHours) return [];
  const rules: AvailabilityRule[] = [];
  for (const [dayName, hours] of Object.entries(schedule.clinicHours)) {
    if (DAY_NAME_TO_DOW[dayName.toLowerCase()] !== dow) continue;
    if (!hours?.is_open || !hours.open || !hours.close) continue;
    rules.push({
      startTime: hours.open.slice(0, 5),
      endTime: hours.close.slice(0, 5),
      slotDurationMinutes: schedule.defaultSlotDurationMinutes,
    });
  }
  return rules;
}

/** The open windows for a date: empty when the clinic is closed that day. */
export function rulesOnDate(schedule: ClinicSchedule, date: string): AvailabilityRule[] {
  if (schedule.closedDates.has(date)) return [];
  return rulesForWeekday(schedule, weekdayOf(date));
}

/** Consultancy blocks on a date, as "HH:MM" ranges. */
export function blocksOnDate(schedule: ClinicSchedule, date: string): Array<{ start: string; end: string }> {
  return [...(schedule.blocksByDate.get(date) ?? [])];
}

/** Whether any schedule is configured at all: rules for some weekday, or clinic hours. */
export function scheduleConfigured(schedule: ClinicSchedule): boolean {
  if ([...schedule.rulesByDow.values()].some((r) => r.length > 0)) return true;
  return [0, 1, 2, 3, 4, 5, 6].some((dow) => rulesForWeekday(schedule, dow).length > 0);
}

interface RuleRow {
  day_of_week: number;
  start_time: string;
  end_time: string;
  slot_duration_minutes: number;
}

interface QueryResult {
  data: unknown;
  error: { message: string } | null;
}

interface ScheduleQueryClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

/**
 * Load a clinic's schedule for an inclusive date range, in four reads whatever
 * the range. Throws on a failed read: an unreadable schedule is not a closed
 * clinic, and an unreadable holiday list is not "no holidays".
 */
export async function loadClinicSchedule(
  db: ScheduleQueryClient,
  clinicId: string,
  from: string,
  to: string,
): Promise<ClinicSchedule> {
  const [settingsResult, rulesResult, closedResult, blocksResult] = (await Promise.all([
    db.from("clinic_settings").select("timezone, clinic_hours, average_appointment_duration").eq("clinic_id", clinicId).maybeSingle(),
    db.from("availability_rules").select("day_of_week, start_time, end_time, slot_duration_minutes").eq("clinic_id", clinicId).eq("is_active", true),
    db.from("unavailable_dates").select("date").eq("clinic_id", clinicId).gte("date", from).lte("date", to),
    db.from("consultancy_schedules").select("date, start_time, end_time").eq("clinic_id", clinicId).eq("is_active", true).gte("date", from).lte("date", to),
  ])) as QueryResult[];

  for (const [label, result] of [
    ["clinic_settings", settingsResult],
    ["availability_rules", rulesResult],
    ["unavailable_dates", closedResult],
    ["consultancy_schedules", blocksResult],
  ] as const) {
    if (result.error) throw new Error(`${label}: ${result.error.message}`);
  }

  const settings = settingsResult.data as {
    timezone?: string | null;
    clinic_hours?: Record<string, ClinicDayHours> | null;
    average_appointment_duration?: number | null;
  } | null;

  const rulesByDow = new Map<number, AvailabilityRule[]>();
  for (const r of (rulesResult.data ?? []) as RuleRow[]) {
    const list = rulesByDow.get(r.day_of_week) ?? [];
    list.push({ startTime: r.start_time.slice(0, 5), endTime: r.end_time.slice(0, 5), slotDurationMinutes: r.slot_duration_minutes });
    rulesByDow.set(r.day_of_week, list);
  }

  const blocksByDate = new Map<string, Array<{ start: string; end: string }>>();
  for (const b of (blocksResult.data ?? []) as { date: string; start_time: string; end_time: string }[]) {
    const list = blocksByDate.get(b.date) ?? [];
    list.push({ start: b.start_time.slice(0, 5), end: b.end_time.slice(0, 5) });
    blocksByDate.set(b.date, list);
  }

  return {
    timezone: settings?.timezone ?? DEFAULT_TIMEZONE,
    rulesByDow,
    clinicHours: settings?.clinic_hours ?? null,
    defaultSlotDurationMinutes: settings?.average_appointment_duration ?? 30,
    closedDates: new Set(((closedResult.data ?? []) as { date: string }[]).map((d) => d.date)),
    blocksByDate,
  };
}
