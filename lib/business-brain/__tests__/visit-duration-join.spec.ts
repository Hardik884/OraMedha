/**
 * The one place two ledgers are joined.
 *
 * `joinVisitDurations` pairs what the appointment book PLANNED with what the
 * queue RECORDED. Everything downstream — the overrun metric, the signal, the
 * schedule-accuracy card — is only as honest as this join, and the ways it can
 * quietly lie are all the same shape: treating a missing measurement as a
 * measurement of zero.
 *
 * That failure mode has a particular sting here. A clinic that forgets to close
 * its queue entries would read as a clinic that books perfectly, and nothing on
 * the screen would distinguish the two. So most of what follows asserts an
 * absence rather than a value.
 */

import { describe, expect, it } from "vitest";

import type { AppointmentSnapshot } from "@/business-brain";
import { joinVisitDurations } from "../metrics-repository";

const DATE = "2026-08-12";

function appointment(over: Partial<AppointmentSnapshot> = {}): AppointmentSnapshot {
  return {
    id: "a1",
    patientId: "p1",
    status: "completed",
    scheduledAt: `${DATE}T04:00:00.000Z`,
    createdAt: `${DATE}T00:00:00.000Z`,
    durationMinutes: 30,
    source: "walk_in",
    ...over,
  };
}

function queueRow(over: Partial<{ appointment_id: string; called_at: string | null; completed_at: string | null }> = {}) {
  return {
    appointment_id: "a1",
    called_at: `${DATE}T04:00:00.000Z`,
    completed_at: `${DATE}T04:45:00.000Z`,
    ...over,
  };
}

describe("joinVisitDurations", () => {
  it("pairs the booked length with the delivered one", () => {
    const [visit] = joinVisitDurations([appointment()], [queueRow()]);
    expect(visit).toMatchObject({
      appointmentId: "a1",
      scheduledMinutes: 30,
      actualMinutes: 45,
    });
  });

  it("excludes appointments the patient never attended", () => {
    // A cancelled appointment has a booked length and no delivered one. Included,
    // it would read as an appointment that took zero minutes and drag the clinic's
    // overrun figure toward the floor using visits that never happened.
    const visits = joinVisitDurations(
      [
        appointment({ id: "kept", status: "completed" }),
        appointment({ id: "cancelled", status: "cancelled" }),
        appointment({ id: "missed", status: "no_show" }),
      ],
      [queueRow({ appointment_id: "kept" })],
    );
    expect(visits.map((v) => v.appointmentId)).toEqual(["kept"]);
  });

  it("includes a visit still in progress, with its length unmeasured", () => {
    // `checked_in` and `in_progress` are attendance, so the visit belongs in the
    // set. Its length is simply not known yet, which is a null and not a zero.
    const [visit] = joinVisitDurations(
      [appointment({ status: "in_progress" })],
      [queueRow({ completed_at: null })],
    );
    expect(visit.actualMinutes).toBeNull();
  });

  it("yields null, never zero, for an appointment with no queue entry at all", () => {
    // The commonest real-world gap: the visit happened, nobody worked the queue
    // board. A zero here is the difference between "we do not know" and "it took
    // no time", and only one of those is true.
    const [visit] = joinVisitDurations([appointment()], []);
    expect(visit.actualMinutes).toBeNull();
    expect(visit.scheduledMinutes).toBe(30);
  });

  it("yields null when either end of the interval is missing", () => {
    const noStart = joinVisitDurations([appointment()], [queueRow({ called_at: null })]);
    const noEnd = joinVisitDurations([appointment()], [queueRow({ completed_at: null })]);
    expect(noStart[0]?.actualMinutes).toBeNull();
    expect(noEnd[0]?.actualMinutes).toBeNull();
  });

  it("discards a negative interval rather than clamping it to zero", () => {
    // Only bad data produces a completion before its call-in. Clamped to zero it
    // would silently pull the clinic's average down using a row that means
    // nothing; discarded, it simply does not vote.
    const [visit] = joinVisitDurations(
      [appointment()],
      [queueRow({ called_at: `${DATE}T05:00:00.000Z`, completed_at: `${DATE}T04:00:00.000Z` })],
    );
    expect(visit.actualMinutes).toBeNull();
  });

  it("yields null for an unparseable timestamp instead of NaN", () => {
    // NaN would propagate silently through the sum and make the whole window's
    // overrun figure NaN — a metric that renders as nothing, from one bad row.
    const [visit] = joinVisitDurations([appointment()], [queueRow({ completed_at: "not a date" })]);
    expect(visit.actualMinutes).toBeNull();
  });

  it("takes the first queue entry when an appointment has more than one", () => {
    // A patient re-queued against one appointment is a rare correction. Taking
    // the first keeps the join deterministic, which matters more here than which
    // entry wins — the pipeline's whole guarantee is byte-identical output.
    const [visit] = joinVisitDurations(
      [appointment()],
      [
        queueRow({ completed_at: `${DATE}T04:20:00.000Z` }),
        queueRow({ completed_at: `${DATE}T06:00:00.000Z` }),
      ],
    );
    expect(visit.actualMinutes).toBe(20);
  });

  it("ignores queue rows for appointments outside the window", () => {
    // The queue read is scoped by queue_date and the appointment read by
    // scheduled_at; a row can appear in one and not the other. An orphan queue
    // row must not invent a visit.
    const visits = joinVisitDurations([], [queueRow({ appointment_id: "elsewhere" })]);
    expect(visits).toEqual([]);
  });

  it("is a pure function of its inputs", () => {
    // No clock, no I/O — the same guarantee every engine in the module makes, and
    // the reason a snapshot can be reproduced after the fact.
    const appointments = [appointment()];
    const rows = [queueRow()];
    expect(joinVisitDurations(appointments, rows)).toEqual(
      joinVisitDurations(appointments, rows),
    );
  });
});
