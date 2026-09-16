/**
 * The collapsed "What happened after?" detail on a completed action.
 *
 * Absent for an outcome assessed without history, so the row reads exactly as it
 * did; otherwise attribution, measurements, resolution and — only past its
 * threshold — what the clinic's own history shows.
 */

import { describe, expect, it } from "vitest";

import { LearningKind, OutcomeAttribution, type ClinicLearning, type Learning } from "@/business-brain";
import { deriveLearning } from "@/business-brain/engines/learning";
import { assess, goodRecalls, CAUSAL } from "@/business-brain/engines/learning/__tests__/learning-fixtures";
import { buildOutcomeViews } from "../outcomes-view";

const NOW = "2026-09-14T20:00:00.000Z";
const DATES = ["2026-05-04", "2026-05-25", "2026-06-15", "2026-07-06", "2026-07-27"];

function scenario() {
  const { completions, hist } = goodRecalls(DATES);
  const outcomes = assess(completions, hist);
  const learning = deriveLearning({ clinicId: "clinic_a", date: "2026-09-14", timezone: "UTC", outcomes, snapshots: [], dismissals: [], today: null, gaps: [] });
  return { outcomes, learning };
}

describe("what happened after", () => {
  it("is absent when the outcome carries no windowed evidence", () => {
    const { completions } = goodRecalls(DATES);
    const [view] = buildOutcomeViews(assess(completions, undefined), NOW);
    expect(view.whatHappened).toBeNull();
  });

  it("states the rung, the measurements and the clinic's repeated pattern", () => {
    const { outcomes, learning } = scenario();
    const views = buildOutcomeViews(outcomes, NOW, learning);
    const strong = views.find((v) => v.id === "outcome.c4");
    expect(outcomes.find((o) => o.id === "outcome.c4")?.attribution).toBe(OutcomeAttribution.STRONG_EVIDENCE);
    expect(strong?.whatHappened).toEqual({
      attributionLabel: "Strong evidence — repeated at this clinic",
      evidence: [
        "The overdue recall list read 20 at the time and 12 after 14 days (it normally varies by about 4).",
        "7 of 8 patients showed the intended result within 14 days.",
      ],
      resolution: null,
      learning:
        "Working the overdue recall list has repeatedly been associated with a shorter overdue recall list at this clinic: 5 of 5 completed actions across 5 separate weeks met the evidence standard.",
      proposal: {
        id: "proposal.action_preference:learning.repeated_improvement:retention:clinic_a",
        statement: expect.stringMatching(/^For review: keep "working the overdue recall list" as a first response/),
        decision: null,
      },
    });
  });

  it("shows no learning for an action whose category has none, and none from another category", () => {
    const { outcomes } = scenario();
    const other: ClinicLearning = {
      clinicId: "clinic_a",
      date: "2026-09-14",
      window: { from: "2026-03-19", to: "2026-09-14" },
      learnings: [{ kind: LearningKind.REPEATED_IMPROVEMENT, subject: "revenue_leakage", statement: "Following up outstanding payments was followed by 9 patients recording a payment from 12 completed actions." } as Learning],
      assessments: [],
      proposals: [],
      coverage: { completions: 0, closedOutcomes: 0, recordedDays: 0, gaps: [] },
    };
    const [view] = buildOutcomeViews(outcomes, NOW, other);
    expect(view.whatHappened?.learning).toBeNull();
  });

  it("never claims one thing produced another", () => {
    const { outcomes, learning } = scenario();
    for (const view of buildOutcomeViews(outcomes, NOW, learning)) {
      const d = view.whatHappened;
      for (const text of [d?.attributionLabel, ...(d?.evidence ?? []), d?.resolution, d?.learning]) {
        if (text) expect(text).not.toMatch(CAUSAL);
      }
    }
  });
});
