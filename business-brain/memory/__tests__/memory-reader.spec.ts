/**
 * The memory reader contract: every answer carries a status, its entries with
 * evidence and confidence, and the build date — never a sentence — and inactive
 * memory is never returned as support unless explicitly asked for.
 */

import { describe, expect, it } from "vitest";

import { addDays } from "../../utils";
import { assess, goodRecalls, noisy, OVERDUE, overdue, readings } from "../../engines/learning/__tests__/learning-fixtures";
import { ClinicMemoryReader } from "../memory-reader";
import { memoryId, MemoryIntegrityError } from "../memory-engine";
import { build, CLINIC, DATE, days, decision, problem } from "./memory-fixtures";

const recalls = goodRecalls(["2026-05-04", "2026-05-25", "2026-06-15", "2026-07-06", "2026-07-27"]);
const PROPOSAL = `proposal.action_preference:learning.repeated_improvement:retention:${CLINIC}`;

function memoryWith(overdueSeries = overdue()) {
  return build({
    metricDays: readings("2026-06-01", DATE, { [OVERDUE]: overdueSeries }),
    snapshots: days("2026-05-01", DATE, (i) => (i % 20 < 5 ? [problem()] : [])),
    outcomes: assess(recalls.completions, recalls.hist),
    decisions: [
      decision({ target: { type: "proposal", id: PROPOSAL } }),
      decision({ target: { type: "proposal", id: "proposal.workflow_improvement:learning.recurring_unresolved:scheduling:clinic_a" }, decision: "rejected", subject: "scheduling" }),
    ],
  });
}

describe("memory reader", () => {
  it("says the memory was never built, rather than that nothing is known", () => {
    const reader = ClinicMemoryReader.for(CLINIC, null);
    expect(reader.normalRange(OVERDUE)).toEqual({ status: "not_built", entries: [], confidence: null, builtFor: null });
    expect(reader.unusual(OVERDUE, 50).verdict).toBe("unknown");
    expect(reader.acceptedPreferences()).toEqual([]);
  });

  it("answers with entries, evidence, confidence and the build date", () => {
    const reader = ClinicMemoryReader.for(CLINIC, memoryWith());
    const range = reader.normalRange(OVERDUE);
    expect(range.status).toBe("known");
    expect(range.builtFor).toBe(DATE);
    expect(range.confidence).toBe(0.95);
    expect(range.entries[0].evidence.refs.length).toBeGreaterThan(0);
    expect(range.entries[0]).not.toHaveProperty("statement");

    expect(reader.recurringProblems("retention").entries[0].facts.episodes).toBe(7);
    expect(reader.effectiveActions("retention").entries[0].facts.level).toBe("strong_evidence");
    expect(reader.ineffectiveActions("retention").status).toBe("insufficient_evidence");
  });

  it("judges a reading unusual only against an active range", () => {
    const reader = ClinicMemoryReader.for(CLINIC, memoryWith());
    expect(reader.unusual(OVERDUE, 31)).toMatchObject({ verdict: "unusual", direction: "above", confidence: 0.95 });
    expect(reader.unusual(OVERDUE, 20)).toMatchObject({ verdict: "usual", direction: null });
    expect(reader.unusual(OVERDUE, null).verdict).toBe("unknown");

    const span: Record<string, number> = {};
    for (let d = "2026-09-03"; d <= DATE; d = addDays(d, 1)) span[d] = 30;
    const weakening = ClinicMemoryReader.for(CLINIC, memoryWith(overdue(span)));
    expect(weakening.normalRange(OVERDUE).entries[0].status).toBe("weakening");
    expect(weakening.unusual(OVERDUE, 31).verdict).toBe("unknown");
  });

  it("returns inactive memory only when asked, and lists it as stale", () => {
    const stale = build({ metricDays: readings("2026-06-01", "2026-08-20", { [OVERDUE]: noisy(20) }) });
    const reader = ClinicMemoryReader.for(CLINIC, stale);
    expect(reader.normalRange(OVERDUE).status).toBe("insufficient_evidence");
    expect(reader.normalRange(OVERDUE, { includeInactive: true }).entries[0].status).toBe("stale");
    expect(reader.stalePatterns().entries.map((e) => e.id)).toEqual([memoryId("normal_range", OVERDUE, null, CLINIC)]);
  });

  it("treats an answer below the confidence floor as insufficient evidence", () => {
    const reader = ClinicMemoryReader.for(CLINIC, memoryWith());
    expect(reader.normalRange(OVERDUE, { minConfidence: 0.99 }).status).toBe("insufficient_evidence");
  });

  it("lists accepted and rejected decisions apart from derived memory", () => {
    const reader = ClinicMemoryReader.for(CLINIC, memoryWith());
    expect(reader.acceptedPreferences().map((d) => [d.target.id, d.needsReview])).toEqual([[PROPOSAL, false]]);
    expect(reader.rejected().map((d) => d.subject)).toEqual(["scheduling"]);
  });

  it("refuses a memory built for another clinic, or carrying another clinic's entry", () => {
    const memory = memoryWith();
    expect(() => ClinicMemoryReader.for("clinic_b", memory)).toThrow(MemoryIntegrityError);
    const tampered = { ...memory, entries: [{ ...memory.entries[0], clinicId: "clinic_b" }] };
    expect(() => ClinicMemoryReader.for(CLINIC, tampered)).toThrow(MemoryIntegrityError);
  });
});
