/**
 * Trajectories inside the Finding abstraction and the single prioritiser.
 *
 * No parallel warning system: a trajectory either enriches the constraint that
 * already represents its issue, or — only when none does — becomes one early
 * warning for its category. These specs pin that, and how the lifecycle keeps an
 * unchanged warning from being raised on every run.
 */

import { describe, expect, it } from "vitest";

import { FindingKind, TrajectoryState, type MetricTrajectory } from "../../../domain";
import { MetricKey } from "../../metrics/metric-ids";
import { deriveTrajectories } from "../../trajectory";
import { daily, flat } from "../../trajectory/__tests__/trajectory-fixtures";
import { FindingIntegrityError, normalizeFindings } from "../normalize";
import { prioritizeFindings } from "../prioritize";
import { CLINIC, DATE, NOW, OTHER, opportunity, problem, sources, withProblems } from "./findings-fixtures";

function trajectory(values: number[], key: MetricKey = MetricKey.SCHEDULING_CANCELLATION_RATE_30D): MetricTrajectory {
  const t = deriveTrajectories({ clinicId: CLINIC, date: DATE, ...daily(values, key, CLINIC, DATE) }).byKey.get(key);
  if (t === undefined) throw new Error("no trajectory");
  return t;
}

const weekly = (levels: number[]) => [levels[0], ...levels.flatMap((l) => flat(l, 7))];

const worsening = () => trajectory(weekly([5, 6, 7, 9, 11]));
const noShowsWorsening = () => trajectory(weekly([5, 6, 7, 9, 11]), MetricKey.SCHEDULING_NO_SHOW_RATE_30D);
const resolved = () => trajectory([...flat(6, 15), ...flat(13, 11), ...flat(6, 10)]);
const recovering = () => trajectory([...flat(6, 15), ...flat(13, 18), ...flat(6, 3)]);
const persistentUnchanged = () => trajectory([...flat(6, 15), ...flat(12, 21)]);
const spike = () => trajectory([...flat(6, 35), 12]);

const prioritize = (s: ReturnType<typeof sources>) => prioritizeFindings({ sources: s, now: NOW });
const everything = (r: ReturnType<typeof prioritize>) => [
  ...(r.top ? [r.top] : []),
  ...r.next,
  ...r.supporting,
  ...r.wins,
  ...r.noActionRequired,
];

describe("no duplicate findings for one underlying issue", () => {
  it("attaches a trajectory to the constraint that already represents it, instead of adding a warning", () => {
    const attrition = problem("scheduling", "medium", { persistence: "sustained" });
    const findings = normalizeFindings(withProblems([attrition], { trajectories: [worsening()] }));
    expect(findings).toHaveLength(1);
    expect(findings[0].source.producer).toBe("constraint");
    expect(findings[0].evidence.trajectories.map((t) => t.metricKey)).toEqual([MetricKey.SCHEDULING_CANCELLATION_RATE_30D]);
    // A confident weekly trajectory supplies the direction the day-level classification could not.
    expect(findings[0].evidence.trend).toBe("worsening");
  });

  it("says the trajectory's sentence in the constraint's explanation", () => {
    const r = prioritize(withProblems([problem("scheduling", "medium")], { trajectories: [worsening()] }));
    expect(r.top?.explanation).toContain("has worsened for 4 consecutive weeks");
  });

  it("makes cancellation and no-show trajectories one early warning when no constraint fired", () => {
    const findings = normalizeFindings(sources({ trajectories: [worsening(), noShowsWorsening()] }));
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe(FindingKind.EARLY_WARNING);
    expect(findings[0].source.producer).toBe("trajectory");
    expect(findings[0].evidence.trajectories).toHaveLength(2);
    expect(findings[0].evidence.severity).toBe("medium");
  });

  it("surfaces nothing for a single spike, a stable metric or an unmeasurable one", () => {
    const stable = trajectory(flat(6, 36));
    const insufficient = trajectory([...Array<number>(30).fill(Number.NaN), 6, 6, 6, 6, 6, 6]);
    expect(spike().state).toBe(TrajectoryState.NEW);
    expect(normalizeFindings(sources({ trajectories: [spike(), stable, insufficient] }))).toEqual([]);
  });

  it("collapses a next-week warning into the opportunity about the same chair time", () => {
    const thinWeek = trajectory(weekly([80, 70, 60, 50, 40]), MetricKey.CAPACITY_BOOKED_NEXT_7D);
    expect(thinWeek.state).toBe(TrajectoryState.WORSENING);
    const match = { ...opportunity({ priority: "medium" }), relatedCategories: ["forward_schedule", "capacity"] } as ReturnType<typeof opportunity>;
    const r = prioritize(sources({ trajectories: [thinWeek], opportunities: [match] }));
    expect([r.top, ...r.next].filter(Boolean)).toHaveLength(1);
    expect(r.supporting[0].collapseReason).toBe("it is the same resource, seen as a trend over time");
  });
});

