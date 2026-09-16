/**
 * Metrics on clinic-local business dates, around midnight.
 *
 * Every timestamp the repository hands over is a UTC instant. Its first ten
 * characters are the clinic's date only in UTC, so each case sits a treatment,
 * a registration or a visit either side of LOCAL midnight in a clinic east of
 * UTC and one west of it.
 */

import { describe, expect, it } from "vitest";

import { localDatePart } from "../../../utils";
import { returningPatientsToday, reactivationCandidates } from "../calculators/patient-metrics";
import { production30d } from "../calculators/revenue-metrics";
import { treatmentsCompletedToday } from "../calculators/treatment-metrics";
import { patient, rosterEntry, snapshot, treatment, valueOf } from "./fixtures/snapshot-fixtures";

const DATE = "2026-07-28";

describe("clinic-local dates", () => {
  it("expresses an instant on the clinic's own calendar, across month and year ends", () => {
    expect(localDatePart("2026-07-27T19:00:00.000Z", "Asia/Kolkata")).toBe("2026-07-28");
    expect(localDatePart("2026-07-29T01:00:00.000Z", "America/Los_Angeles")).toBe("2026-07-28");
    expect(localDatePart("2026-12-31T20:00:00.000Z", "Asia/Kolkata")).toBe("2027-01-01");
    expect(localDatePart("2027-01-01T05:00:00.000Z", "America/New_York")).toBe("2027-01-01");
    expect(localDatePart("2027-01-01T04:00:00.000Z", "America/New_York")).toBe("2026-12-31");
    expect(localDatePart("2026-07-28T23:59:59.999Z", undefined)).toBe("2026-07-28");
  });

  it("stays correct across a daylight-saving change", () => {
    // New York leaves DST on 1 Nov 2026 at 02:00 local: 05:30 UTC is 00:30 or 01:30 local.
    expect(localDatePart("2026-11-01T03:30:00.000Z", "America/New_York")).toBe("2026-10-31");
    expect(localDatePart("2026-11-01T05:30:00.000Z", "America/New_York")).toBe("2026-11-01");
  });

  it("counts a treatment performed at 00:30 in Kolkata as today, not yesterday", () => {
    const s = snapshot({
      date: DATE,
      timezone: "Asia/Kolkata",
      treatments: [treatment({ status: "completed", performedAt: "2026-07-27T19:00:00.000Z" })],
    });
    expect(valueOf(treatmentsCompletedToday, s)).toBe(1);
    expect(valueOf(treatmentsCompletedToday, { ...s, timezone: undefined })).toBe(0);
  });

  it("counts an evening treatment in Los Angeles on its own day, not tomorrow's", () => {
    const s = snapshot({
      date: DATE,
      timezone: "America/Los_Angeles",
      treatments: [treatment({ status: "completed", performedAt: "2026-07-29T01:00:00.000Z", cost: 500 })],
    });
    expect(valueOf(treatmentsCompletedToday, s)).toBe(1);
    expect(valueOf(production30d, s)).toBe(500);
  });

  it("keeps the trailing window's first local day in, and the day before it out", () => {
    // The 30-day window ending 28 July starts 29 June, local.
    const s = snapshot({
      date: DATE,
      timezone: "Asia/Kolkata",
      treatments: [
        treatment({ id: "in", status: "completed", performedAt: "2026-06-28T19:00:00.000Z", cost: 100 }), // 29 Jun 00:30 IST
        treatment({ id: "out", status: "completed", performedAt: "2026-06-28T18:00:00.000Z", cost: 1000 }), // 28 Jun 23:30 IST
      ],
    });
    expect(valueOf(production30d, s)).toBe(100);
  });

  it("treats a patient registered at 00:30 local today as new, not returning", () => {
    const s = snapshot({
      date: DATE,
      timezone: "Asia/Kolkata",
      patientsSeenToday: [patient({ id: "p1", createdAt: "2026-07-27T19:00:00.000Z" })],
    });
    expect(valueOf(returningPatientsToday, s)).toBe(0);
  });

  it("measures a lapsed patient's last visit on the clinic's calendar", () => {
    // Interval 30 days: cutoff 28 June. A visit at 00:30 on 28 June local is ON the cutoff, not before it.
    const base = { date: DATE, timezone: "Asia/Kolkata", recallIntervalDays: 30 };
    const onCutoff = snapshot({ ...base, patientRoster: [rosterEntry({ lastVisit: "2026-06-27T19:00:00.000Z", hasUpcomingAppointment: false })] });
    expect(valueOf(reactivationCandidates, onCutoff)).toBe(0);
    const before = snapshot({ ...base, patientRoster: [rosterEntry({ lastVisit: "2026-06-27T18:00:00.000Z", hasUpcomingAppointment: false })] });
    expect(valueOf(reactivationCandidates, before)).toBe(1);
  });
});
