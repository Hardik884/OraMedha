/**
 * The Learning Engine: clinic-specific patterns, exposed only past their
 * thresholds, proposing and never applying.
 */

import { describe, expect, it } from "vitest";

import { LearningKind, ProposalKind, type ClinicLearning, type Outcome, type RootCauseAnalysis } from "../../../domain";
import type { FindingSnapshotFact } from "../../../ledger";
import { addDays } from "../../../utils";
import { DEFAULT_ROOT_CAUSE_CONFIG } from "../../root-cause";
import { FINDINGS_CONFIG } from "../../findings/findings-config";
import { DEFAULT_SIGNAL_THRESHOLDS } from "../../signals";
import { DEFAULT_ATTRIBUTION_CONFIG } from "../../outcome";
import { DEFAULT_LEARNING_CONFIG } from "../learning-config";
import { deriveLearning, LearningIntegrityError, type LearningInput } from "../learning-engine";
import {
  APPOINTMENTS,
  assess,
  CAUSAL,
  CLINIC,
  completion,
  confirmation,
  DATE,
  goodRecall,
  goodRecalls,
  history,
  noisy,
  OTHER,
  OVERDUE,
  overdue,
  readings,
  snapshot,
  snapshotFinding,
  snapshots,
  todayFinding,
} from "./learning-fixtures";

const WEEKLY = ["2026-05-04", "2026-05-25", "2026-06-15", "2026-07-06", "2026-07-27", "2026-08-17"];

function learn(over: Partial<LearningInput> = {}): ClinicLearning {
  return deriveLearning({ clinicId: CLINIC, date: DATE, timezone: "UTC", outcomes: [], snapshots: [], dismissals: [], today: null, gaps: [], ...over });
}

const find = (l: ClinicLearning, kind: string, subject = "retention") => l.learnings.find((x) => x.kind === kind && x.subject === subject);
const status = (l: ClinicLearning, kind: string, subject = "retention") => l.assessments.find((a) => a.kind === kind && a.subject === subject);

/** Recall completions on each date with the given confirmation delays and a flat metric. */
function recalls(dates: readonly string[], delays: (i: number) => number[]): readonly Outcome[] {
  const completions = dates.map((d, i) => completion(`c${i}`, d));
  return assess(
    completions,
    history(
      completions.map((c, i) => confirmation(c.id, 8, delays(i))),
      readings("2026-03-01", "2026-09-13", { [OVERDUE]: noisy(20), [APPOINTMENTS]: noisy(10) }),
    ),
  );
}

describe("insufficient history", () => {
  it("exposes nothing from three outcomes, and says why", () => {
    const l = learn({ outcomes: recalls(WEEKLY.slice(0, 3), () => [1, 2, 3]) });
    expect(l.learnings).toEqual([]);
    expect(status(l, LearningKind.REPEATED_IMPROVEMENT)).toMatchObject({
      status: "insufficient_evidence",
      reason: "3 closed, measurable outcome(s); 5 are needed",
    });
    expect(status(l, LearningKind.FREQUENTLY_IGNORED)?.reason).toBe("0 recorded briefing day(s); 14 are needed");
  });

  it("does not count completions whose windows are still open", () => {
    const l = learn({ outcomes: recalls(["2026-09-02", "2026-09-04", "2026-09-06", "2026-09-08", "2026-09-10", "2026-09-12"], () => [1]) });
    expect(status(l, LearningKind.REPEATED_IMPROVEMENT)?.status).toBe("insufficient_evidence");
  });

  it("does not count outcomes from before the lookback window", () => {
    const old = recalls(["2026-01-05", "2026-01-12", "2026-01-19", "2026-01-26", "2026-02-02"], () => [1, 2]);
    expect(status(learn({ outcomes: old }), LearningKind.REPEATED_IMPROVEMENT)?.reason).toMatch(/^0 closed/);
  });
});

