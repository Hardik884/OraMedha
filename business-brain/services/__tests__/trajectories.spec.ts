/**
 * Trajectories on the run result — from the history the run already loads.
 *
 * The one read added by this layer is none: with a fully stored history the run
 * reads the store once and snapshots only today, with or without trajectories.
 */

import { describe, expect, it } from "vitest";

import type { ClinicDataSnapshot, MetricHistoryStore, MetricsDataRepository, StoredMetricDay } from "../../repositories";
import type { Logger } from "../../utils";
import { addDays } from "../../utils";
import { BusinessBrain } from "../business-brain-service";

const CLINIC = "clinic_a";
const DATE = "2026-10-05";
const STARTED_AT = "2026-10-05T06:30:00.000Z";
const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** Today: ten pending follow-ups past due. */
function today(clinicId: string, date: string): ClinicDataSnapshot {
  return {
    clinicId,
    date,
    asOf: STARTED_AT,
    appointmentsToday: [],
    patientsRegisteredToday: [],
    patientsSeenToday: [],
    treatments: [],
    payments: [],
    queueToday: [],
    followUps: Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, dueDate: "2026-09-20", status: "pending" })),
    capacity: { openMinutesToday: 480, chairCount: 1, typicalAppointmentMinutes: 30 },
  };
}

class CountingRepository implements MetricsDataRepository {
  readonly dates: string[] = [];
  async getClinicSnapshot(clinicId: string, date: string): Promise<ClinicDataSnapshot> {
    this.dates.push(date);
    return today(clinicId, date);
  }
}

/** 35 stored days of overdue follow-ups climbing week by week: 2, 3, 4, 7, 9. */
class ClimbingStore implements MetricHistoryStore {
  reads = 0;
  async readMetricDays(_clinicId: string, from: string, to: string): Promise<readonly StoredMetricDay[]> {
    this.reads += 1;
    const days: StoredMetricDay[] = [];
    for (let back = 35; back >= 1; back -= 1) {
      const date = addDays(DATE, -back);
      if (date < from || date > to) continue;
      const week = Math.min(4, Math.floor((35 - back) / 7));
      days.push({ date, metrics: [{ key: "followups.overdue", value: [2, 3, 4, 7, 9][week], measuredAt: `${date}T18:00:00.000Z` }] });
    }
    return days;
  }
  async writeMetricDay(): Promise<void> {}
}

function run(historyDays: number) {
  const repository = new CountingRepository();
  const store = new ClimbingStore();
  let tick = 0;
  const brain = new BusinessBrain({ repository, historyStore: store, logger: silent, clock: () => (tick += 5) });
  return { repository, store, result: brain.runBusinessBrain(CLINIC, DATE, { startedAt: STARTED_AT, historyDays }) };
}

describe("trajectories on the run result", () => {
  it("are measured from the stored history with no additional read", async () => {
    const { repository, store, result } = run(35);
    const r = await result;
    expect(store.reads).toBe(1);
    expect(repository.dates).toEqual([DATE]);
    const overdue = r.trajectories.find((t) => t.metricKey === "followups.overdue");
    expect(overdue?.state).toBe("worsening");
    expect(overdue?.statement).toContain("The number of overdue follow-ups is above your normal range");
  });

  it("report every other catalogued metric as insufficient rather than omitting it", async () => {
    const r = await run(35).result;
    const others = r.trajectories.filter((t) => t.metricKey !== "followups.overdue");
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((t) => t.state === "insufficient_data")).toBe(true);
  });

  it("reach the findings: exactly one finding carries the overdue follow-up trajectory", async () => {
    const r = await run(35).result;
    const all = [
      ...(r.findings.top ? [r.findings.top] : []),
      ...r.findings.next,
      ...r.findings.supporting,
      ...r.findings.noActionRequired,
    ];
    const carrying = all.filter((x) => x.finding.evidence.trajectories.some((t) => t.metricKey === "followups.overdue"));
    expect(carrying).toHaveLength(1);
  });

  it("are absent when the run was given no history to have a trajectory of", async () => {
    const r = await run(0).result;
    expect(r.trajectories).toEqual([]);
  });

  it("are identical on a rerun", async () => {
    const [a, b] = await Promise.all([run(35).result, run(35).result]);
    expect(a.trajectories).toEqual(b.trajectories);
    expect(a.findings).toEqual(b.findings);
  });
});
