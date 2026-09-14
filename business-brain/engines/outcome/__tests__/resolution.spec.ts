/**
 * What became of the finding an action answered.
 *
 * Completing an action never resolves anything: resolution is read from the
 * findings recorded on the days after, and "not enough recorded days" is an
 * answer of its own.
 */

import { describe, expect, it } from "vitest";

import { OutcomeAttribution, ResolutionStatus, TrajectoryState, type Outcome } from "../../../domain";
import { deriveOutcomes } from "../outcome-engine";
import { resolveOutcome } from "../resolution";
import {
  CLINIC,
  completion,
  DATE,
  NOW,
  snapshot,
  snapshotFinding,
  todayFinding,
} from "../../learning/__tests__/learning-fixtures";

const D0 = "2026-09-01";

function outcome(over: Partial<Outcome> = {}): Outcome {
  return {
    id: "outcome.c0",
    completionId: "c0",
    category: "retention",
    constraintId: `constraint.retention:${CLINIC}:${D0}`,
    status: "completed",
    source: "declared",
    completedAt: `${D0}T10:00:00.000Z`,
    attribution: OutcomeAttribution.INSUFFICIENT_EVIDENCE,
    reasoning: "",
    recordedAt: NOW,
    evidenceQuality: { completion: "staff_declared", completionTime: "declaration_time", results: null, pointInTime: false },
    ...over,
  };
}

const flagged = (date: string, severity = "high") => snapshot(date, [snapshotFinding("retention", { severity })]);
const clear = (date: string) => snapshot(date, [snapshotFinding("revenue_leakage")]);

describe("resolution", () => {
  it("names the finding the action answered", () => {
    const r = resolveOutcome(outcome(), D0, { date: DATE, today: null, snapshots: [] });
    expect(r.parentFindingId).toBe(`finding.problem:constraint.retention:${CLINIC}:${D0}`);
  });

  it("is insufficient evidence when nothing has been recorded since — completing is not resolving", () => {
    const r = resolveOutcome(outcome(), D0, { date: DATE, today: null, snapshots: [flagged(D0)] });
    expect(r.status).toBe(ResolutionStatus.INSUFFICIENT_EVIDENCE);
    expect(r.observedDays).toBe(0);
  });

  it("is resolved after three consecutive recorded clear days, bridging unrecorded days", () => {
    const r = resolveOutcome(outcome(), D0, {
      date: DATE,
      today: null,
      snapshots: [flagged(D0), flagged("2026-09-02"), clear("2026-09-05"), clear("2026-09-09"), clear("2026-09-12")],
    });
    expect(r.status).toBe(ResolutionStatus.RESOLVED);
    expect(r).toMatchObject({ consecutiveClearDays: 3, lastFlaggedOn: "2026-09-02", observedDays: 4 });
  });

  it("is insufficient evidence after only two clear days", () => {
    const r = resolveOutcome(outcome(), D0, { date: DATE, today: null, snapshots: [flagged("2026-09-02"), clear("2026-09-03"), clear("2026-09-04")] });
    expect(r.status).toBe(ResolutionStatus.INSUFFICIENT_EVIDENCE);
    expect(r.statement).toMatch(/3 in a row are needed/);
  });

  it("is still active when flagged today with no sign of change", () => {
    const r = resolveOutcome(outcome(), D0, { date: DATE, today: [todayFinding("retention")], snapshots: [flagged(D0), flagged("2026-09-05")] });
    expect(r.status).toBe(ResolutionStatus.STILL_ACTIVE);
  });

  it("is improving when flagged less severely than on the day of the action", () => {
    const r = resolveOutcome(outcome(), D0, { date: DATE, today: null, snapshots: [flagged(D0, "high"), flagged("2026-09-10", "medium")] });
    expect(r.status).toBe(ResolutionStatus.IMPROVING);
  });

  it("is improving when today's metric is recovering", () => {
    const recovering = todayFinding("retention", {}, { trajectories: [{ state: TrajectoryState.RECOVERING } as never] });
    const r = resolveOutcome(outcome(), D0, { date: DATE, today: [recovering], snapshots: [flagged(D0)] });
    expect(r.status).toBe(ResolutionStatus.IMPROVING);
  });

  it("separates an observed outcome from an unresolved finding", () => {
    const positive = outcome({ targets: { completionId: "c0", targeted: 8, resolvable: 8, confirmed: 5, verifiable: true } });
    const r = resolveOutcome(positive, D0, { date: DATE, today: [todayFinding("retention")], snapshots: [flagged(D0)] });
    expect(r.status).toBe(ResolutionStatus.OUTCOME_OBSERVED_UNRESOLVED);
  });

  it("is attached by the engine only when resolution input is supplied", () => {
    const base = { completions: [completion("c0", D0)], verifications: new Map(), metrics: [], now: NOW };
    expect(deriveOutcomes(base).outcomes[0]).not.toHaveProperty("resolution");
    const resolved = deriveOutcomes({ ...base, resolution: { date: DATE, today: [], snapshots: [clear("2026-09-10"), clear("2026-09-11")] } });
    // Two recorded clear days plus today's clear run.
    expect(resolved.outcomes[0].resolution?.status).toBe(ResolutionStatus.RESOLVED);
  });
});
