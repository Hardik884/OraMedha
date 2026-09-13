/**
 * lib/scheduling/slots.ts
 *
 * Pure slot generation + overlap prevention engine.
 * No DB calls — all data is passed in by the caller (actions/availability.ts).
 * Intentionally pure so it can be tested without DB access.
 *
 * Algorithm (duration-aware):
 * 1. Receive active availability rules for the requested date's day_of_week.
 * 2. For each rule, generate candidate slot start times between start_time and
 *    end_time at slot_duration_minutes intervals.
 * 3. For each candidate, verify that [slot_start, slot_start + requestedDuration)
 *    does NOT overlap any existing booked appointment's occupied window
 *    [appt_start, appt_start + appt_duration).
 * 4. Also verify the entire requested window fits within the rule's [start, end).
 * 5. Optionally filter out slots whose start time is before nowCutoffMinutes
 *    (used when the requested date is today, to hide past slots).
 * 6. Return sorted ISO datetime strings for valid slots only.
 *
 * This supports variable-duration appointments:
 *   - A 60-min root canal cannot fit in a 30-min gap.
 *   - A 10-min consultation can fit in many gaps a root canal could not.
 */

export interface AvailabilityRule {
  startTime: string; // "HH:MM"
  endTime: string;   // "HH:MM"
  slotDurationMinutes: number; // step size for generating candidates
}

