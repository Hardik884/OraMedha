/**
 * The service and the Root-Cause Engine.
 *
 * Opt-in, reads only when a finding qualifies, and never silent: a run that
 * could not look still answers each qualifying finding with "insufficient
 * evidence to explain" and the reason.
 */

import { describe, expect, it } from "vitest";

import { ConstraintCategory } from "../../domain";
import type {
  AppointmentWindowScope,
  CapacityWindowScope,
  ClinicLedgerPort,
  ClinicLedgerSlice,
  OpenWorkScope,
  PatientLedgerScope,
} from "../../ledger";
import type { ClinicDataSnapshot, MetricsDataRepository } from "../../repositories";
import type { Logger } from "../../utils";
import { addDays } from "../../utils";
import { BusinessBrain } from "../business-brain-service";
import { appt, capacityWindow, weekdays } from "../../engines/root-cause/__tests__/root-cause-fixtures";

const CLINIC = "clinic_a";
const DATE = "2026-09-14";
const NOW = "2026-09-14T23:00:00.000Z";
const REQUEST = { now: NOW, timezone: "UTC" };
const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** Heavy attrition today: enough for a scheduling constraint. */
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
    asOf: NOW,
    appointmentsToday: appointments,
    patientsRegisteredToday: [],
    patientsSeenToday: [],
    treatments: [],
    payments: [],
    queueToday: [],
    followUps: [],
    capacity: { openMinutesToday: 480, chairCount: 1, typicalAppointmentMinutes: 30 },
    trailingWindow: { from: addDays(date, -29), to: date, appointments, openChairMinutes: 480 * 30 },
  };
}

function quietDay(clinicId: string, date: string): ClinicDataSnapshot {
  return {
    ...difficultDay(clinicId, date),
    appointmentsToday: [],
    capacity: { openMinutesToday: 0, chairCount: 1, typicalAppointmentMinutes: 30 },
    trailingWindow: undefined,
  };
}

const difficult: MetricsDataRepository = { getClinicSnapshot: async (c, d) => difficultDay(c, d) };
const quiet: MetricsDataRepository = { getClinicSnapshot: async (c, d) => quietDay(c, d) };

function slice(scope: ClinicLedgerSlice["scope"], over: Partial<ClinicLedgerSlice> = {}): ClinicLedgerSlice {
  return {
    clinicId: CLINIC,
    scope,
    patients: [],
    appointments: [],
    appointmentEvents: [],
    treatments: [],
    treatmentEvents: [],
    queueVisits: [],
    followUps: [],
    payments: [],
    reminderSends: [],
    actionCompletions: [],
    truncated: [],
    withheld: [],
    unresolvedPatientIds: [],
    ...over,
  };
}

class FakeLedger implements ClinicLedgerPort {
  readonly calls: string[] = [];
  constructor(private readonly fail = false) {}
  listCancellationEvents() { return Promise.resolve([]); }
  listNoShowHistory() { return Promise.resolve([]); }
  listPendingTreatments() { return Promise.resolve([]); }
  listOutstandingBalances() { return Promise.resolve([]); }
  listAppointmentArrivals() { return Promise.resolve([]); }
  listCompletedTreatments() { return Promise.resolve([]); }
  async readPatientLedger(scope: PatientLedgerScope) { return slice(scope); }
  async readAppointmentWindow(scope: AppointmentWindowScope) {
    this.calls.push(`window:${scope.from}..${scope.to}:${scope.limit}`);
    if (this.fail) throw new Error("connection reset");
    let evening = 0;
    return slice(scope, {
      appointments: weekdays().flatMap((d, i) => [
        ...["09:00", "09:30", "10:00"].map((t, j) => appt(`m${i}_${j}`, d, t, i === 3 && j === 0 ? "cancelled" : "completed")),
        appt(`e${i}`, d, "18:00", evening++ < 12 ? "cancelled" : "completed"),
      ]),
    });
  }
  async readCapacityWindow(scope: CapacityWindowScope) {
    this.calls.push(`capacity:${scope.from}..${scope.to}`);
    return capacityWindow();
  }
  async readOpenWorkLedger(scope: OpenWorkScope) {
    this.calls.push("openWork");
    return slice({ kind: "patients", clinicId: scope.clinicId, patientIds: [], asOf: scope.asOf, limit: scope.limit });
  }
}

