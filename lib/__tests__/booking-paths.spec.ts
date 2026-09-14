/**
 * Every booking path uses the one availability check.
 *
 * Server actions cannot be invoked outside a Next.js request, so the rule is
 * held here at the source: each action that gives an appointment a time calls
 * lib/scheduling/booking-validation.ts, and none rebuilds its own slot rules —
 * which is how staff booking, portal booking, rescheduling and follow-up
 * auto-booking came to disagree about holidays, blocks and double bookings.
 * The validator itself is tested in lib/scheduling/__tests__ and against the
 * real stack in actions/__tests__/pms-hardening-db.spec.ts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
const source = (p: string) => readFileSync(join(root, p), "utf8");

/** The body of one exported function, up to the next top-level export. */
function fn(file: string, name: string): string {
  const s = source(file);
  const start = s.indexOf(`export async function ${name}(`);
  expect(start, `${name} not found in ${file}`).toBeGreaterThan(-1);
  const next = s.indexOf("\nexport ", start + 1);
  return s.slice(start, next === -1 ? undefined : next);
}

describe("booking paths", () => {
  it("createAppointment, rescheduleAppointment and follow-up auto-booking validate through checkBookingSlot", () => {
    expect(fn("actions/appointments.ts", "createAppointment")).toContain("checkBookingSlot(");
    expect(fn("actions/appointments.ts", "rescheduleAppointment")).toContain("checkBookingSlot(");
    expect(fn("actions/follow-ups.ts", "createFollowUp")).toContain("checkBookingSlot(");
  });

  it("the slot list uses the same schedule and rules", () => {
    const body = fn("actions/availability.ts", "getAvailableSlots");
    expect(body).toContain("loadClinicSchedule(");
    expect(body).toContain("bookableSlots(");
  });

  it("no action rebuilds slot rules or reads occupancy with its own filters", () => {
    for (const file of ["actions/appointments.ts", "actions/availability.ts", "actions/follow-ups.ts"]) {
      const s = source(file);
      expect({ file, engine: /from "@\/lib\/scheduling\/slots"/.test(s) }).toEqual({ file, engine: false });
      expect({ file, rules: s.includes('.from("availability_rules")') && !file.endsWith("availability.ts") }).toEqual({ file, rules: false });
    }
  });
});

describe("follow-up auto-booking", () => {
  const body = fn("actions/follow-ups.ts", "createFollowUp");

  it("keeps the follow-up and says so when the time is not available", () => {
    expect(source("actions/follow-ups.ts")).toContain("Follow-up saved — that time isn't available.");
    expect(body).toContain("bookingNotice");
    expect(source("components/follow-ups/FollowUpForm.tsx")).toContain("toast.warning(bookingNotice)");
  });

  it("never repoints the follow-up's originating appointment at the recall visit", () => {
    expect(body).not.toMatch(/\.from\("follow_ups"\)\s*\.update\(/);
  });

  it("lists a recall visit's follow-up under that visit without rewriting any link", () => {
    const list = fn("actions/follow-ups.ts", "getFollowUpsForAppointment");
    expect(list).toContain("follow_up_id");
    expect(list).not.toContain(".update(");
  });
});

describe("rescheduling", () => {
  const body = fn("actions/appointments.ts", "rescheduleAppointment");

  it("refuses to move a patient who is in today's live queue", () => {
    expect(body).toContain("Patient is in today's queue — remove them first");
    expect(body).toMatch(/\.is\("removed_at", null\)/);
  });

  it("lets a portal patient move only their own upcoming scheduled appointment", () => {
    expect(body).toMatch(/lookup\.eq\("patient_id", linkedPatientId/);
    expect(body).toMatch(/currentAppt\.status !== "scheduled"/);
    expect(body).toMatch(/\.eq\("patient_id", linkedPatientId\)\.eq\("status", "scheduled"\)/);
  });
});
