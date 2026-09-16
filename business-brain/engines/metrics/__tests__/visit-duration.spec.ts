/**
 * Metrics Engine — booked length against delivered length.
 *
 * The two metrics added for the schedule-accuracy outcome, and the only pair in
 * the engine built from two ledgers at once. Most of what is asserted here is
 * about what they REFUSE to measure: an unrecorded visit length is the failure
 * mode that would quietly turn "we do not know" into "this clinic books
 * perfectly", and it is the only reading a dentist could not tell was wrong.
 */

import { describe, expect, it } from "vitest";

import { appointmentOverrun30d, measuredVisits30d } from "../calculators/scheduling-metrics";
import { MetricKey } from "../metric-ids";
import {
  isWithheld,
  snapshot,
  valueOf,
  visitDuration,
} from "./fixtures/snapshot-fixtures";

describe("scheduling.measured_visits_30d", () => {
  it("counts only visits with both ends of the interval recorded", () => {
    const s = snapshot({
      trailingVisitDurations: [
        visitDuration({ actualMinutes: 35 }),
        visitDuration({ actualMinutes: 28 }),
        // Never called in, or never marked finished. Not a zero-minute visit.
        visitDuration({ actualMinutes: null }),
      ],
    });
    expect(valueOf(measuredVisits30d, s)).toBe(2);
  });

  it("reports a real zero when the repository looked and nothing was measurable", () => {
    // Distinct from withholding: the read happened, and every visit turned out
    // to be missing a timestamp. That is a fact about the clinic's queue
    // discipline, and it is worth reporting as such.
    const s = snapshot({
      trailingVisitDurations: [
        visitDuration({ actualMinutes: null }),
        visitDuration({ actualMinutes: null }),
      ],
    });
    expect(valueOf(measuredVisits30d, s)).toBe(0);
  });

  it("is withheld when the repository supplied no durations at all", () => {
    expect(isWithheld(measuredVisits30d, snapshot())).toBe(true);
  });
});

describe("scheduling.appointment_overrun_30d", () => {
  it("measures the overrun from the totals, not from a mean of per-visit ratios", () => {
    // 10 booked -> 15 actual is +50%; 60 booked -> 65 actual is +8.3%. Both cost
    // the day exactly 5 minutes. Averaging the RATIOS gives 29.2%, which lets the
    // short appointment dominate a figure about minutes. From the totals:
    // (80 - 70) / 70 = 14.3%.
    const s = snapshot({
      trailingVisitDurations: [
        visitDuration({ scheduledMinutes: 10, actualMinutes: 15 }),
        visitDuration({ scheduledMinutes: 60, actualMinutes: 65 }),
      ],
    });
    expect(valueOf(appointmentOverrun30d, s)).toBe(14.3);
  });

  it("reads zero for a clinic that books exactly the time it delivers", () => {
    const s = snapshot({
      trailingVisitDurations: [
        visitDuration({ scheduledMinutes: 30, actualMinutes: 30 }),
        visitDuration({ scheduledMinutes: 45, actualMinutes: 45 }),
      ],
    });
    expect(valueOf(appointmentOverrun30d, s)).toBe(0);
  });

  it("goes negative for a clinic that books more time than it uses", () => {
    // Reported honestly rather than clamped. The SIGNAL is one-sided — finishing
    // early is a different finding with a different action — but the metric's job
    // is to measure, and a clamp here would hide generous booking entirely.
    const s = snapshot({
      trailingVisitDurations: [visitDuration({ scheduledMinutes: 60, actualMinutes: 45 })],
    });
    expect(valueOf(appointmentOverrun30d, s)).toBe(-25);
  });

  it("ignores visits whose length was never recorded rather than counting them as punctual", () => {
    // The regression this exists to catch. Treating the unrecorded visit as
    // on-time would pull a genuine 50% overrun down to 25% — a clinic with a real
    // problem reading as a clinic with half a problem, because of a missing
    // timestamp rather than because of anything it did.
    const s = snapshot({
      trailingVisitDurations: [
        visitDuration({ scheduledMinutes: 30, actualMinutes: 45 }),
        visitDuration({ scheduledMinutes: 30, actualMinutes: null }),
      ],
    });
    expect(valueOf(appointmentOverrun30d, s)).toBe(50);
  });

  it("discards a visit booked for zero minutes rather than dividing by it", () => {
    // One bad row would otherwise contribute an unbounded overrun and swamp the
    // window. Discarded, so the remaining visit alone decides the figure.
    const s = snapshot({
      trailingVisitDurations: [
        visitDuration({ scheduledMinutes: 0, actualMinutes: 40 }),
        visitDuration({ scheduledMinutes: 30, actualMinutes: 33 }),
      ],
    });
    expect(valueOf(appointmentOverrun30d, s)).toBe(10);
    expect(valueOf(measuredVisits30d, s)).toBe(1);
  });

  it("is withheld when no visit has a usable length", () => {
    // Not zero. A reported 0% is the claim "this clinic books accurately", which
    // is precisely what an absent measurement cannot support.
    const s = snapshot({
      trailingVisitDurations: [visitDuration({ actualMinutes: null })],
    });
    expect(isWithheld(appointmentOverrun30d, s)).toBe(true);
  });

  it("is withheld when the repository supplied no durations at all", () => {
    expect(isWithheld(appointmentOverrun30d, snapshot())).toBe(true);
  });

  it("stamps both metrics with the snapshot's clinic and date, never the clock", () => {
    const s = snapshot({ trailingVisitDurations: [visitDuration()] });
    const overrun = appointmentOverrun30d(s);
    const sample = measuredVisits30d(s);
    expect(overrun?.id).toBe(
      `${MetricKey.SCHEDULING_APPOINTMENT_OVERRUN_30D}:${s.clinicId}:${s.date}`,
    );
    expect(sample?.id).toBe(
      `${MetricKey.SCHEDULING_MEASURED_VISITS_30D}:${s.clinicId}:${s.date}`,
    );
    expect(overrun?.timestamp).toBe(s.asOf);
  });
});