export interface OccupiedSlot {
  scheduledAt: string;         // ISO datetime — start of the booked appointment
  durationMinutes?: number;    // duration of the booked appointment (default 30)
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Parse "HH:MM" → total minutes from midnight */
export function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Convert total minutes from midnight → "HH:MM" */
function fromMinutes(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60)
    .toString()
    .padStart(2, "0");
  const m = (totalMinutes % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

// ── Core functions ─────────────────────────────────────────────────────────────

/**
 * generateSlots
 *
 * Generates all candidate slot start times for a single availability rule.
 * Uses rule.slotDurationMinutes as the step size.
 * Returns an array of "HH:MM" time strings.
 */
export function generateSlots(rule: AvailabilityRule): string[] {
  const slots: string[] = [];

  const startMins = toMinutes(rule.startTime);
  const endMins = toMinutes(rule.endTime);

  let current = startMins;

  while (current < endMins) {
    slots.push(fromMinutes(current));
    current += rule.slotDurationMinutes;
  }

  return slots;
}

/**
 * getAvailableSlots
 *
 * Returns available ISO datetime strings for the given date after:
 * 1. Generating candidate times from availability rules.
 * 2. Filtering out slots where [candidate, candidate + requestedDuration)
 *    would overlap any occupied appointment window.
 * 3. Filtering out slots where the full window would exceed the rule boundary.
 * 4. Filtering out slots that are in the past (when nowCutoffMinutes is set).
 *
 * @param date                   - ISO date string "YYYY-MM-DD"
 * @param rules                  - Active availability rules for the date's day_of_week
 * @param occupied               - Existing booked (non-cancelled/no-show) appointments
 * @param timezone               - IANA timezone (e.g. "Asia/Kolkata")
 * @param requestedDurationMinutes - Duration of the appointment being booked (default 30)
 * @param nowCutoffMinutes       - Current time in minutes-since-midnight (clinic timezone).
 *                                 When provided, all slots starting at or before this
 *                                 value are filtered out. Pass null/undefined for
 *                                 future dates where no cutoff is needed.
 * @param blockedRanges          - Time ranges ("HH:MM") blocked by external consultancy
 *                                 schedules. Any candidate overlapping one is removed.
 */
export function getAvailableSlots(
  date: string,
  rules: AvailabilityRule[],
  occupied: OccupiedSlot[],
  timezone: string,
  requestedDurationMinutes = 30,
  nowCutoffMinutes?: number | null,
  blockedRanges?: Array<{ start: string; end: string }>
): string[] {
  if (rules.length === 0) return [];

  // Build blocked windows (consultancy schedules) as [start, end) minute pairs.
  const blockedWindows: Array<[number, number]> = (blockedRanges ?? []).map(
    (range) => [toMinutes(range.start), toMinutes(range.end)]
  );

  // Build occupied windows as [startMinutes, endMinutes) pairs
  const occupiedWindows: Array<[number, number]> = occupied.map((slot) => {
    const d = new Date(slot.scheduledAt);
    const localTime = d
      .toLocaleTimeString("en-GB", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
      .slice(0, 5); // "HH:MM"

    const startMins = toMinutes(localTime);
    const duration = slot.durationMinutes ?? 30;
    return [startMins, startMins + duration];
  });

  const availableSlots: string[] = [];

  for (const rule of rules) {
    const candidates = generateSlots(rule);
    const ruleEndMins = toMinutes(rule.endTime);

    for (const candidateTime of candidates) {
      const candidateStart = toMinutes(candidateTime);
      const candidateEnd = candidateStart + requestedDurationMinutes;

      // 1. Entire slot must fit within the rule window
      if (candidateEnd > ruleEndMins) continue;

      // 2. Filter out past slots when a cutoff is provided (today only)
      //    A slot is considered past if it has already started (start <= now).
      //    We use strict ">" so that the CURRENT slot (just started) is also hidden.
      if (nowCutoffMinutes != null && candidateStart <= nowCutoffMinutes) continue;

      // 3. Slot must not overlap any occupied window
      const hasOverlap = occupiedWindows.some(([occStart, occEnd]) => {
        return candidateStart < occEnd && candidateEnd > occStart;
      });
      if (hasOverlap) continue;

      // 4. Slot must not overlap any consultancy-blocked window
      const isBlocked = blockedWindows.some(([blockStart, blockEnd]) => {
        return candidateStart < blockEnd && candidateEnd > blockStart;
      });
      if (isBlocked) continue;

      availableSlots.push(`${date}T${candidateTime}:00`);
    }
  }

  // Sort chronologically and deduplicate (multiple rules could produce same time)
  const unique = [...new Set(availableSlots)];
  return unique.sort();
}

/**
 * openMinutes
 *
 * Total minutes a clinic is open on one day, given its availability rules and
 * any consultancy blocks.
 *
 * This is capacity. It is NOT the number of entries generateSlots() returns:
 * `slotDurationMinutes` is a STEP SIZE for candidate start times, so a rule from
 * 09:00-13:00 at 10-minute steps yields 24 candidates that overlap each other.
 * You cannot book 24 half-hour appointments in four hours. Counting candidates
 * as capacity inflates a clinic's apparent room by the ratio of appointment
 * length to step size, and the distortion changes whenever the step changes —
 * so the same clinic reads differently on different weekdays.
 *
 * Rules are UNIONED, not summed. Two rules covering 09:00-13:00 and 09:00-23:59
 * describe one open period, and adding their lengths would count the overlap
 * twice. Blocked ranges are subtracted from the union for the same reason.
 *
 * Pure: minutes-since-midnight arithmetic only, no Date, no timezone, no clock.
 */
export function openMinutes(
  rules: AvailabilityRule[],
  blockedRanges?: Array<{ start: string; end: string }>
): number {
  return openSpans(rules, blockedRanges).reduce((total, [start, end]) => total + (end - start), 0);
}

/**
 * openSpans
 *
 * The open periods themselves, as [start, end) minutes since midnight, sorted
 * and non-overlapping: the union of the rules less every blocked range.
 *
 * `openMinutes` is exactly the sum of these lengths, so anything reasoning about
 * WHERE the open time falls (a gap long enough for an appointment) agrees by
 * construction with the capacity figure every utilization metric divides by.
 *
 * Pure: minutes-since-midnight arithmetic only, no Date, no timezone, no clock.
 */
export function openSpans(
  rules: AvailabilityRule[],
  blockedRanges?: Array<{ start: string; end: string }>
): Array<[number, number]> {
  const merge = (spans: Array<[number, number]>): Array<[number, number]> => {
    const sorted = spans
      .filter(([s, e]) => e > s)
      .sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const [start, end] of sorted) {
      const last = merged[merged.length - 1];
      if (last && start <= last[1]) {
        last[1] = Math.max(last[1], end);
      } else {
        merged.push([start, end]);
      }
    }
    return merged;
  };

  const open = merge(rules.map((r) => [toMinutes(r.startTime), toMinutes(r.endTime)]));
  const blocked = merge(
    (blockedRanges ?? []).map((b) => [toMinutes(b.start), toMinutes(b.end)])
  );

  const result: Array<[number, number]> = [];
  for (const [start, end] of open) {
    let cursor = start;
    for (const [bStart, bEnd] of blocked) {
      if (bEnd <= cursor || bStart >= end) continue;
      if (bStart > cursor) result.push([cursor, bStart]);
      cursor = Math.max(cursor, bEnd);
      if (cursor >= end) break;
    }
    if (cursor < end) result.push([cursor, end]);
  }
  return result;
}

/**
 * Day-of-week for a "YYYY-MM-DD" date string, 0 (Sunday) – 6 (Saturday).
 *
 * Parsed at noon UTC rather than midnight so the result can never fall on the
 * adjacent calendar day due to a DST transition — the same defensive
 * convention `lib/business-brain/metrics-repository.ts` uses.
 */
function dayOfWeekFor(date: string): number {
  return new Date(`${date}T12:00:00.000Z`).getUTCDay();
}

/**
 * Every "YYYY-MM-DD" date from `from` to `to`, inclusive.
 */
function dateRangeInclusive(from: string, to: string): string[] {
  const dates: string[] = [];
  let cursor = new Date(`${from}T12:00:00.000Z`);
  const end = new Date(`${to}T12:00:00.000Z`);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return dates;
}

/**
 * Whether a clinic is OPEN AT ALL on one calendar date — has at least one
 * active availability rule for that weekday, and the date is not a whole-day
 * closure. A day with an active rule but a consultancy block covering its
 * entire window still counts as operating: the clinic intended to be open,
 * which is what "operating day" means for a revenue/appointments-per-day
 * average (audit B6) — it is not "did work actually happen".
 */
export function isOperatingDay(
  date: string,
  rulesByDayOfWeek: ReadonlyMap<number, AvailabilityRule[]>,
  closedDates: ReadonlySet<string>,
): boolean {
  if (closedDates.has(date)) return false;
  return (rulesByDayOfWeek.get(dayOfWeekFor(date)) ?? []).length > 0;
}

/**
 * Count of OPERATING days in an inclusive date range — the correct
 * denominator for a "per day" average (audit B6). A calendar-day count
 * overstates it by including days the clinic is closed; counting only days
 * that happened to have an appointment understates it by excluding open days
 * that were simply quiet.
 */
export function countOperatingDays(
  from: string,
  to: string,
  rulesByDayOfWeek: ReadonlyMap<number, AvailabilityRule[]>,
  closedDates: ReadonlySet<string>,
): number {
  return dateRangeInclusive(from, to).filter((d) =>
    isOperatingDay(d, rulesByDayOfWeek, closedDates),
  ).length;
}
