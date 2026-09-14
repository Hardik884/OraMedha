/**
 * Orchestrator unit specs — fake repository, no database.
 *
 * These pin the coordination contract: stage recording, failure containment,
 * determinism, and the read-only guarantee. The engines' own behaviour is
 * covered by their own suites and is not re-asserted here.
 */

import { describe, expect, it } from "vitest";

import type { ClinicDataSnapshot, MetricsDataRepository } from "../../repositories";
import { assessRunHealth, BUSINESS_BRAIN_VERSION, BusinessBrain, BusinessBrainStageName } from "../business-brain-service";
import type { Logger } from "../../utils";

const CLINIC = "clinic_orch";
const DATE = "2026-07-28";
const STARTED_AT = "2026-07-28T06:30:00.000Z";

function silentLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function snapshotFor(clinicId: string, date: string): ClinicDataSnapshot {
  return {
    clinicId,
    date,
    asOf: `${date}T06:30:00.000Z`,
    // A quiet-but-real day: few appointments, low revenue, a queue backlog.
    appointmentsToday: [
      { id: "a1", patientId: "p1", status: "completed", scheduledAt: `${date}T04:00:00.000Z`, createdAt: `${date}T00:00:00.000Z`, durationMinutes: 30, source: "walk_in" },
      { id: "a2", patientId: "p2", status: "no_show", scheduledAt: `${date}T05:00:00.000Z`, createdAt: `${date}T00:00:00.000Z`, durationMinutes: 30, source: "website" },
    ],
    patientsRegisteredToday: [],
    patientsSeenToday: [{ id: "p1", createdAt: "2026-01-01T00:00:00.000Z" }],
    treatments: [
      { id: "t1", cost: 60000, status: "planned", performedAt: null, isScheduled: false },
    ],
    payments: [],
    queueToday: [
      { id: "q1", status: "waiting", checkedInAt: `${date}T05:00:00.000Z`, startedAt: null },
      { id: "q2", status: "waiting", checkedInAt: `${date}T05:10:00.000Z`, startedAt: null },
    ],
    followUps: [],
    capacity: { openMinutesToday: 480, chairCount: 1, typicalAppointmentMinutes: 30 },
  };
}

/** Records every call so a test can prove the pipeline only reads. */
class RecordingRepository implements MetricsDataRepository {
  readonly calls: Array<{ clinicId: string; date: string }> = [];
  constructor(private readonly fail?: Error) {}
  async getClinicSnapshot(clinicId: string, date: string): Promise<ClinicDataSnapshot> {
    this.calls.push({ clinicId, date });
    if (this.fail) throw this.fail;
    return snapshotFor(clinicId, date);
  }
}

function brainWith(repository: MetricsDataRepository) {
  let tick = 0;
  return new BusinessBrain({
    repository,
    logger: silentLogger(),
    // Deterministic timing so execution metadata is comparable too.
    clock: () => (tick += 10),
  });
}

