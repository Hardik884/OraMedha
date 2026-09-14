import { describe, expect, it } from "vitest";

import {
  blocksOnDate,
  loadClinicSchedule,
  rulesForWeekday,
  rulesOnDate,
  scheduleConfigured,
  weekdayOf,
  type ClinicSchedule,
} from "../schedule-source";
import { fetchScheduleInputs, openMinutesOnDate } from "@/lib/business-brain/schedule-inputs";

const HOURS = {
  monday: { open: "09:00", close: "13:00", is_open: true },
  tuesday: { open: "09:00", close: "17:00", is_open: true },
  sunday: { open: null, close: null, is_open: false },
};

function schedule(over: Partial<ClinicSchedule> = {}): ClinicSchedule {
  return {
    timezone: "Asia/Kolkata",
    rulesByDow: new Map(),
    clinicHours: HOURS,
    defaultSlotDurationMinutes: 20,
    closedDates: new Set(),
    blocksByDate: new Map(),
    ...over,
  };
}

type Tables = Record<string, Array<Record<string, unknown>> | Record<string, unknown> | null>;

/** A fake client returning fixed rows per table, or an error for a named table. */
function fakeDb(tables: Tables, failing?: string) {
  return {
    from(table: string) {
      const result = failing === table ? { data: null, error: { message: "boom" } } : { data: tables[table] ?? null, error: null };
      const api: Record<string, unknown> = {
        select: () => api,
        eq: () => api,
        gte: () => api,
        lte: () => api,
        maybeSingle: () => Promise.resolve(result),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
      };
      return api;
    },
  };
}

describe("weekdayOf", () => {
  it("is a property of the calendar date, whatever the server timezone", () => {
    expect(weekdayOf("2026-09-14")).toBe(1); // Monday
    expect(weekdayOf("2026-09-13")).toBe(0); // Sunday
    expect(weekdayOf("2026-12-31")).toBe(4);
    expect(weekdayOf("2026-09-14T23:59:59+05:30")).toBe(1);
  });
});

describe("rulesForWeekday", () => {
  it("uses active availability rules when the weekday has any", () => {
    const s = schedule({ rulesByDow: new Map([[1, [{ startTime: "10:00", endTime: "12:00", slotDurationMinutes: 15 }]]]) });
    expect(rulesForWeekday(s, 1)).toEqual([{ startTime: "10:00", endTime: "12:00", slotDurationMinutes: 15 }]);
  });

  it("falls back to clinic hours stepped by the average appointment duration", () => {
    expect(rulesForWeekday(schedule(), 2)).toEqual([{ startTime: "09:00", endTime: "17:00", slotDurationMinutes: 20 }]);
  });

  it("is closed on a weekday the clinic hours mark closed or omit", () => {
    expect(rulesForWeekday(schedule(), 0)).toEqual([]);
    expect(rulesForWeekday(schedule(), 3)).toEqual([]);
    expect(rulesForWeekday(schedule({ clinicHours: null }), 2)).toEqual([]);
  });
});

describe("rulesOnDate and blocks", () => {
  it("closes a holiday whatever the rules say", () => {
    const s = schedule({ closedDates: new Set(["2026-09-15"]) });
    expect(rulesOnDate(s, "2026-09-15")).toEqual([]);
    expect(rulesOnDate(s, "2026-09-22")).toHaveLength(1);
  });

  it("returns the date's consultancy blocks", () => {
    const s = schedule({ blocksByDate: new Map([["2026-09-15", [{ start: "11:00", end: "12:00" }]]]) });
    expect(blocksOnDate(s, "2026-09-15")).toEqual([{ start: "11:00", end: "12:00" }]);
    expect(blocksOnDate(s, "2026-09-16")).toEqual([]);
  });

  it("knows whether any schedule is configured", () => {
    expect(scheduleConfigured(schedule())).toBe(true);
    expect(scheduleConfigured(schedule({ clinicHours: null }))).toBe(false);
  });
});

describe("loadClinicSchedule", () => {
  const tables: Tables = {
    clinic_settings: { timezone: "Asia/Kolkata", clinic_hours: HOURS, average_appointment_duration: 30 },
    availability_rules: [{ day_of_week: 1, start_time: "10:00:00", end_time: "12:00:00", slot_duration_minutes: 15 }],
    unavailable_dates: [{ date: "2026-09-15" }],
    consultancy_schedules: [{ date: "2026-09-22", start_time: "14:00:00", end_time: "15:00:00" }],
  };

  it("reads rules, hours, holidays and blocks, trimming Postgres times", async () => {
    const s = await loadClinicSchedule(fakeDb(tables), "c1", "2026-09-14", "2026-09-30");
    expect(rulesForWeekday(s, 1)).toEqual([{ startTime: "10:00", endTime: "12:00", slotDurationMinutes: 15 }]);
    expect(rulesForWeekday(s, 2)).toEqual([{ startTime: "09:00", endTime: "17:00", slotDurationMinutes: 30 }]);
    expect(s.closedDates.has("2026-09-15")).toBe(true);
    expect(blocksOnDate(s, "2026-09-22")).toEqual([{ start: "14:00", end: "15:00" }]);
  });

  it("throws on a failed read — an unreadable schedule is not a closed clinic", async () => {
    for (const table of Object.keys(tables)) {
      await expect(loadClinicSchedule(fakeDb(tables, table), "c1", "2026-09-14", "2026-09-30")).rejects.toThrow(table);
    }
  });
});

describe("Business Brain capacity uses booking's schedule", () => {
  it("measures a clinic configured by opening hours alone as open", async () => {
    const db = fakeDb({
      clinic_settings: { timezone: "Asia/Kolkata", clinic_hours: HOURS, average_appointment_duration: 30 },
      availability_rules: [],
      unavailable_dates: [{ date: "2026-09-22" }],
      consultancy_schedules: [{ date: "2026-09-15", start_time: "12:00:00", end_time: "13:00:00" }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inputs = await fetchScheduleInputs(db as any, "c1", "2026-09-14", "2026-09-22");
    expect(openMinutesOnDate("2026-09-14", inputs)).toBe(240); // Monday 09–13
    expect(openMinutesOnDate("2026-09-15", inputs)).toBe(420); // Tuesday 09–17 less a one-hour block
    expect(openMinutesOnDate("2026-09-13", inputs)).toBe(0); // Sunday closed
    expect(openMinutesOnDate("2026-09-22", inputs)).toBe(0); // holiday
  });
});
