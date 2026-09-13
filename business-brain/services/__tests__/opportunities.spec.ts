/**
 * The service and the Opportunity Engine.
 *
 * Opt-in, non-fatal, and never silent: a run that was not asked returns nothing,
 * a run that was asked and could not look says so for every type, and a run that
 * could look returns what the engine found from the three ledger reads.
 */

import { describe, expect, it } from "vitest";

import { OpportunityType } from "../../domain";
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
import { BusinessBrain } from "../business-brain-service";
import { capacity, CLINIC, DATE, followUp, NOW, patient, treatment } from "../../engines/opportunity/__tests__/opportunity-fixtures";

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function quietDay(clinicId: string, date: string): ClinicDataSnapshot {
  return {
    clinicId,
    date,
    asOf: NOW,
    appointmentsToday: [],
    patientsRegisteredToday: [],
    patientsSeenToday: [],
    treatments: [],
    payments: [],
    queueToday: [],
    followUps: [],
    capacity: { openMinutesToday: 240, chairCount: 1, typicalAppointmentMinutes: 30 },
  };
}

const repository: MetricsDataRepository = { getClinicSnapshot: async (c, d) => quietDay(c, d) };

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
    this.calls.push(`window:${scope.from}..${scope.to}`);
    return slice(scope);
  }
  async readCapacityWindow(scope: CapacityWindowScope) {
    this.calls.push(`capacity:${scope.from}..${scope.to}`);
    if (this.fail) throw new Error("connection reset");
    return capacity();
  }
  async readOpenWorkLedger(scope: OpenWorkScope) {
    this.calls.push("openWork");
    return slice(
      { kind: "patients", clinicId: scope.clinicId, patientIds: ["p_plan", "p_recall"], asOf: scope.asOf, limit: scope.limit },
      {
        patients: [patient("p_plan"), patient("p_recall")],
        treatments: [treatment({ id: "t1", patientId: "p_plan" })],
        followUps: [followUp({ id: "f1", patientId: "p_recall" })],
      },
    );
  }
}

describe("opportunities through the service", () => {
  it("are not measured unless asked for", async () => {
    const ledger = new FakeLedger();
    const result = await new BusinessBrain({ repository, logger: silent, ledgerPort: ledger }).runBusinessBrain(CLINIC, DATE, { startedAt: NOW });
    expect(result.opportunities).toEqual([]);
    expect(result.opportunityAssessments).toEqual([]);
    expect(ledger.calls).toEqual([]);
  });

  it("say they could not look, for every type, when no ledger is available", async () => {
    const result = await new BusinessBrain({ repository, logger: silent }).runBusinessBrain(CLINIC, DATE, {
      startedAt: NOW,
      opportunities: { now: NOW },
    });
    expect(result.opportunities).toEqual([]);
    expect(result.opportunityAssessments.map((a) => a.outcome)).toEqual(
      Object.values(OpportunityType).map(() => "insufficient_data"),
    );
  });

  it("read today through the next seven days, and pair them", async () => {
    const ledger = new FakeLedger();
    const result = await new BusinessBrain({ repository, logger: silent, ledgerPort: ledger }).runBusinessBrain(CLINIC, DATE, {
      startedAt: NOW,
      opportunities: { now: NOW },
    });
    expect(ledger.calls.sort()).toEqual(["capacity:2026-09-14..2026-09-21", "openWork", "window:2026-09-14..2026-09-21"]);
    expect(result.opportunities.map((o) => o.type)).toEqual([OpportunityType.FORWARD_CAPACITY_MATCH]);
    expect(result.ok).toBe(true);
  });

  it("cost the run nothing but themselves when the ledger fails", async () => {
    const result = await new BusinessBrain({ repository, logger: silent, ledgerPort: new FakeLedger(true) }).runBusinessBrain(CLINIC, DATE, {
      startedAt: NOW,
      opportunities: { now: NOW },
    });
    expect(result.ok).toBe(true);
    expect(result.metrics.length).toBeGreaterThan(0);
    expect(result.opportunities).toEqual([]);
    expect(result.opportunityAssessments.every((a) => a.outcome === "insufficient_data")).toBe(true);
  });
});
