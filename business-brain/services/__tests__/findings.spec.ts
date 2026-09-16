/**
 * Findings on every run result: computed from the result itself, so every
 * constraint, opportunity and achievement the run produced is accounted for
 * exactly once, and the same run always ranks the same way.
 */

import { describe, expect, it } from "vitest";

import type { ClinicDataSnapshot, MetricsDataRepository } from "../../repositories";
import type { Logger } from "../../utils";
import { addDays } from "../../utils";
import { BusinessBrain } from "../business-brain-service";

const CLINIC = "clinic_a";
const DATE = "2026-09-12";
const STARTED_AT = "2026-09-12T06:30:00.000Z";
const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** Heavy attrition, an unpaid balance and planned work nobody has booked. */
function difficultDay(clinicId: string, date: string): ClinicDataSnapshot {
  const appointments = Array.from({ length: 20 }, (_, i) => ({
    id: `${date}-a${i}`,
    patientId: `p${i}`,
    status: i < 6 ? "cancelled" : i < 12 ? "no_show" : "completed",
    scheduledAt: `${date}T04:00:00.000Z`,
    createdAt: `${addDays(date, -3)}T00:00:00.000Z`,
    durationMinutes: 30,
    source: "phone_call",
  }));
  return {
    clinicId,
    date,
    asOf: STARTED_AT,
    appointmentsToday: appointments,
    patientsRegisteredToday: [],
    patientsSeenToday: [{ id: "p1", createdAt: "2026-01-01T00:00:00.000Z" }],
    treatments: [
      { id: "t1", patientId: "p1", cost: 80_000, status: "completed", performedAt: `${date}T04:00:00.000Z`, isScheduled: true },
      ...Array.from({ length: 12 }, (_, i) => ({ id: `tp${i}`, patientId: `pp${i}`, cost: 15_000, status: "planned", performedAt: null, isScheduled: false })),
    ],
    payments: [],
    queueToday: [],
    followUps: [],
    capacity: { openMinutesToday: 480, chairCount: 1, typicalAppointmentMinutes: 30 },
    trailingWindow: { from: addDays(date, -29), to: date, appointments, openChairMinutes: 480 * 30 },
  };
}

const repository: MetricsDataRepository = { getClinicSnapshot: async (c, d) => difficultDay(c, d) };

function run() {
  let tick = 0;
  return new BusinessBrain({ repository, logger: silent, clock: () => (tick += 5) }).runBusinessBrain(CLINIC, DATE, {
    startedAt: STARTED_AT,
    opportunities: { now: STARTED_AT },
  });
}

describe("findings on the run result", () => {
  it("account for every constraint exactly once, with a top finding and a reason", async () => {
    const result = await run();
    expect(result.constraints.length).toBeGreaterThan(1);
    const all = [
      ...(result.findings.top ? [result.findings.top] : []),
      ...result.findings.next,
      ...result.findings.supporting,
      ...result.findings.wins,
      ...result.findings.noActionRequired,
    ];
    const constraintIds = all.filter((x) => x.finding.source.producer === "constraint").map((x) => x.finding.source.id).sort();
    expect(constraintIds).toEqual(result.constraints.map((c) => c.id).sort());
    expect(result.findings.top?.explanation).toMatch(/^Ranked 1st: /);
    expect(result.findings.clinicId).toBe(CLINIC);
  });

  it("report opportunities that could not be measured, rather than leaving a silent gap", async () => {
    const result = await run();
    expect(result.findings.unmeasured.map((u) => u.source).sort()).toEqual([
      "opportunity.forward_capacity_match",
      "opportunity.freed_slot_refill",
      "opportunity.unpaid_delivered_work",
    ]);
  });

  it("rank the same run the same way every time", async () => {
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.findings).toEqual(b.findings);
  });
});