describe("repeated improvement", () => {
  it("states what followed at the observed level", () => {
    const l = learn({ outcomes: recalls(WEEKLY, () => [1, 3, 5]) });
    const learning = find(l, LearningKind.REPEATED_IMPROVEMENT);
    expect(learning?.level).toBe("observed");
    expect(learning?.statement).toBe("Working the overdue recall list was followed by 18 completed follow-ups from 6 completed actions.");
    expect(learning?.counts).toMatchObject({ outcomes: 6, followedByResult: 6, results: 18, likelyContributed: 0 });
    // Observed alone proposes nothing.
    expect(l.proposals.filter((p) => p.learningId === learning?.id)).toEqual([]);
  });

  it("says 'associated with' at the likely-contributed level", () => {
    const items = WEEKLY.slice(0, 5).map((d, i) => goodRecall(`c${i}`, d));
    const overrides = Object.assign({}, ...items.slice(0, 3).map((i) => i.overrides)) as Record<string, number>;
    const confirmations = items.map((i, k) => (k < 3 ? i.confirmation : confirmation(i.completion.id, 8, [2, 4, 6])));
    const outcomes = assess(
      items.map((i) => i.completion),
      history(confirmations, readings("2026-03-01", "2026-09-13", { [OVERDUE]: overdue(overrides), [APPOINTMENTS]: noisy(10) })),
    );
    const learning = find(learn({ outcomes }), LearningKind.REPEATED_IMPROVEMENT);
    expect(learning?.level).toBe("likely_contributed");
    expect(learning?.statement).toBe(
      "Working the overdue recall list has been associated with a shorter overdue recall list at this clinic: 3 of 5 completed actions met the likely-contributed evidence standard.",
    );
  });

  it("says 'repeatedly associated with' at strong evidence, and proposes — never applies — a preference", () => {
    const { completions, hist } = goodRecalls(WEEKLY.slice(0, 5));
    const l = learn({ outcomes: assess(completions, hist) });
    const learning = find(l, LearningKind.REPEATED_IMPROVEMENT);
    expect(learning?.level).toBe("strong_evidence");
    expect(learning?.statement).toBe(
      "Working the overdue recall list has repeatedly been associated with a shorter overdue recall list at this clinic: 5 of 5 completed actions across 5 separate weeks met the evidence standard.",
    );
    const [proposal] = l.proposals.filter((p) => p.learningId === learning?.id);
    expect(proposal).toMatchObject({ kind: ProposalKind.ACTION_PREFERENCE, status: "proposed", requiresHumanAcceptance: true, appliedAutomatically: false });
  });

  it("times how long the result takes", () => {
    const learning = find(learn({ outcomes: recalls(WEEKLY, () => [1, 3, 5]) }), LearningKind.TIME_TO_OUTCOME);
    expect(learning?.statement).toBe(
      "After working the overdue recall list, completed follow-ups were typically recorded within a median of 3 days (18 results across 6 completed actions).",
    );
  });
});

describe("repeated unsuccessful actions", () => {
  it("are stated as followed by no measurable change, with a confidence proposal", () => {
    const l = learn({ outcomes: recalls(WEEKLY, () => []) });
    const learning = find(l, LearningKind.NO_MEASURABLE_CHANGE);
    expect(learning?.statement).toBe(
      "Working the overdue recall list was marked done 6 times, and 6 of those were followed by no measurable change in the records within the following weeks.",
    );
    expect(find(l, LearningKind.REPEATED_IMPROVEMENT)).toBeUndefined();
    expect(l.proposals.map((p) => p.kind)).toEqual([ProposalKind.CONFIDENCE_ADJUSTMENT]);
    expect(status(l, LearningKind.TIME_TO_OUTCOME)?.status).toBe("insufficient_evidence");
  });
});

describe("ignored actions", () => {
  const recommended = snapshots("2026-08-26", DATE, () => [snapshotFinding("retention")]);
  const done = recalls(["2026-09-01"], () => [1]);

  it("are detected when a top recommendation is rarely marked done", () => {
    const l = learn({ snapshots: recommended, outcomes: done });
    const learning = find(l, LearningKind.FREQUENTLY_IGNORED);
    expect(learning?.statement).toBe(
      "Working the overdue recall list was a top recommendation on 20 of 20 recorded days, and was marked done within 2 days of 3 of them.",
    );
    expect(l.proposals.find((p) => p.learningId === learning?.id)?.kind).toBe(ProposalKind.THRESHOLD_ADJUSTMENT);
  });

  it("do not count snoozed days", () => {
    const l = learn({
      snapshots: recommended,
      outcomes: done,
      dismissals: [{ clinicId: CLINIC, category: "retention", dismissedAt: "2026-08-26T08:00:00.000Z", expiresAt: "2026-09-10T08:00:00.000Z" }],
    });
    expect(find(l, LearningKind.FREQUENTLY_IGNORED)).toBeUndefined();
    expect(status(l, LearningKind.FREQUENTLY_IGNORED)?.reason).toBe("a top recommendation on 4 recorded day(s); 7 are needed");
  });

  it("are not detected when the clinic acts on most recommendations", () => {
    const acted = recalls(["2026-08-27", "2026-08-30", "2026-09-02", "2026-09-05", "2026-09-08", "2026-09-11", "2026-09-14"], () => [1]);
    expect(find(learn({ snapshots: recommended, outcomes: acted }), LearningKind.FREQUENTLY_IGNORED)).toBeUndefined();
  });
});

