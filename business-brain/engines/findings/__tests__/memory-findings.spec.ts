/**
 * Clinic memory inside findings: cited in explanations when an active entry
 * supports them, never read by a ranking factor, and refused across clinics.
 */

import { describe, expect, it } from "vitest";

import { ConstraintCategory } from "../../../domain";
import { MetricKey } from "../../metrics/metric-ids";
import { deriveTrajectories } from "../../trajectory";
import { daily, flat } from "../../trajectory/__tests__/trajectory-fixtures";
import { ClinicMemoryReader } from "../../../memory";
import { build, days, problem as snapshotProblem } from "../../../memory/__tests__/memory-fixtures";
import { overdue, readings } from "../../learning/__tests__/learning-fixtures";
import { FindingIntegrityError, normalizeFindings } from "../normalize";
import { prioritizeFindings } from "../prioritize";
import { CLINIC, DATE, NOW, problem, withProblems } from "./findings-fixtures";

const OVERDUE = MetricKey.FOLLOWUPS_OVERDUE;

/** A worsening overdue trajectory ending at 31 today. */
function overdueTrajectory() {
  const weekly = [20, ...flat(20, 7), ...flat(22, 7), ...flat(25, 7), ...flat(28, 7), ...flat(31, 7)];
  const t = deriveTrajectories({ clinicId: CLINIC, date: DATE, ...daily(weekly, OVERDUE, CLINIC, DATE) }).byKey.get(OVERDUE);
  if (t === undefined) throw new Error("no trajectory");
  return t;
}

const memory = build({
  metricDays: readings("2026-06-01", DATE, { [OVERDUE]: overdue() }),
  snapshots: days("2026-05-01", DATE, (i) => (i % 20 < 5 ? [snapshotProblem()] : [])),
});

function sources(withMemory: ReturnType<typeof build> | null | undefined) {
  return withProblems([problem(ConstraintCategory.RETENTION, "medium"), problem(ConstraintCategory.REVENUE_LEAKAGE, "medium")], {
    trajectories: [overdueTrajectory()],
    ...(withMemory === undefined ? {} : { memory: ClinicMemoryReader.for(CLINIC, withMemory) }),
  });
}

describe("memory in findings", () => {
  it("cites recurrence and this clinic's usual range, with the memory it rests on", () => {
    const retention = normalizeFindings(sources(memory)).find((f) => f.category === ConstraintCategory.RETENTION);
    expect(retention?.evidence.memory).toEqual({
      recurrence: {
        memoryId: `memory.recurring_problem:retention:${CLINIC}`,
        episodes: 7,
        windowDays: 365,
        typicalResolutionDays: 5,
        confidence: expect.any(Number),
        builtFor: DATE,
      },
      normalRange: {
        memoryId: `memory.normal_range:${OVERDUE}:${CLINIC}`,
        metricKey: OVERDUE,
        label: "The number of overdue follow-ups",
        current: 31,
        median: 20,
        lower: 16,
        upper: 24,
        direction: "above",
        confidence: 0.95,
        builtFor: DATE,
      },
    });
    const ranked = prioritizeFindings({ sources: sources(memory), now: NOW });
    const explanation = [ranked.top, ...ranked.next].find((r) => r?.finding.category === ConstraintCategory.RETENTION)?.explanation;
    expect(explanation).toContain("At 31, the number of overdue follow-ups is above this clinic's usual range of 16–24.");
    expect(explanation).toContain("At this clinic it has been flagged in 7 separate episodes over the last 12 months, each typically clearing after about 5 days.");
  });

  it("never changes the order, the factors or the confidence", () => {
    const shape = (s: ReturnType<typeof sources>) => {
      const r = prioritizeFindings({ sources: s, now: NOW });
      return [r.top, ...r.next, ...r.supporting, ...r.noActionRequired].map((x) => [x?.finding.id, x?.rank, x?.role, x?.factors, x?.finding.evidence.confidence, x?.comparedWithNext]);
    };
    expect(shape(sources(memory))).toEqual(shape(sources(undefined)));
  });

  it("says nothing from a memory that was never built, or no longer active", () => {
    expect(normalizeFindings(sources(null)).every((f) => f.evidence.memory === undefined)).toBe(true);
    const stale = build({ metricDays: readings("2026-06-01", "2026-08-20", { [OVERDUE]: overdue() }) });
    expect(normalizeFindings(sources(stale)).every((f) => f.evidence.memory === undefined)).toBe(true);
  });

  it("cites nothing from a build too old to vouch for today", () => {
    // The build job runs hourly; a build five days old means it has stopped, and
    // its "active" entries have not been revalidated since.
    const old = build({
      date: "2026-09-09",
      metricDays: readings("2026-06-01", "2026-09-09", { [OVERDUE]: overdue() }),
      snapshots: days("2026-05-01", "2026-09-09", (i) => (i % 20 < 5 ? [snapshotProblem()] : [])),
    });
    expect(old.entries.some((e) => e.status === "active")).toBe(true);
    expect(normalizeFindings(sources(old)).every((f) => f.evidence.memory === undefined)).toBe(true);
    const yesterday = build({
      date: "2026-09-13",
      metricDays: readings("2026-06-01", "2026-09-13", { [OVERDUE]: overdue() }),
      snapshots: days("2026-05-01", "2026-09-13", (i) => (i % 20 < 5 ? [snapshotProblem()] : [])),
    });
    expect(normalizeFindings(sources(yesterday)).some((f) => f.evidence.memory !== undefined)).toBe(true);
  });

  it("refuses a reader for another clinic", () => {
    const foreign = { ...memory, clinicId: "clinic_b", entries: memory.entries.map((e) => ({ ...e, clinicId: "clinic_b" })) };
    const s = { ...sources(undefined), memory: ClinicMemoryReader.for("clinic_b", foreign) };
    expect(() => normalizeFindings(s)).toThrow(FindingIntegrityError);
  });
});
