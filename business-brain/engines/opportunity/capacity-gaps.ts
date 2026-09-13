/**
 * Business Brain — Opportunity Engine: where the open time actually is
 *
 * The forward-schedule metric reports a SHARE of chair time booked. An
 * opportunity needs more than a share: 180 unbooked minutes scattered in
 * ten-minute slivers between appointments fit no appointment at all, and
 * reporting them as "room for six" would overstate the surplus — the one error
 * an opportunity must never make.
 *
 * So gaps are counted where they are. For each open span of a day, the engine
 * sweeps the live appointments to find how many chairs are free at every moment,
 * and counts how many appointments of the clinic's typical length fit in the
 * CONTIGUOUS runs of free chair time, chair-layer by chair-layer.
 *
 * ## Why layers
 *
 * With `c` chairs, the runs in which at least `k` chairs are free are nested
 * inside the runs in which at least `k − 1` are. Placing appointments greedily
 * into layer 1, then layer 2, … gives a count that is achievable (each layer is a
 * real chair's worth of uninterrupted time) and never double-counts a minute.
 *
 * Pure: ISO timestamps in, counts out. No clock, no timezone arithmetic — the
 * adapter already converted clinic-local hours into instants.
 */

import type { AppointmentFact, CapacityDayFact } from "../../ledger";

const MINUTE = 60_000;

/** Statuses that hold a chair, matching `occupiesSlot` in the metrics engine. */
export function occupiesChair(status: string): boolean {
  return status !== "cancelled" && status !== "no_show";
}

/** Booked length in minutes, with the metrics engine's guard for a missing duration. */
export function bookedLength(appointment: AppointmentFact): number {
  return appointment.durationMinutes > 0 ? appointment.durationMinutes : 30;
}

export interface Interval {
  readonly start: number;
  readonly end: number;
}

export function appointmentInterval(appointment: AppointmentFact): Interval {
  const start = Date.parse(appointment.scheduledAt);
  return { start, end: start + bookedLength(appointment) * MINUTE };
}

export interface DayGaps {
  readonly date: string;
  readonly openChairMinutes: number;
  /** Chair-minutes of live appointments scheduled on this date. */
  readonly bookedChairMinutes: number;
  /** Appointments of `appointmentMinutes` that fit into contiguous free chair time. */
  readonly fittableAppointments: number;
  /** ISO start of the first fittable gap, or null. */
  readonly firstGapAt: string | null;
  /** ISO end of the last fittable gap, or null. */
  readonly lastGapEndsAt: string | null;
}

/**
 * Count the appointments of `appointmentMinutes` that fit in a day's free time.
 *
 * `appointments` may include any appointment; only chair-holding ones whose
 * interval touches an open span count against it.
 */
export function gapsForDay(
  day: CapacityDayFact,
  chairCount: number,
  appointments: readonly AppointmentFact[],
  appointmentMinutes: number,
): DayGaps {
  const chairs = Math.max(1, chairCount);
  const dayStart = Date.parse(day.startsAt);
  const dayEnd = Date.parse(day.endsAt);
  const live = appointments.filter((a) => occupiesChair(a.status));

  const bookedChairMinutes = live
    .filter((a) => {
      const at = Date.parse(a.scheduledAt);
      return at >= dayStart && at <= dayEnd;
    })
    .reduce((sum, a) => sum + bookedLength(a), 0);

  let fittable = 0;
  let firstGap: number | null = null;
  let lastEnd: number | null = null;
  const length = appointmentMinutes * MINUTE;

  for (const span of day.openSpans) {
    const spanStart = Date.parse(span.start);
    const spanEnd = Date.parse(span.end);
    const clipped = live
      .map(appointmentInterval)
      .filter((i) => i.end > spanStart && i.start < spanEnd)
      .map((i) => ({ start: Math.max(i.start, spanStart), end: Math.min(i.end, spanEnd) }));

    // Breakpoints of the occupancy step function inside the span.
    const points = [...new Set([spanStart, spanEnd, ...clipped.flatMap((i) => [i.start, i.end])])].sort(
      (a, b) => a - b,
    );
    const segments = points.slice(0, -1).map((start, index) => {
      const end = points[index + 1];
      const occupied = clipped.filter((i) => i.start <= start && i.end >= end).length;
      return { start, end, free: Math.max(0, chairs - occupied) };
    });

    for (let layer = 1; layer <= chairs; layer += 1) {
      let runStart: number | null = null;
      const close = (runEnd: number) => {
        if (runStart === null) return;
        const count = Math.floor((runEnd - runStart) / length);
        if (count > 0) {
          fittable += count;
          if (firstGap === null || runStart < firstGap) firstGap = runStart;
          const end = runStart + count * length;
          if (lastEnd === null || end > lastEnd) lastEnd = end;
        }
        runStart = null;
      };
      for (const segment of segments) {
        if (segment.free >= layer) {
          if (runStart === null) runStart = segment.start;
        } else {
          close(segment.start);
        }
      }
      close(spanEnd);
    }
  }

  return {
    date: day.date,
    openChairMinutes: day.openMinutesPerChair * chairs,
    bookedChairMinutes,
    fittableAppointments: fittable,
    firstGapAt: firstGap === null ? null : new Date(firstGap).toISOString(),
    lastGapEndsAt: lastEnd === null ? null : new Date(lastEnd).toISOString(),
  };
}

/** Whether an interval lies wholly inside one of a day's open spans. */
export function withinOpenHours(interval: Interval, day: CapacityDayFact): boolean {
  return day.openSpans.some(
    (span) => interval.start >= Date.parse(span.start) && interval.end <= Date.parse(span.end),
  );
}

/** How many chair-holding appointments overlap an interval. */
export function overlapping(
  interval: Interval,
  appointments: readonly AppointmentFact[],
): readonly AppointmentFact[] {
  return appointments.filter((a) => {
    if (!occupiesChair(a.status)) return false;
    const other = appointmentInterval(a);
    return other.start < interval.end && other.end > interval.start;
  });
}
