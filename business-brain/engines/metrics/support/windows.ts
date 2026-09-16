/**
 * Metrics Engine — trailing-window helpers
 *
 * Shared by the revenue and treatment calculators so "the last 30 days" means
 * exactly one thing. Two calculators disagreeing by a day would make production
 * and average case value quietly inconsistent with each other.
 *
 * All arithmetic is on "YYYY-MM-DD" strings via the shared calendar helpers —
 * no `Date`, no timezone, no clock. ISO dates compare correctly as strings,
 * which is what makes the window filters safe.
 */

import type {
  AppointmentSnapshot,
  ClinicDataSnapshot,
  PaymentSnapshot,
  ScheduleWindow,
  TreatmentSnapshot,
} from "../../../repositories";
import { addDays, localDatePart } from "../../../utils";

/**
 * Inclusive first day of a trailing window ending on `date`.
 * A 30-day window ending 2026-07-28 starts on 2026-06-29 — 30 days inclusive.
 */
export function windowStart(date: string, days: number): string {
  return addDays(date, -(days - 1));
}

/** The clinic-local business date of an ISO timestamp in this snapshot. */
export function datePart(iso: string, s: Pick<ClinicDataSnapshot, "timezone">): string {
  return localDatePart(iso, s.timezone);
}

/**
 * Treatments completed inside the trailing window, dated by `performedAt`.
 * A completed treatment with no `performedAt` is excluded: without a date it
 * cannot be attributed to a window.
 */
export function completedInWindow(
  s: ClinicDataSnapshot,
  days: number,
): readonly TreatmentSnapshot[] {
  const from = windowStart(s.date, days);
  return s.treatments.filter(
    (t) =>
      t.status === "completed" &&
      t.performedAt !== null &&
      datePart(t.performedAt, s) >= from &&
      datePart(t.performedAt, s) <= s.date,
  );
}

/** Payments received inside the trailing window. */
export function paymentsInWindow(
  s: ClinicDataSnapshot,
  days: number,
): readonly PaymentSnapshot[] {
  const from = windowStart(s.date, days);
  return s.payments.filter((p) => p.paymentDate >= from && p.paymentDate <= s.date);
}

/**
 * Whether an appointment still occupies its slot.
 *
 * A cancelled or no-show appointment frees the chair, so it must not count as
 * booked. Shared with the single-day capacity calculators so daily and windowed
 * utilization cannot drift apart.
 */
export function occupiesSlot(status: string): boolean {
  return status !== "cancelled" && status !== "no_show";
}

/**
 * Chair-minutes consumed by a set of appointments.
 *
 * The unit of capacity is time, not appointment count: a 10-minute check and a
 * 60-minute root canal are one appointment each but six times apart in chair
 * use. Counting them equally is what made a busy clinic read as idle.
 *
 * A missing or nonsensical duration falls back to 30 minutes rather than 0.
 * Zero would silently erase a real booking from the numerator and report the
 * chair as free while a patient is in it; 30 is the schema default and the
 * OraMedha-wide default appointment length, so the fallback is the same
 * assumption the booking screen already makes.
 */
export function bookedMinutes(appointments: readonly AppointmentSnapshot[]): number {
  return appointments
    .filter((a) => occupiesSlot(a.status))
    .reduce((sum, a) => sum + (a.durationMinutes > 0 ? a.durationMinutes : 30), 0);
}

/**
 * Fill rate for a window: booked chair-minutes as a percentage of open ones.
 *
 * Returns `null` when the clinic offered no capacity at all across the range —
 * a fill rate against zero open time is undefined, and 0% would read as "nobody
 * booked" when the truth is "we were never open".
 *
 * Capped at 100% for overbooking, matching the single-day calculator.
 */
export function fillRate(window: ScheduleWindow): number | null {
  if (window.openChairMinutes <= 0) {
    return null;
  }
  const raw = (bookedMinutes(window.appointments) / window.openChairMinutes) * 100;
  return Math.round(Math.min(100, raw) * 10) / 10;
}

/** Share of a window's appointments in a given status, as a percentage. */
export function statusRate(window: ScheduleWindow, status: string): number | null {
  const total = window.appointments.length;
  if (total === 0) {
    return null;
  }
  const matching = window.appointments.filter((a) => a.status === status).length;
  return Math.round((matching / total) * 1000) / 10;
}

/** Median of a non-empty numeric list. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