const brain = (repository: MetricsDataRepository, ledgerPort?: ClinicLedgerPort) =>
  new BusinessBrain({ repository, logger: silent, ledgerPort, clock: () => 0 });

describe("root causes through the service", () => {
  it("are not investigated unless asked, and read nothing", async () => {
    const ledger = new FakeLedger();
    const result = await brain(difficult, ledger).runBusinessBrain(CLINIC, DATE, { startedAt: NOW });
    expect(result.rootCauses).toEqual([]);
    expect(ledger.calls.filter((c) => c.startsWith("window"))).toEqual([]);
  });

  it("read nothing when no finding qualifies", async () => {
    const ledger = new FakeLedger();
    const result = await brain(quiet, ledger).runBusinessBrain(CLINIC, DATE, { startedAt: NOW, rootCauses: REQUEST });
    expect(result.constraints.some((c) => c.category === ConstraintCategory.SCHEDULING)).toBe(false);
    expect(result.rootCauses).toEqual([]);
    expect(ledger.calls).toEqual([]);
  });

  it("read one bounded trailing window and attach each analysis to its finding", async () => {
    const ledger = new FakeLedger();
    const result = await brain(difficult, ledger).runBusinessBrain(CLINIC, DATE, { startedAt: NOW, rootCauses: REQUEST });
    const scheduling = result.rootCauses.find((r) => r.question === "attrition");
    expect(scheduling?.outcome).toBe("explained");
    expect(scheduling?.statement).toMatch(/^Lost appointments are concentrated in evening appointments/);

    const window = ledger.calls.filter((c) => c.startsWith("window"));
    expect(window).toEqual(["window:2026-08-16..2026-09-14:5000"]);
    const wantsCapacity = result.rootCauses.some((r) => r.question === "idle_capacity");
    expect(ledger.calls.some((c) => c.startsWith("capacity"))).toBe(wantsCapacity);

    const all = [
      ...(result.findings.top ? [result.findings.top] : []),
      ...result.findings.next,
      ...result.findings.supporting,
      ...result.findings.noActionRequired,
      ...result.findings.wins,
    ];
    for (const analysis of result.rootCauses) {
      const parents = all.filter((r) => r.finding.id === analysis.parentFindingId);
      expect(parents).toHaveLength(1);
      expect(parents[0].finding.evidence.rootCauses).toEqual([analysis]);
    }
  });

  it("answer insufficient evidence, with the reason, when there is no ledger", async () => {
    const result = await brain(difficult).runBusinessBrain(CLINIC, DATE, { startedAt: NOW, rootCauses: REQUEST });
    expect(result.rootCauses.length).toBeGreaterThan(0);
    for (const analysis of result.rootCauses) {
      expect(analysis.outcome).toBe("insufficient_evidence");
      expect(analysis.statement).toBe("Insufficient evidence to explain where this is concentrated: no clinic ledger is available to this run.");
    }
  });

  it("cost the run nothing but themselves when the ledger fails", async () => {
    const result = await brain(difficult, new FakeLedger(true)).runBusinessBrain(CLINIC, DATE, { startedAt: NOW, rootCauses: REQUEST });
    expect(result.ok).toBe(true);
    expect(result.constraints.length).toBeGreaterThan(0);
    expect(result.rootCauses.every((r) => r.outcome === "insufficient_evidence" && /could not be read/.test(r.statement))).toBe(true);
  });

  it("give the same analyses on every run", async () => {
    const [a, b] = await Promise.all([
      brain(difficult, new FakeLedger()).runBusinessBrain(CLINIC, DATE, { startedAt: NOW, rootCauses: REQUEST }),
      brain(difficult, new FakeLedger()).runBusinessBrain(CLINIC, DATE, { startedAt: NOW, rootCauses: REQUEST }),
    ]);
    expect(a.rootCauses).toEqual(b.rootCauses);
    expect(a.findings).toEqual(b.findings);
  });
});