describe("recovery stops a problem from staying alarming", () => {
  it("files a resolved trajectory under no action, with the days it has been back", () => {
    const r = prioritize(sources({ trajectories: [resolved()] }));
    expect(r.top).toBeNull();
    expect(r.noActionRequired[0].explanation).toContain("it has been back within its normal range for 10 measured days");
  });

  it("watches a recovering trajectory rather than ranking it", () => {
    const r = prioritize(sources({ trajectories: [recovering()] }));
    expect(r.top).toBeNull();
    expect(r.noActionRequired[0].explanation).toContain("still recovering");
  });

  it("does not dismiss a constraint whose threshold still fires just because its metric is recovering", () => {
    const r = prioritize(withProblems([problem("scheduling", "high")], { trajectories: [recovering()] }));
    expect(r.top?.finding.source.producer).toBe("constraint");
    expect(r.top?.finding.evidence.trend).toBe("improving");
  });
});

describe("low confidence cannot dominate", () => {
  it("ranks a well-evidenced problem above a thinly evidenced worsening trend", () => {
    const thin = { ...worsening(), category: null, metricKey: MetricKey.SCHEDULING_BOOKING_LEAD_TIME_DAYS, confidence: 0.3 };
    const r = prioritize(withProblems([problem("retention", "medium", { confidence: 0.9 })], { trajectories: [thin] }));
    expect(r.top?.finding.category).toBe("retention");
    const warning = everything(r).find((x) => x.finding.source.producer === "trajectory");
    expect(warning?.factors).toMatchObject({ stakes: 2, effectiveStakes: 1, confidenceBand: "low" });
  });

  it("does not let a thin trajectory override a constraint's own trend", () => {
    const thin = { ...worsening(), confidence: 0.3 };
    const [f] = normalizeFindings(withProblems([problem("scheduling", "medium", { persistence: "improving" })], { trajectories: [thin] }));
    expect(f.evidence.trend).toBe("improving");
    expect(f.evidence.trajectories).toHaveLength(1);
  });

  it("treats a worsening direction still inside the normal range as low stakes", () => {
    const inside = trajectory(weekly([4, 6, 8, 9, 10]));
    expect(inside.conflict).toBe("worsening_within_normal_range");
    const [f] = normalizeFindings(sources({ trajectories: [inside] }));
    expect(f.evidence.severity).toBe("low");
  });
});

describe("the same unchanged warning is not raised on every run", () => {
  it("keeps an unchanged persistent warning out of the ranked places, but visible", () => {
    const t = persistentUnchanged();
    expect(t.lifecycle.status).toBe("unchanged");
    const r = prioritize(sources({ trajectories: [t] }));
    expect(r.top).toBeNull();
    expect(r.supporting[0].explanation).toMatch(/^Unchanged since \d{4}-\d{2}-\d{2}, so not raised again until it changes/);
  });

  it("ranks a warning that is new or still worsening", () => {
    const fresh = trajectory([...flat(6, 28), ...flat(12, 8)]);
    expect(fresh.lifecycle.status).toBe("new_warning");
    expect(prioritize(sources({ trajectories: [fresh] })).top).not.toBeNull();
    expect(worsening().lifecycle.status).toBe("worsening_further");
    expect(prioritize(sources({ trajectories: [worsening()] })).top?.finding.kind).toBe(FindingKind.EARLY_WARNING);
  });
});

describe("statements, determinism and isolation", () => {
  it("never states a cause", () => {
    const text = [worsening(), resolved(), recovering(), persistentUnchanged(), spike()].map((t) => t.statement).join(" ");
    expect(text).not.toMatch(/\bbecause\b|\bcaused\b|\bdue to\b|\bled to\b|\bresult(ed)? (of|in)\b|\bwill\b|\bforecast\b|\bexpected to\b/i);
  });

  it("ranks the same trajectories the same way every time", () => {
    const s = withProblems([problem("retention", "medium")], { trajectories: [worsening(), noShowsWorsening(), resolved()] });
    expect(prioritize(s)).toEqual(prioritize(s));
  });

  it("refuses a trajectory from another clinic", () => {
    expect(() => normalizeFindings(sources({ trajectories: [{ ...worsening(), clinicId: OTHER }] }))).toThrow(FindingIntegrityError);
  });
});