describe("BusinessBrain orchestration", () => {
  it("runs every stage and returns their outputs", async () => {
    const result = await brainWith(new RecordingRepository()).runBusinessBrain(CLINIC, DATE, {
      startedAt: STARTED_AT,
      correlationId: "corr-1",
    });

    expect(result.ok).toBe(true);
    expect(result.metrics.length).toBeGreaterThan(0);
    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.execution.stages.map((s) => s.stage)).toEqual([
      "metrics",
      "signals",
      "diagnosis",
      "strategy",
      "actions",
    ]);
    expect(result.execution.stages.every((s) => s.executed && s.ok)).toBe(true);
  });

  it("threads one execution context through every stage", async () => {
    const result = await brainWith(new RecordingRepository()).runBusinessBrain(CLINIC, DATE, {
      startedAt: STARTED_AT,
      correlationId: "corr-shared",
    });
    expect(result.execution.correlationId).toBe("corr-shared");
    expect(result.execution.startedAt).toBe(STARTED_AT);
    expect(result.clinicId).toBe(CLINIC);
    expect(result.date).toBe(DATE);
    expect(result.execution.version).toBe(BUSINESS_BRAIN_VERSION);
  });

  it("uses the injected logical time as `now` for every engine", async () => {
    const result = await brainWith(new RecordingRepository()).runBusinessBrain(CLINIC, DATE, {
      startedAt: STARTED_AT,
    });
    for (const signal of result.signals) {
      expect(signal.generatedAt).toBe(STARTED_AT);
    }
  });

  it("is deterministic — identical payloads across repeated runs", async () => {
    const brain = brainWith(new RecordingRepository());
    const a = await brainWith(new RecordingRepository()).runBusinessBrain(CLINIC, DATE, {
      startedAt: STARTED_AT,
      correlationId: "c",
    });
    const b = await brain.runBusinessBrain(CLINIC, DATE, {
      startedAt: STARTED_AT,
      correlationId: "c",
    });
    expect(b.metrics).toEqual(a.metrics);
    expect(b.signals).toEqual(a.signals);
    expect(b.diagnoses).toEqual(a.diagnoses);
  });

  it("carries the Signal Engine's trace into the Diagnosis Engine", async () => {
    const result = await brainWith(new RecordingRepository()).runBusinessBrain(CLINIC, DATE, {
      startedAt: STARTED_AT,
    });
    // Without the trace the Diagnosis Engine cannot distinguish "measured
    // nothing" from "could not run", so it must be present and non-empty.
    expect(result.trace.length).toBeGreaterThan(0);
    expect(result.trace.some((t) => t.engine === "SignalEngine")).toBe(true);
  });

  it("reads only — one repository call per day, and no other collaborator", async () => {
    const repo = new RecordingRepository();
    await brainWith(repo).runBusinessBrain(CLINIC, DATE, { startedAt: STARTED_AT });
    // MetricsDataRepository exposes exactly one method, and it is a read.
    expect(repo.calls).toEqual([{ clinicId: CLINIC, date: DATE }]);
    expect(Object.keys(Object.getPrototypeOf(repo)).length).toBeLessThanOrEqual(2);
  });

  describe("failure containment", () => {
    it("returns a recorded failure, not a throw, when the repository fails", async () => {
      const repo = new RecordingRepository(new Error("connection refused"));
      const result = await brainWith(repo).runBusinessBrain(CLINIC, DATE, {
        startedAt: STARTED_AT,
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("METRICS_DATA_UNAVAILABLE");
      expect(result.metrics).toEqual([]);
      expect(result.signals).toEqual([]);
      expect(result.diagnoses).toEqual([]);
    });

    it("records later stages as not executed when an earlier one fails", async () => {
      const repo = new RecordingRepository(new Error("boom"));
      const result = await brainWith(repo).runBusinessBrain(CLINIC, DATE, {
        startedAt: STARTED_AT,
      });
      const byStage = Object.fromEntries(result.execution.stages.map((s) => [s.stage, s]));
      expect(byStage.metrics.executed).toBe(true);
      expect(byStage.signals.executed).toBe(false);
      expect(byStage.diagnosis.executed).toBe(false);
    });

    it("rejects a malformed date before any engine runs", async () => {
      const repo = new RecordingRepository();
      const result = await brainWith(repo).runBusinessBrain(CLINIC, "2026-02-30", {
        startedAt: STARTED_AT,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("BUSINESS_BRAIN_INVALID_DATE");
      expect(repo.calls).toEqual([]);
    });
  });

  describe("run health", () => {
    // A failed run carries empty outputs, and empty outputs read exactly like a
    // clinic with nothing wrong. Every surface that renders or records a run asks
    // this first.
    it("calls a run healthy only when every stage executed and succeeded", async () => {
      const result = await brainWith(new RecordingRepository()).runBusinessBrain(CLINIC, DATE, { startedAt: STARTED_AT });
      expect(assessRunHealth(result)).toEqual({ healthy: true, failedStages: [], errorCode: null });
    });

    it("calls a run whose data could not be read unhealthy, naming every stage it lost", async () => {
      const result = await brainWith(new RecordingRepository(new Error("connection refused"))).runBusinessBrain(CLINIC, DATE, { startedAt: STARTED_AT });
      const health = assessRunHealth(result);
      expect(health.healthy).toBe(false);
      expect(health.errorCode).toBe("METRICS_DATA_UNAVAILABLE");
      // Including the stages a failed run never records at all.
      expect(health.failedStages).toEqual(Object.values(BusinessBrainStageName));
    });

    it("calls a run unhealthy when a stage is missing, or ran and failed, even if the run says ok", async () => {
      const result = await brainWith(new RecordingRepository()).runBusinessBrain(CLINIC, DATE, { startedAt: STARTED_AT });
      const [first, ...rest] = result.execution.stages;
      expect(assessRunHealth({ ...result, execution: { ...result.execution, stages: rest } }).failedStages).toEqual([first.stage]);
      const failed = result.execution.stages.map((s, i) => (i === 3 ? { ...s, ok: false } : s));
      expect(assessRunHealth({ ...result, execution: { ...result.execution, stages: failed } })).toMatchObject({ healthy: false, failedStages: [failed[3].stage] });
      expect(assessRunHealth({ ...result, ok: false }).healthy).toBe(false);
    });

    it("calls a malformed date unhealthy", async () => {
      const result = await brainWith(new RecordingRepository()).runBusinessBrain(CLINIC, "2026-02-30", { startedAt: STARTED_AT });
      expect(assessRunHealth(result)).toMatchObject({ healthy: false, errorCode: "BUSINESS_BRAIN_INVALID_DATE" });
    });
  });

  it("gives the same answer however the database happened to order its rows", async () => {
    // PostgREST promises no order without ORDER BY, and paging reorders ties.
    // Nothing downstream may depend on it.
    const reversed: MetricsDataRepository = {
      async getClinicSnapshot(clinicId, date) {
        const s = snapshotFor(clinicId, date);
        return {
          ...s,
          appointmentsToday: [...s.appointmentsToday].reverse(),
          patientsSeenToday: [...s.patientsSeenToday].reverse(),
          treatments: [...s.treatments, { id: "t0", cost: 1500, status: "completed", performedAt: `${date}T04:30:00.000Z`, isScheduled: false }].reverse(),
          queueToday: [...s.queueToday].reverse(),
        };
      },
    };
    const forward: MetricsDataRepository = {
      async getClinicSnapshot(clinicId, date) {
        const s = snapshotFor(clinicId, date);
        return { ...s, treatments: [...s.treatments, { id: "t0", cost: 1500, status: "completed", performedAt: `${date}T04:30:00.000Z`, isScheduled: false }] };
      },
    };
    const a = await brainWith(forward).runBusinessBrain(CLINIC, DATE, { startedAt: STARTED_AT, correlationId: "c" });
    const b = await brainWith(reversed).runBusinessBrain(CLINIC, DATE, { startedAt: STARTED_AT, correlationId: "c" });
    expect(b.metrics).toEqual(a.metrics);
    expect(b.signals).toEqual(a.signals);
    expect(b.diagnoses).toEqual(a.diagnoses);
    expect(b.constraints).toEqual(a.constraints);
    expect(b.actionPlans).toEqual(a.actionPlans);
  });

  describe("history", () => {
    it("loads no history by default", async () => {
      const repo = new RecordingRepository();
      const result = await brainWith(repo).runBusinessBrain(CLINIC, DATE, {
        startedAt: STARTED_AT,
      });
      expect(repo.calls).toHaveLength(1);
      expect(result.execution.historyDaysRequested).toBe(0);
      expect(result.execution.historyDaysLoaded).toBe(0);
    });

    it("loads the requested prior days, ascending and excluding the target date", async () => {
      const repo = new RecordingRepository();
      const result = await brainWith(repo).runBusinessBrain(CLINIC, DATE, {
        startedAt: STARTED_AT,
        historyDays: 3,
      });
      const dates = repo.calls.map((c) => c.date);
      expect(dates).toContain("2026-07-25");
      expect(dates).toContain("2026-07-26");
      expect(dates).toContain("2026-07-27");
      expect(dates.filter((d) => d === DATE)).toHaveLength(1);
      expect(result.execution.historyDaysLoaded).toBe(3);
    });

    it("skips a history day it cannot read rather than failing the run", async () => {
      let n = 0;
      const flaky: MetricsDataRepository = {
        async getClinicSnapshot(clinicId, date) {
          n += 1;
          if (n === 2) throw new Error("transient");
          return snapshotFor(clinicId, date);
        },
      };
      const result = await brainWith(flaky).runBusinessBrain(CLINIC, DATE, {
        startedAt: STARTED_AT,
        historyDays: 2,
      });
      expect(result.ok).toBe(true);
      expect(result.execution.historyDaysLoaded).toBe(1);
      expect(result.execution.historyDaysRequested).toBe(2);
    });
  });
});
