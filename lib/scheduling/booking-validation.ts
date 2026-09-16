/**
 * lib/scheduling/booking-validation.ts
 *
 * THE availability check for every way an appointment gets a time: staff
 * booking, portal booking, the patient AI assistant, rescheduling, follow-up
 * auto-booking — and the slot list those screens offer. One rule set, so a slot
 * the picker offers is a slot the server accepts, and no path books a time
 * another path would refuse.
 *
 *   hours       the clinic schedule (lib/scheduling/schedule-source.ts): active
 *               rules for the weekday, else clinic hours
 *   fit         the whole appointment fits inside an open window
 *   closures    a holiday closes the day, and consultancy blocks remove time —
 *               for today and later. Staff may still record a visit on a past
 *               day that was later marked closed.
 *   conflicts   no overlap with the dentist's other live appointments, read
 *               through a server-privileged client: a portal patient's own
 *               session can see only their own appointments, so checking with it
 *               let a patient book over someone else's visit
 *   past        patient-facing bookings cannot choose a past day or a slot that
 *               has already started today; staff may enter historical visits
 *   timezone    every date and time is clinic-local wall clock; the weekday is a
 *               property of the date, never of the server's clock
 */

import { getAvailableSlots as computeSlots, type OccupiedSlot } from "./slots";
import {
  blocksOnDate,
  loadClinicSchedule,
  rulesForWeekday,
  rulesOnDate,
  weekdayOf,
  type ClinicSchedule,
} from "./schedule-source";
import { getUtcBoundariesForLocalDate, zonedDateToUTC } from "@/lib/utils";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = any;

export const SLOT_UNAVAILABLE_ERROR = "Selected time slot is not available. Please choose from the available slots.";
export const DAY_UNAVAILABLE_ERROR = "No availability configured for that day. Please choose another date.";
export const SLOT_TAKEN_ERROR = "This time slot is already booked. Please choose another.";
export const PAST_BOOKING_ERROR = "Cannot create an appointment in the past.";

/** The clinic-local calendar date and minutes since midnight of an instant. */
export function localClock(now: Date, timezone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

export interface SlotListOptions {
  /** Portal patients and the AI assistant: no past days, no started slots today. */
  readonly patientFacing: boolean;
  readonly now: Date;
  /**
   * Hide slots that have already started today even for staff. The slot list
   * does (a picker offering 09:00 at 15:00 is noise); the server's validation
   * does not, so staff can still record a walk-in who arrived earlier.
   */
  readonly hideStartedSlotsToday?: boolean;
}

/**
 * Bookable start times ("YYYY-MM-DDTHH:MM:00", clinic-local) on a date, given
 * the schedule and the dentist's live appointments that day. Pure.
 */
export function bookableSlots(
  schedule: ClinicSchedule,
  date: string,
  occupied: readonly OccupiedSlot[],
  durationMinutes: number,
  options: SlotListOptions,
): string[] {
  const today = localClock(options.now, schedule.timezone);
  if (options.patientFacing && date < today.date) return [];
  const applyClosures = date >= today.date;
  const rules = applyClosures ? rulesOnDate(schedule, date) : rulesForWeekday(schedule, weekdayOf(date));
  if (rules.length === 0) return [];
  const hideStarted = options.patientFacing || options.hideStartedSlotsToday === true;
  const cutoff = hideStarted && date === today.date ? today.minutes : null;
  return computeSlots(
    date,
    rules,
    [...occupied],
    schedule.timezone,
    durationMinutes,
    cutoff,
    applyClosures ? blocksOnDate(schedule, date) : [],
  );
}

/** The dentist's live (not cancelled, not missed, not deleted) appointments on a clinic-local date. */
export async function loadOccupancy(
  occupancyDb: DbClient,
  params: { clinicId: string; dentistId: string; date: string; timezone: string; excludeAppointmentId?: string },
): Promise<OccupiedSlot[]> {
  const { start, end } = getUtcBoundariesForLocalDate(params.date, params.timezone);
  let query = occupancyDb
    .from("appointments")
    .select("id, scheduled_at, duration_minutes")
    .eq("clinic_id", params.clinicId)
    .eq("dentist_id", params.dentistId)
    .gte("scheduled_at", start)
    .lte("scheduled_at", end)
    .is("deleted_at", null)
    .not("status", "in", '("cancelled","no_show")');
  if (params.excludeAppointmentId) query = query.neq("id", params.excludeAppointmentId);
  const { data, error } = await query;
  if (error) throw new Error(`appointments: ${error.message}`);
  return ((data ?? []) as { scheduled_at: string; duration_minutes: number | null }[]).map((o) => ({
    scheduledAt: o.scheduled_at,
    durationMinutes: o.duration_minutes ?? 30,
  }));
}

export type SlotCheck =
  | { readonly ok: true; readonly scheduledAtUtc: string; readonly timezone: string }
  | { readonly ok: false; readonly reason: "past" | "closed" | "taken" | "unavailable"; readonly error: string };

export interface SlotRequest {
  readonly clinicId: string;
  readonly dentistId: string;
  /** Clinic-local wall clock, "YYYY-MM-DDTHH:MM" with optional seconds. */
  readonly localSlot: string;
  readonly durationMinutes: number;
  /** The appointment being moved, when rescheduling. */
  readonly excludeAppointmentId?: string;
  readonly patientFacing: boolean;
  readonly now: Date;
}

/**
 * Whether a requested time may be booked. `db` reads the clinic schedule with the
 * caller's own session; `occupancyDb` reads other appointments' times and must be
 * a server-privileged client (see "conflicts" above). Throws when a read fails:
 * an unreadable schedule is never an available one.
 */
export async function checkBookingSlot(db: DbClient, occupancyDb: DbClient, req: SlotRequest): Promise<SlotCheck> {
  const date = req.localSlot.slice(0, 10);
  const schedule = await loadClinicSchedule(db, req.clinicId, date, date);
  const today = localClock(req.now, schedule.timezone).date;

  if (req.patientFacing && date < today) return { ok: false, reason: "past", error: PAST_BOOKING_ERROR };

  const open = date >= today ? rulesOnDate(schedule, date) : rulesForWeekday(schedule, weekdayOf(date));
  if (open.length === 0) return { ok: false, reason: "closed", error: DAY_UNAVAILABLE_ERROR };

  const occupied = await loadOccupancy(occupancyDb, {
    clinicId: req.clinicId,
    dentistId: req.dentistId,
    date,
    timezone: schedule.timezone,
    excludeAppointmentId: req.excludeAppointmentId,
  });
  const scheduledAtUtc = zonedDateToUTC(`${req.localSlot.slice(0, 16)}:00`, schedule.timezone).toISOString();
  if (occupied.some((o) => Date.parse(o.scheduledAt) === Date.parse(scheduledAtUtc))) {
    return { ok: false, reason: "taken", error: SLOT_TAKEN_ERROR };
  }

  const slots = bookableSlots(schedule, date, occupied, req.durationMinutes, { patientFacing: req.patientFacing, now: req.now });
  if (!slots.some((s) => s.slice(0, 16) === req.localSlot.slice(0, 16))) {
    return { ok: false, reason: "unavailable", error: SLOT_UNAVAILABLE_ERROR };
  }
  return { ok: true, scheduledAtUtc, timezone: schedule.timezone };
}
