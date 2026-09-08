/**
 * lib/scheduling/__tests__/consultancy-blocking.spec.ts
 *
 * A reserved external-consultation slot must be unbookable.
 *
 * WHY THIS IS NEW
 *   `consultancy_schedules` and the `blockedRanges` argument have existed since
 *   20260706000000 / 20260707000000, but the blocks were only reachable from
 *   Clinic Settings and nothing in the product created one during the flow that
 *   needed it — recording an external consultation captured a date and an
 *   amount, so the dentist's afternoon elsewhere stayed bookable.
 *
 *   Recording a consultation with a time now writes that block
 *   (actions/consultants.ts), which makes this path load-bearing for a booking
 *   guarantee for the first time. openMinutes' blocks are covered by
 *   open-minutes.spec.ts, but that is CAPACITY — how much chair time exists.
 *   This is the different question the booking screens ask: which start times
 *   may be offered.
 */

import { describe, expect, it } from "vitest";

import { getAvailableSlots, type AvailabilityRule } from "../slots";

/** A single 09:00–18:00 window, stepped hourly. */
const NINE_TO_SIX: AvailabilityRule[] = [
  { startTime: "09:00", endTime: "18:00", slotDurationMinutes: 60 },
];

const DATE = "2026-09-14";
const TZ = "Asia/Kolkata";

/** "2026-09-14T14:00:00" → "14:00" */
const at = (slot: string) => slot.slice(11, 16);

function slots(
  blocked: Array<{ start: string; end: string }>,
  durationMinutes = 60
): string[] {
  return getAvailableSlots(DATE, NINE_TO_SIX, [], TZ, durationMinutes, null, blocked).map(at);
}

describe("external consultation blocks", () => {
  it("offers the whole day when nothing is reserved", () => {
    expect(slots([])).toEqual([
      "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00",
    ]);
  });

  it("removes every start time inside a reserved slot", () => {
    const available = slots([{ start: "14:00", end: "17:00" }]);

    // The reserved window itself is gone…
    expect(available).not.toContain("14:00");
    expect(available).not.toContain("15:00");
    expect(available).not.toContain("16:00");

    // …and nothing outside it was lost. 17:00 survives because a 60-minute
    // appointment starting then ends at 18:00, which is still inside the rule.
    expect(available).toEqual(["09:00", "10:00", "11:00", "12:00", "13:00", "17:00"]);
  });

  it("removes a start time whose appointment would RUN INTO the block", () => {
    // 13:00 is outside a 14:00 block, but a 90-minute appointment booked then
    // would still be in the chair at 14:30. Overlap is what matters, not the
    // start time alone — this is the case a naive "is the start blocked?" check
    // gets wrong.
    const available = slots([{ start: "14:00", end: "17:00" }], 90);
    expect(available).not.toContain("13:00");
    expect(available).toContain("12:00");
  });

  it("leaves the day untouched when the block falls outside opening hours", () => {
    expect(slots([{ start: "19:00", end: "21:00" }])).toEqual(slots([]));
  });

  it("handles several reservations on one day", () => {
    const available = slots([
      { start: "10:00", end: "11:00" },
      { start: "15:00", end: "16:00" },
    ]);
    expect(available).toEqual(["09:00", "11:00", "12:00", "13:00", "14:00", "16:00", "17:00"]);
  });
});