describe("recurring and resolved findings", () => {
  const month = snapshots("2026-08-10", DATE, () => [snapshotFinding("retention")]);
  const concentrated = { outcome: "explained", statement: "Lost appointments are concentrated in evening appointments." } as RootCauseAnalysis;

  it("detects a problem flagged for weeks and still flagged, with its root cause", () => {
    const l = learn({
      snapshots: month,
      outcomes: recalls(["2026-08-20"], () => []),
      today: [todayFinding("retention", {}, { rootCauses: [concentrated] })],
    });
    const learning = find(l, LearningKind.RECURRING_UNRESOLVED);
    expect(learning?.statement).toBe(
      "The overdue recall list has been flagged on 36 of 36 recorded days since 2026-08-10 and is still flagged on 2026-09-14, after 1 completed action.",
    );
    expect(learning?.evidence).toContain("Where it is concentrated today: Lost appointments are concentrated in evening appointments.");
    expect(l.proposals.find((p) => p.learningId === learning?.id)?.kind).toBe(ProposalKind.WORKFLOW_IMPROVEMENT);
  });

  it("does not call a problem recurring once it is clear on the latest recorded day", () => {
    const cleared = [...month.slice(0, -3), ...snapshots("2026-09-12", DATE, () => [])];
    const l = learn({ snapshots: cleared });
    expect(find(l, LearningKind.RECURRING_UNRESOLVED)).toBeUndefined();
    expect(status(l, LearningKind.RECURRING_UNRESOLVED)?.reason).toBe("not flagged on the latest recorded day");
  });

  it("associates faster resolution with acting, from closed episodes only", () => {
    // Clear, then six episodes: acted ones last 2 days, the others 8.
    const days: FindingSnapshotFact[] = [snapshot("2026-05-01", [])];
    const actedStarts: string[] = [];
    let date = "2026-05-02";
    for (let k = 0; k < 6; k += 1) {
      const length = k % 2 === 0 ? 2 : 8;
      if (k % 2 === 0) actedStarts.push(date);
      for (let i = 0; i < length; i += 1, date = addDays(date, 1)) days.push(snapshot(date, [snapshotFinding("retention")]));
      for (let i = 0; i < 3; i += 1, date = addDays(date, 1)) days.push(snapshot(date, []));
    }
    // An episode still running at the end has no known length and is left out.
    days.push(snapshot(date, [snapshotFinding("retention")]));
    const l = learn({ snapshots: days, outcomes: recalls(actedStarts, () => []) });
    const learning = find(l, LearningKind.FASTER_RESOLUTION);
    expect(learning?.statement).toBe(
      "Episodes of the overdue recall list ended after a median of 2 days when working the overdue recall list was marked done, against 8 days when it was not (3 and 3 episodes).",
    );
  });
});

describe("opportunities never acted on", () => {
  const opp = (category: string | null) =>
    snapshots("2026-08-26", DATE, (d) => [
      snapshotFinding(category, { findingId: `finding.opportunity:opportunity.forward_capacity_match:${CLINIC}:${d}`, kind: "opportunity", polarity: "opportunity", role: "next" }),
    ]);

  it("are detected when shown repeatedly with no related action", () => {
    const learning = find(learn({ snapshots: opp("forward_schedule") }), LearningKind.OPPORTUNITY_NOT_ACTED, "forward_capacity_match");
    expect(learning?.statement).toBe(
      "The open chair time next week with patients waiting to book opportunity was shown on 20 of 20 recorded days, and no related action was marked done within 2 days of any of them.",
    );
  });

  it("are insufficient when nothing could be recorded against them", () => {
    const l = learn({ snapshots: opp(null) });
    expect(status(l, LearningKind.OPPORTUNITY_NOT_ACTED, "forward_capacity_match")?.status).toBe("insufficient_evidence");
  });
});

describe("withheld data stays withheld", () => {
  it("makes every learning insufficient when completions were withheld", () => {
    const l = learn({ outcomes: recalls(WEEKLY, () => [1, 2]), snapshots: snapshots("2026-08-10", DATE, () => [snapshotFinding("retention")]), gaps: ["action_completion"] });
    expect(l.learnings).toEqual([]);
    expect(l.assessments.every((a) => a.status === "insufficient_evidence")).toBe(true);
    expect(l.coverage.gaps).toEqual(["action_completion"]);
  });

  it("makes exposure-based learnings insufficient when snapshots were withheld, and leaves outcome-based ones", () => {
    const l = learn({ outcomes: recalls(WEEKLY, () => [1, 2]), snapshots: [], gaps: ["finding_snapshot"] });
    expect(find(l, LearningKind.REPEATED_IMPROVEMENT)).toBeDefined();
    expect(status(l, LearningKind.FREQUENTLY_IGNORED)?.reason).toBe("the recorded briefings were withheld or cut short");
    expect(status(l, LearningKind.RECURRING_UNRESOLVED)?.status).toBe("insufficient_evidence");
  });
});

