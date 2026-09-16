/**
 * The service and the clinic ledger port.
 *
 * Two claims: a ledger port is a drop-in superset of the diagnosis context — the
 * run behaves identically whichever is supplied — and without a ledger port the
 * service says it cannot answer (`null`) rather than handing back an empty graph
 * that reads as "these patients have no history".
 */

import { describe, expect, it } from "vitest";

import type {
  AppointmentWindowScope,
  CapacityWindowFact,
  CapacityWindowScope,
  OpenWorkScope,
  ClinicLedgerPort,
  ClinicLedgerSlice,
  PatientLedgerScope,
} from "../../ledger";
import { LedgerIntegrityError } from "../../ledger";
import type { ClinicDataSnapshot, MetricsDataRepository } from "../../repositories";
import type { Logger } from "../../utils";
import { addDays } from "../../utils";
import { BusinessBrain } from "../business-brain-service";
import { CLINIC, OTHER_CLINIC, slice as fixtureSlice } from "../../ledger/__tests__/ledger-fixtures";

const DATE = "2026-09-12";
const STARTED_AT = "2026-09-12T06:30:00.000Z";

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * A day that breaches attrition: many cancellations and no-shows, so the
 * Diagnosis Engine attaches entity-level discriminators and the run has a reason
 * to call the port.
 */
function attritionDay(clinicId: string, date: string): ClinicDataSnapshot {
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
    asOf: `${date}T06:30:00.000Z`,
    appointmentsToday: appointments,
    patientsRegisteredToday: [],
    patientsSeenToday: [{ id: "p1", createdAt: "2026-01-01T00:00:00.000Z" }],
    treatments: [],
    payments: [],
    queueToday: [],
    followUps: [],
    capacity: { openMinutesToday: 480, chairCount: 1, typicalAppointmentMinutes: 30 },
    trailingWindow: { from: addDays(date, -29), to: date, appointments, openChairMinutes: 480 * 30 },
  };
}

const repository: MetricsDataRepository = {
  getClinicSnapshot: async (clinicId, date) => attritionDay(clinicId, date),
};

/** A ledger port that records what the service asked it. */
class RecordingLedger implements ClinicLedgerPort {
  readonly calls: string[] = [];
  constructor(private readonly sliceFor: (scope: PatientLedgerScope | AppointmentWindowScope) => ClinicLedgerSlice = (s) => fixtureSlice({ scope: s })) {}

  private note<T>(name: string, value: T): Promise<T> {
    this.calls.push(name);
    return Promise.resolve(value);
  }
  listCancellationEvents() { return this.note("listCancellationEvents", []); }
  listNoShowHistory() { return this.note("listNoShowHistory", []); }
  listPendingTreatments() { return this.note("listPendingTreatments", []); }
  listOutstandingBalances() { return this.note("listOutstandingBalances", []); }
  listAppointmentArrivals() { return this.note("listAppointmentArrivals", []); }
  listCompletedTreatments() { return this.note("listCompletedTreatments", []); }
  readPatientLedger(scope: PatientLedgerScope) { return this.note("readPatientLedger", this.sliceFor(scope)); }
  readAppointmentWindow(scope: AppointmentWindowScope) { return this.note("readAppointmentWindow", this.sliceFor(scope)); }
  readCapacityWindow(scope: CapacityWindowScope): Promise<CapacityWindowFact> {
    return this.note("readCapacityWindow", {
      clinicId: scope.clinicId,
      from: scope.from,
      to: scope.to,
      timezone: "UTC",
      chairCount: 1,
      typicalAppointmentMinutes: 30,
      availabilityConfigured: false,
      days: [],
    });
  }
  readOpenWorkLedger(scope: OpenWorkScope) {
    return this.note(
      "readOpenWorkLedger",
      this.sliceFor({ kind: "patients", clinicId: scope.clinicId, patientIds: [], asOf: scope.asOf, limit: scope.limit }),
    );
  }
}

function run(deps: { ledgerPort?: ClinicLedgerPort; contextPort?: ClinicLedgerPort }) {
  let tick = 0;
  return new BusinessBrain({ repository, logger: silent, clock: () => (tick += 5), ...deps }).runBusinessBrain(
    CLINIC,
    DATE,
    { startedAt: STARTED_AT },
  );
}

describe("ledger port as the diagnosis context", () => {
  it("is asked exactly what a diagnosis context would be asked, and yields the same diagnoses", async () => {
    const asLedger = new RecordingLedger();
    const asContext = new RecordingLedger();
    const viaLedger = await run({ ledgerPort: asLedger });
    const viaContext = await run({ contextPort: asContext });

    expect(asLedger.calls.length).toBeGreaterThan(0);
    expect([...asLedger.calls].sort()).toEqual([...asContext.calls].sort());
    expect(viaLedger.diagnoses).toEqual(viaContext.diagnoses);
    // The daily run never reads the ledger itself.
    expect(asLedger.calls).not.toContain("readPatientLedger");
    expect(asLedger.calls).not.toContain("readAppointmentWindow");
  });

  it("prefers an explicitly supplied context port for diagnosis", async () => {
    const ledger = new RecordingLedger();
    const context = new RecordingLedger();
    await run({ ledgerPort: ledger, contextPort: context });
    expect(context.calls.length).toBeGreaterThan(0);
    expect(ledger.calls).toEqual([]);
  });
});

describe("reading the ledger through the service", () => {
  const scope: PatientLedgerScope = {
    kind: "patients",
    clinicId: CLINIC,
    patientIds: ["p1", "p2"],
    asOf: STARTED_AT,
    limit: 50,
  };

  it("returns null — cannot answer — when no ledger port was supplied", async () => {
    const brain = new BusinessBrain({ repository, logger: silent });
    expect(await brain.readPatientLedger(scope)).toBeNull();
    expect(
      await brain.readAppointmentWindow({
        kind: "appointment_window",
        clinicId: CLINIC,
        from: DATE,
        to: DATE,
        asOf: STARTED_AT,
        limit: 50,
      }),
    ).toBeNull();
  });

  it("returns a graph over the port's slice", async () => {
    const brain = new BusinessBrain({ repository, logger: silent, ledgerPort: new RecordingLedger() });
    const graph = await brain.readPatientLedger(scope);
    expect(graph?.appointmentsOfPatient("p1").status).toBe("known");
  });

  it("refuses a slice the adapter returned for the wrong clinic", async () => {
    const brain = new BusinessBrain({
      repository,
      logger: silent,
      ledgerPort: new RecordingLedger((s) => fixtureSlice({ scope: { ...s, clinicId: OTHER_CLINIC } })),
    });
    await expect(brain.readPatientLedger(scope)).rejects.toBeInstanceOf(LedgerIntegrityError);
  });

  it("propagates a failed read instead of inventing an empty ledger", async () => {
    const failing = new RecordingLedger(() => {
      throw new Error("connection reset");
    });
    const brain = new BusinessBrain({ repository, logger: silent, ledgerPort: failing });
    await expect(brain.readPatientLedger(scope)).rejects.toThrow("connection reset");
  });
});
