import { describe, expect, it } from "vitest";

import {
  DAY_UNAVAILABLE_ERROR,
  PAST_BOOKING_ERROR,
  SLOT_TAKEN_ERROR,
  SLOT_UNAVAILABLE_ERROR,
  bookableSlots,
  checkBookingSlot,
  localClock,
  type SlotRequest,
} from "../booking-validation";
import type { ClinicSchedule } from "../schedule-source";

const TZ = "Asia/Kolkata";
// 2026-09-14 is a Monday. "Now" is Monday 10:05 IST.
const NOW = new Date("2026-09-14T04:35:00.000Z");

const HOURS = {
  monday: { open: "09:00", close: "13:00", is_open: true },
  tuesday: { open: "09:00", close: "13:00", is_open: true },
  sunday: { open: null, close: null, is_open: false },
};

type Row = Record<string, unknown>;

/**
 * A fake PostgREST client. Schedule tables return fixed rows; `appointments`
 * honours the filters booking validation applies, so occupancy is real.
 */
function fakeDb(tables: { settings?: Row | null; rules?: Row[]; closed?: Row[]; blocks?: Row[]; appointments?: Row[] }) {
  const reads: string[] = [];
  const db = {
    from(table: string) {
      reads.push(table);
      const filters: Array<(r: Row) => boolean> = [];
      const rows = (): Row[] => {
        switch (table) {
          case "clinic_settings":
            return tables.settings === undefined ? [{ timezone: TZ, clinic_hours: HOURS, average_appointment_duration: 30 }] : tables.settings ? [tables.settings] : [];
          case "availability_rules":
            return tables.rules ?? [];
          case "unavailable_dates":
            return tables.closed ?? [];
          case "consultancy_schedules":
            return tables.blocks ?? [];
          case "appointments":
            return (tables.appointments ?? []).filter((r) => filters.every((f) => f(r)));
          default:
            return [];
        }
      };
      const api: Record<string, unknown> = {
        select: () => api,
        eq: (c: string, v: unknown) => (table === "appointments" && filters.push((r) => r[c] === v), api),
        neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), api),
        is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), api),
        gte: (c: string, v: string) => (table === "appointments" && filters.push((r) => String(r[c]) >= v), api),
        lte: (c: string, v: string) => (table === "appointments" && filters.push((r) => String(r[c]) <= v), api),
        not: (c: string, _op: string, v: string) => (filters.push((r) => !v.includes(`"${String(r[c])}"`)), api),
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(resolve),
      };
      return api;
    },
  };
  return { db, reads };
}

const appt = (scheduledAt: string, over: Row = {}): Row => ({
  id: crypto.randomUUID(),
  clinic_id: "c1",
  dentist_id: "d1",
  scheduled_at: scheduledAt,
  duration_minutes: 30,
  status: "scheduled",
  deleted_at: null,
  ...over,
});

const request = (over: Partial<SlotRequest> = {}): SlotRequest => ({
  clinicId: "c1",
  dentistId: "d1",
  localSlot: "2026-09-15T10:00",
  durationMinutes: 30,
  patientFacing: false,
  now: NOW,
  ...over,
});

async function check(tables: Parameters<typeof fakeDb>[0], over: Partial<SlotRequest> = {}) {
  const { db } = fakeDb(tables);
  return checkBookingSlot(db, db, request(over));
}

