/**
 * Where the open time is — counted in contiguous, appointment-length gaps, chair
 * layer by chair layer. Every figure below can be checked with a pencil.
 */

import { describe, expect, it } from "vitest";

import type { CapacityDayFact } from "../../../ledger";
import { gapsForDay } from "../capacity-gaps";
import { appointment } from "./opportunity-fixtures";

const DAY = "2026-09-15";
const day = (spans: [string, string][]): CapacityDayFact => ({
  date: DAY,
  startsAt: `${DAY}T00:00:00.000Z`,
  endsAt: `${DAY}T23:59:59.999Z`,
  openSpans: spans.map(([s, e]) => ({ start: `${DAY}T${s}:00.000Z`, end: `${DAY}T${e}:00.000Z` })),
  openMinutesPerChair: spans.reduce((sum, [s, e]) => sum + (Date.parse(`${DAY}T${e}:00Z`) - Date.parse(`${DAY}T${s}:00Z`)) / 60_000, 0),
});
const at = (hhmm: string, over = {}) =>
  appointment({ id: `a_${hhmm}`, scheduledAt: `${DAY}T${hhmm}:00.000Z`, ...over });

describe("gapsForDay", () => {
  it("fits eight half-hour appointments into an empty four-hour span", () => {
    const g = gapsForDay(day([["09:00", "13:00"]]), 1, [], 30);
    expect(g.fittableAppointments).toBe(8);
    expect(g.firstGapAt).toBe(`${DAY}T09:00:00.000Z`);
    expect(g.lastGapEndsAt).toBe(`${DAY}T13:00:00.000Z`);
  });

  it("counts a second chair's uninterrupted time as its own layer", () => {
    // Chair 1 busy 09:00–09:30: layer 1 keeps 09:30–13:00 (7); layer 2 is free
    // all span (8). Total 15, not 16 and not 7.
    expect(gapsForDay(day([["09:00", "13:00"]]), 2, [at("09:00")], 30).fittableAppointments).toBe(15);
  });

  it("does not add up slivers between appointments", () => {
    // 09:00–09:45 booked, 10:00–13:00 booked: a 15-minute sliver is no gap.
    const g = gapsForDay(day([["09:00", "13:00"]]), 1, [at("09:00", { durationMinutes: 45 }), at("10:00", { durationMinutes: 180 })], 30);
    expect(g.fittableAppointments).toBe(0);
    expect(g.openChairMinutes - g.bookedChairMinutes).toBe(15);
  });

  it("ignores cancelled and missed appointments, which hold no chair", () => {
    const g = gapsForDay(day([["09:00", "10:00"]]), 1, [at("09:00", { status: "cancelled" }), at("09:30", { status: "no_show" })], 30);
    expect(g.fittableAppointments).toBe(2);
    expect(g.bookedChairMinutes).toBe(0);
  });

  it("clamps an overbooked moment to zero free chairs rather than going negative", () => {
    const g = gapsForDay(day([["09:00", "10:00"]]), 1, [at("09:00"), at("09:00", { id: "dup" })], 30);
    expect(g.fittableAppointments).toBe(1);
  });

  it("respects a split day and the gap between its spans", () => {
    // 09:00–11:00 and 14:00–15:00: the closed lunch hours are not free time.
    expect(gapsForDay(day([["09:00", "11:00"], ["14:00", "15:00"]]), 1, [], 60).fittableAppointments).toBe(3);
  });

  it("reports nothing on a closed day", () => {
    expect(gapsForDay(day([]), 3, [], 30)).toMatchObject({ fittableAppointments: 0, openChairMinutes: 0, firstGapAt: null });
  });
});
