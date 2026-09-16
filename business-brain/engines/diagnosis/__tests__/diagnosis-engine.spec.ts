import { describe, expect, it } from "vitest";

import { DiagnosisPattern } from "../../../domain";
import type { ExecutionContext } from "../../../types";
import { MATCHERS } from "../matchers/registry";
import { DentGrowDiagnosisEngine } from "../diagnosis-engine";
import {
  CLINIC_ID,
  DATE,
  DEMAND_SUPPLY_WITH_PENDING,
  HEALTHY,
  ISOLATED_SIGNAL,
  NOW,
  PRIOR,
  run,
  shiftDate,
} from "./fixtures/run-fixtures";

const context: ExecutionContext = {
  clinicId: CLINIC_ID,
  correlationId: "corr-1",
  startedAt: NOW,
  requestedBy: "user_1",
  role: "dentist",
};

const engine = new DentGrowDiagnosisEngine();

describe("DentGrowDiagnosisEngine", () => {
  it("wraps diagnoses in an EngineResult using context.startedAt as the clock", () => {
    const result = engine.run({ current: run(DEMAND_SUPPLY_WITH_PENDING) }, context);
    expect(result.ok).toBe(true);
    expect(result.generatedAt).toBe(NOW);
    expect(result.data?.every((d) => d.generatedAt === NOW)).toBe(true);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("derives the clinic from the execution context", () => {
    const result = engine.run({ current: run(ISOLATED_SIGNAL) }, context);
    expect(result.data?.[0].id).toContain(`:${CLINIC_ID}:${DATE}`);
    expect(result.data?.[0].relatedEntities).toEqual([
      { type: "clinic", id: CLINIC_ID },
    ]);
  });

  it("traces one step per matcher, including the non-matches", () => {
    const result = engine.run({ current: run(HEALTHY) }, context);
    const steps = (result.trace ?? []).map((t) => t.step);
    expect(steps[0]).toBe("prepare-input");
    expect(steps[steps.length - 1]).toBe("summarise-run");
    // prepare + one per matcher + unclustered + summary
    expect(steps).toHaveLength(MATCHERS.length + 3);
    expect(new Set(steps).size).toBe(steps.length);
    expect((result.trace ?? []).every((t) => t.engine === "DiagnosisEngine")).toBe(true);
  });

  it("does not report full confidence for a run that produced nothing", () => {
    const result = engine.run({ current: run(HEALTHY) }, context);
    expect(result.data).toEqual([]);
    // Three trend evaluators had no prior period, so the two matchers that
    // require returning_volume_dropping — patient_base_erosion and
    // recall_process_failure — are undecidable. Derived from MATCHERS so the
    // assertion tracks the registry instead of going stale behind it.
    expect(result.confidence).toBe(
      Math.round(((MATCHERS.length - 2) / MATCHERS.length) * 100) / 100,
    );
    expect(
      (result.trace ?? []).find((t) => t.step === "summarise-run")?.reasoning,
    ).toContain("matcher decidability");
  });

  it("returns a typed error for history from another clinic", () => {
    const result = engine.run(
      {
        current: run(DEMAND_SUPPLY_WITH_PENDING),
        history: [
          run(DEMAND_SUPPLY_WITH_PENDING, {
            date: shiftDate(DATE, -1),
            clinicId: "clinic_999",
          }),
        ],
      },
      context,
    );
    expect(result.ok).toBe(false);
    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("DIAGNOSIS_ENGINE_MIXED_CLINIC");
    expect(result.trace?.[0].step).toBe("validate-input");
    expect(result.confidence).toBeUndefined();
  });

  it("honours construction-time configuration overrides", () => {
    const strict = new DentGrowDiagnosisEngine({
      config: { confidence: { minimumToEmit: 0.95 } },
    });
    const result = strict.run({ current: run(ISOLATED_SIGNAL) }, context);
    // the diagnosis is suppressed for confidence, and the suppression is traced
    expect(result.data).toEqual([]);
    expect(
      (result.trace ?? []).find(
        (t) => t.step === DiagnosisPattern.UNCLUSTERED_SIGNAL,
      )?.reasoning,
    ).toContain("suppressed: confidence");
  });

  it("matches run() through the async contract entry point", async () => {
    const input = {
      current: run(DEMAND_SUPPLY_WITH_PENDING, { previous: PRIOR }),
    };
    await expect(engine.execute(input, context)).resolves.toEqual(
      engine.run(input, context),
    );
  });

  it("never produces a Diagnosis without a hypothesis, and never a priority field", () => {
    const result = engine.run(
      { current: run(DEMAND_SUPPLY_WITH_PENDING, { previous: PRIOR }) },
      context,
    );
    for (const diagnosis of result.data ?? []) {
      expect(diagnosis.hypotheses.length).toBeGreaterThan(0);
      expect(diagnosis).not.toHaveProperty("priority");
      const allUndetermined = diagnosis.hypotheses.every(
        (h) => h.status === "undetermined",
      );
      if (allUndetermined) expect(diagnosis.discriminators.length).toBeGreaterThan(0);
      for (const hypothesis of diagnosis.hypotheses) {
        if (hypothesis.status === "undetermined") {
          expect(hypothesis.requiredData.length).toBeGreaterThan(0);
        } else {
          expect(hypothesis.requiredData).toEqual([]);
        }
      }
    }
  });
});