describe("clinic-specific memory", () => {
  it("refuses another clinic's outcomes, snapshots, snoozes or findings", () => {
    const foreign = recalls(WEEKLY, () => [1]).map((o) => ({ ...o, constraintId: o.constraintId.replace(CLINIC, OTHER) }));
    expect(() => learn({ outcomes: foreign })).toThrow(LearningIntegrityError);
    expect(() => learn({ snapshots: [snapshot(DATE, [], OTHER)] })).toThrow(LearningIntegrityError);
    expect(() => learn({ dismissals: [{ clinicId: OTHER, category: "retention", dismissedAt: NOW_ISO, expiresAt: NOW_ISO }] })).toThrow(LearningIntegrityError);
    expect(() => learn({ today: [{ ...todayFinding("retention"), clinicId: OTHER }] })).toThrow(LearningIntegrityError);
  });

  it("gives a clinic with no history nothing, however much another clinic has learned", () => {
    const { completions, hist } = goodRecalls(WEEKLY.slice(0, 5));
    const a = learn({ outcomes: assess(completions, hist) });
    const b = deriveLearning({ clinicId: OTHER, date: DATE, timezone: "UTC", outcomes: [], snapshots: [], dismissals: [], today: null, gaps: [] });
    expect(a.learnings.length).toBeGreaterThan(0);
    expect(b.learnings).toEqual([]);
    expect(JSON.stringify(b)).not.toContain(CLINIC);
    expect(a.learnings.every((x) => x.clinicId === CLINIC && x.id.endsWith(`:${CLINIC}`))).toBe(true);
  });
});

const NOW_ISO = "2026-09-14T08:00:00.000Z";

describe("determinism, wording and inertness", () => {
  function everything() {
    const { completions, hist } = goodRecalls(WEEKLY.slice(0, 5));
    return {
      outcomes: [...assess(completions, hist)],
      snapshots: snapshots("2026-08-10", DATE, () => [snapshotFinding("retention")]),
      today: [todayFinding("retention")],
    };
  }

  it("gives identical learnings on reruns and regardless of input order", () => {
    const e = everything();
    const first = learn(e);
    expect(learn(e)).toEqual(first);
    expect(learn({ ...e, outcomes: [...e.outcomes].reverse(), snapshots: [...e.snapshots].reverse() })).toEqual(first);
  });

  it("never claims one thing produced another", () => {
    const l = learn(everything());
    const texts = [
      ...l.learnings.flatMap((x) => [x.statement, ...x.evidence, ...x.limitations]),
      ...l.proposals.map((p) => p.statement),
      ...l.assessments.map((a) => a.reason),
    ];
    expect(texts.length).toBeGreaterThan(5);
    for (const t of texts) expect(t).not.toMatch(CAUSAL);
  });

  it("modifies no threshold, rule, ranking or action configuration", () => {
    const before = JSON.stringify([DEFAULT_SIGNAL_THRESHOLDS, FINDINGS_CONFIG, DEFAULT_ROOT_CAUSE_CONFIG, DEFAULT_ATTRIBUTION_CONFIG, DEFAULT_LEARNING_CONFIG]);
    const l = learn(everything());
    expect(JSON.stringify([DEFAULT_SIGNAL_THRESHOLDS, FINDINGS_CONFIG, DEFAULT_ROOT_CAUSE_CONFIG, DEFAULT_ATTRIBUTION_CONFIG, DEFAULT_LEARNING_CONFIG])).toBe(before);
    expect(l.proposals.length).toBeGreaterThan(0);
    for (const p of l.proposals) {
      expect(p).toMatchObject({ status: "proposed", requiresHumanAcceptance: true, appliedAutomatically: false });
      expect(Object.keys(p).sort()).toEqual(["appliedAutomatically", "clinicId", "id", "kind", "learningId", "requiresHumanAcceptance", "statement", "status", "subject"]);
    }
  });

  it("names no patient", () => {
    const text = JSON.stringify(learn(everything()));
    expect(text).not.toMatch(/p_c\d_\d/);
  });
});
