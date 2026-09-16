/**
 * Business Brain — calendar arithmetic
 *
 * Shared by the Diagnosis Engine (which must know whether two fired days are
 * adjacent, and which dates in a window were never supplied) and the Metrics
 * Engine (which needs trailing-window boundaries). Every engine is forbidden
 * from touching `Date`.
 *
 * So dates are handled as "YYYY-MM-DD" strings converted to a day number via a
 * pure proleptic-Gregorian formula. No `Date`, no timezone, no locale, no clock:
 * the same string always produces the same number on every machine.
 */

/** Whether a string is a well-formed "YYYY-MM-DD" calendar date. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Days since 1970-01-01 for a "YYYY-MM-DD" date.
 * Howard Hinnant's civil-from-days algorithm, inverted; integer maths only.
 */
export function toDayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const shiftedYear = m <= 2 ? y - 1 : y;
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const dayOfYear = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** The "YYYY-MM-DD" date that many days after 1970-01-01. */
export function fromDayNumber(days: number): string {
  const shifted = days + 719468;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const mp = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return toDayNumber(to) - toDayNumber(from);
}

/** Shift a date by a whole number of days. */
export function addDays(date: string, days: number): string {
  return fromDayNumber(toDayNumber(date) + days);
}

/**
 * Every calendar date from `from` to `to` inclusive, ascending.
 * Returns an empty array when `to` precedes `from`.
 */
export function dateRange(from: string, to: string): string[] {
  const span = daysBetween(from, to);
  if (span < 0) return [];
  const dates: string[] = [];
  for (let offset = 0; offset <= span; offset++) dates.push(addDays(from, offset));
  return dates;
}

const LOCAL_DATE_FORMATS = new Map<string, Intl.DateTimeFormat>();

/**
 * The clinic-local "YYYY-MM-DD" of an ISO instant.
 *
 * An instant's own first ten characters are its UTC date, which is the clinic's
 * date only when the clinic is in UTC: a treatment performed at 00:30 in
 * Asia/Kolkata is the previous day in UTC, and one performed at 18:00 in
 * America/Los_Angeles is the next. Pure — the timezone is an input, and `Intl`
 * only expresses the instant in it. Without a timezone the UTC date is returned,
 * which is exactly the previous behaviour.
 */
export function localDatePart(iso: string, timezone: string | undefined): string {
  if (timezone === undefined || timezone === "UTC") return iso.slice(0, 10);
  let format = LOCAL_DATE_FORMATS.get(timezone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    LOCAL_DATE_FORMATS.set(timezone, format);
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso.slice(0, 10) : format.format(new Date(ms));
}

const OFFSET_FORMATS = new Map<string, Intl.DateTimeFormat>();

/** Minutes the timezone is ahead of UTC at an instant. */
function offsetMinutesAt(ms: number, timezone: string): number {
  let format = OFFSET_FORMATS.get(timezone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    OFFSET_FORMATS.set(timezone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/**
 * The instant a clinic-local business date begins, as ISO-8601 UTC.
 *
 * The day ENDS where the next one begins, so "known by the end of 3 September"
 * is `startOfLocalDay("2026-09-04", tz)`. Resolved twice so a date whose
 * midnight falls just after a DST change still lands on the right side of it.
 */
export function startOfLocalDay(date: string, timezone: string): string {
  const naive = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  let ms = naive - offsetMinutesAt(naive, timezone) * 60_000;
  ms = naive - offsetMinutesAt(ms, timezone) * 60_000;
  return new Date(ms).toISOString();
}

/** The exclusive end of a clinic-local business date: the start of the next one. */
export function endOfLocalDay(date: string, timezone: string): string {
  return startOfLocalDay(addDays(date, 1), timezone);
}
