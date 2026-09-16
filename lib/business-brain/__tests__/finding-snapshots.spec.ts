/**
 * What a finding snapshot records: identifiers, ordinals and root-cause codes —
 * and never the clinic-entered treatment-type text a concentration can name.
 */

import { describe, expect, it } from "vitest";

import type { PrioritizedFindings, RankedFinding, RootCauseAnalysis } from "@/business-brain";
import { todayFinding } from "@/business-brain/engines/learning/__tests__/learning-fixtures";
import { snapshotFindings } from "../finding-snapshots";

const analysis = {
  question: "overrun",
  outcome: "explained",
  associations: [
    { id: "rootcause.overrun:finding.x#treatment_type:mrs rao crown redo", dimension: "treatment_type" },
    { id: "rootcause.overrun:finding.x#session:2", dimension: "session" },
  ],
} as unknown as RootCauseAnalysis;

function prioritized(): PrioritizedFindings {
  const withCause = todayFinding("schedule_accuracy", {}, { rootCauses: [analysis] });
  const plain = todayFinding("retention");
  const ranked = (finding: typeof plain, rank: number): RankedFinding =>
    ({ finding, role: rank === 1 ? "top" : "next", rank, factors: {}, explanation: "x", comparedWithNext: null, supports: null, collapseReason: null }) as unknown as RankedFinding;
  return {
    clinicId: "clinic_a",
    date: "2026-09-14",
    generatedAt: "2026-09-14T08:00:00.000Z",
    top: ranked(withCause, 1),
    next: [ranked(plain, 2)],
    supporting: [],
    wins: [],
    noActionRequired: [],
    unmeasured: [],
  };
}

describe("finding snapshots", () => {
  it("record root-cause codes with each finding, dropping treatment-type groups", () => {
    const rows = snapshotFindings(prioritized(), new Set(["retention"]));
    const overrun = rows.find((r) => r.category === "schedule_accuracy");
    expect(overrun?.rootCauses).toEqual([{ question: "overrun", outcome: "explained", associations: [{ dimension: "session", group: "2" }] }]);
    expect(JSON.stringify(rows)).not.toContain("rao");
    expect(rows.find((r) => r.category === "retention")).toMatchObject({ suppressed: true, role: "next", rank: 2 });
    expect(rows.find((r) => r.category === "retention")).not.toHaveProperty("rootCauses");
  });
});