describe("checkBookingSlot", () => {
  it("accepts an open slot and returns its UTC instant in the clinic's timezone", async () => {
    expect(await check({})).toEqual({ ok: true, scheduledAtUtc: "2026-09-15T04:30:00.000Z", timezone: TZ });
  });

  it("refuses a closed weekday", async () => {
    expect(await check({}, { localSlot: "2026-09-13T10:00" })).toMatchObject({ ok: false, reason: "closed", error: DAY_UNAVAILABLE_ERROR });
  });

  it("refuses a time outside hours, or an appointment that would run past closing", async () => {
    expect(await check({}, { localSlot: "2026-09-15T14:00" })).toMatchObject({ ok: false, error: SLOT_UNAVAILABLE_ERROR });
    expect(await check({}, { localSlot: "2026-09-15T12:30", durationMinutes: 60 })).toMatchObject({ ok: false, error: SLOT_UNAVAILABLE_ERROR });
  });

  it("refuses a holiday and a consultancy block on a future date", async () => {
    expect(await check({ closed: [{ date: "2026-09-15" }] })).toMatchObject({ ok: false, reason: "closed" });
    const blocks = [{ date: "2026-09-15", start_time: "09:45:00", end_time: "10:15:00" }];
    expect(await check({ blocks })).toMatchObject({ ok: false, reason: "unavailable" });
    expect(await check({ blocks }, { localSlot: "2026-09-15T11:00" })).toMatchObject({ ok: true });
  });

  it("refuses a double booking at the same start, and an overlapping one", async () => {
    // 10:00 IST = 04:30Z
    expect(await check({ appointments: [appt("2026-09-15T04:30:00.000Z")] })).toMatchObject({ ok: false, reason: "taken", error: SLOT_TAKEN_ERROR });
    // 09:45 IST for 30 minutes overlaps 10:00
    expect(await check({ appointments: [appt("2026-09-15T04:15:00.000Z")] })).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("ignores cancelled, missed, deleted and other-clinic appointments", async () => {
    const at = "2026-09-15T04:30:00.000Z";
    const appointments = [
      appt(at, { status: "cancelled" }),
      appt(at, { status: "no_show" }),
      appt(at, { deleted_at: "2026-09-01T00:00:00.000Z" }),
      appt(at, { clinic_id: "c2" }),
    ];
    expect(await check({ appointments })).toMatchObject({ ok: true });
  });

  it("does not conflict an appointment being moved with itself", async () => {
    const own = appt("2026-09-15T04:30:00.000Z");
    expect(await check({ appointments: [own] }, { excludeAppointmentId: own.id as string })).toMatchObject({ ok: true });
  });

  it("refuses a patient booking a past day or a slot already started today", async () => {
    expect(await check({}, { patientFacing: true, localSlot: "2026-09-08T10:00" })).toMatchObject({ ok: false, reason: "past", error: PAST_BOOKING_ERROR });
    expect(await check({}, { patientFacing: true, localSlot: "2026-09-14T10:00" })).toMatchObject({ ok: false, reason: "unavailable" });
    expect(await check({}, { patientFacing: true, localSlot: "2026-09-14T10:30" })).toMatchObject({ ok: true });
  });

  it("lets staff record a past visit and a walk-in who arrived earlier today", async () => {
    expect(await check({}, { localSlot: "2026-09-08T10:00" })).toMatchObject({ ok: true });
    expect(await check({}, { localSlot: "2026-09-14T09:00" })).toMatchObject({ ok: true });
  });

  it("lets staff record a past visit on a day later marked closed, but never outside hours", async () => {
    const tables = { closed: [{ date: "2026-09-08" }], blocks: [{ date: "2026-09-08", start_time: "09:00:00", end_time: "13:00:00" }] };
    expect(await check(tables, { localSlot: "2026-09-08T10:00" })).toMatchObject({ ok: true });
    expect(await check(tables, { localSlot: "2026-09-08T15:00" })).toMatchObject({ ok: false });
  });

  it("prefers explicit availability rules over clinic hours", async () => {
    const rules = [{ day_of_week: 2, start_time: "14:00:00", end_time: "16:00:00", slot_duration_minutes: 30 }];
    expect(await check({ rules })).toMatchObject({ ok: false });
    expect(await check({ rules }, { localSlot: "2026-09-15T14:30" })).toMatchObject({ ok: true });
  });

  it("uses the clinic's timezone for the day's occupancy window", async () => {
    // Open 00:00-06:00 on Tuesday and Wednesday. Wednesday 01:00 IST is Tuesday
    // 19:30Z: a window drawn in UTC would count it against Tuesday 01:00 IST.
    const night = { open: "00:00", close: "06:00", is_open: true };
    const settings = { timezone: TZ, clinic_hours: { tuesday: night, wednesday: night }, average_appointment_duration: 30 };
    const wednesday = appt("2026-09-15T19:30:00.000Z");
    expect(await check({ settings, appointments: [wednesday] }, { localSlot: "2026-09-15T01:00" })).toMatchObject({ ok: true, scheduledAtUtc: "2026-09-14T19:30:00.000Z" });
    expect(await check({ settings, appointments: [wednesday] }, { localSlot: "2026-09-16T01:00" })).toMatchObject({ ok: false, reason: "taken" });
  });

  it("throws when the schedule cannot be read, rather than calling the clinic open or closed", async () => {
    const failing = {
      from: (table: string) => {
        const api: Record<string, unknown> = {
          select: () => api, eq: () => api, gte: () => api, lte: () => api,
          maybeSingle: () => Promise.resolve({ data: null, error: table === "clinic_settings" ? { message: "down" } : null }),
          then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r),
        };
        return api;
      },
    };
    await expect(checkBookingSlot(failing, failing, request())).rejects.toThrow(/clinic_settings/);
  });
});

describe("bookableSlots agrees with checkBookingSlot", () => {
  const schedule: ClinicSchedule = {
    timezone: TZ,
    rulesByDow: new Map(),
    clinicHours: HOURS,
    defaultSlotDurationMinutes: 30,
    closedDates: new Set(["2026-09-22"]),
    blocksByDate: new Map([["2026-09-15", [{ start: "11:00", end: "12:00" }]]]),
  };

  it("offers exactly the slots validation accepts", async () => {
    const offered = bookableSlots(schedule, "2026-09-15", [], 30, { patientFacing: true, now: NOW });
    expect(offered).toEqual([
      "2026-09-15T09:00:00", "2026-09-15T09:30:00", "2026-09-15T10:00:00", "2026-09-15T10:30:00",
      "2026-09-15T12:00:00", "2026-09-15T12:30:00",
    ]);
    const blocks = [{ date: "2026-09-15", start_time: "11:00:00", end_time: "12:00:00" }];
    for (const time of ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30"]) {
      const accepted = (await check({ blocks }, { patientFacing: true, localSlot: `2026-09-15T${time}` })).ok;
      expect({ time, accepted }).toEqual({ time, accepted: offered.includes(`2026-09-15T${time}:00`) });
    }
  });

  it("offers nothing on a holiday, and hides started slots today when asked", () => {
    expect(bookableSlots(schedule, "2026-09-22", [], 30, { patientFacing: false, now: NOW })).toEqual([]);
    expect(bookableSlots(schedule, "2026-09-14", [], 30, { patientFacing: false, hideStartedSlotsToday: true, now: NOW })[0]).toBe("2026-09-14T10:30:00");
    expect(bookableSlots(schedule, "2026-09-14", [], 30, { patientFacing: false, now: NOW })[0]).toBe("2026-09-14T09:00:00");
  });
});

describe("localClock", () => {
  it("reads the clinic-local date and time, across the date line", () => {
    expect(localClock(new Date("2026-09-14T20:00:00.000Z"), TZ)).toEqual({ date: "2026-09-15", minutes: 90 });
    expect(localClock(new Date("2026-09-14T02:00:00.000Z"), "America/Los_Angeles")).toEqual({ date: "2026-09-13", minutes: 19 * 60 });
  });
});
