/**
 * The attribution ladder above observed_after.
 *
 * Every rung is reached only by its explicit requirements, one completion's
 * evidence is read at a fixed horizon so time cannot promote it, and a competing
 * explanation lowers confidence instead of assigning credit.
 */

import { describe, expect, it } from "vitest";

import { OutcomeAttribution, type Outcome } from "../../../domain";
import { addDays } from "../../../utils";
import {
  APPOINTMENTS,
  assess,
  CAUSAL,
  completion,
  confirmation,
  goodRecall,
  goodRecalls,
  history,
  noisy,
  OVERDUE,
  overdue,
  readings,
} from "../../learning/__tests__/learning-fixtures";

const D0 = "2026-08-10";
const CLOSED_NOW = "2026-09-14T20:00:00.000Z";

function one(outcomes: readonly Outcome[], id = "c0"): Outcome {
  const found = outcomes.find((o) => o.completionId === id);
  if (found === undefined) throw new Error(`no outcome ${id}`);
  return found;
}

const unmet = (o: Outcome) => (o.evidence?.requirements ?? []).filter((r) => r.met !== true).map((r) => r.key);
const LIKELY_KEYS = [
  "window_closed",
  "metric_measured_at_horizon",
  "baseline_established",
  "beyond_normal_variation",
  "targets_sufficient",
  "targets_confirmed",
  "concentrated_in_targets",
  "competing_explanations_checked",
  "no_competing_explanation",
  "data_complete",
  "evidence_point_in_time",
];

function scenario(over: {
  overrides?: Record<string, number | null>;
  appointments?: (date: string) => number | null;
  delays?: number[];
  resolvable?: number;
  from?: string;
  gaps?: string[];
  extra?: ReturnType<typeof completion>[];
  now?: string;
}) {
  const base = goodRecall("c0", D0);
  const days = readings(over.from ?? "2026-06-01", "2026-09-13", {
    [OVERDUE]: overdue({ ...base.overrides, ...(over.overrides ?? {}) }),
    [APPOINTMENTS]: over.appointments ?? noisy(10),
  });
  const conf = confirmation("c0", over.resolvable ?? 8, over.delays ?? [1, 2, 2, 3, 4, 5, 6]);
  return one(assess([base.completion, ...(over.extra ?? [])], history([conf], days, { gaps: over.gaps }), over.now ?? CLOSED_NOW));
}

describe("without history, nothing changes", () => {
  it("keeps the two original rungs and adds no evidence or resolution", () => {
    const [outcome] = assess([completion("c0", D0)], undefined);
    expect(outcome.attribution).toBe(OutcomeAttribution.OBSERVED_AFTER);
    expect(outcome).not.toHaveProperty("evidence");
    expect(outcome).not.toHaveProperty("resolution");
    const [none] = assess([completion("c0", D0, { metricValueAtCompletion: undefined, metricKey: undefined })], undefined);
    expect(none.attribution).toBe(OutcomeAttribution.INSUFFICIENT_EVIDENCE);
  });
});

describe("insufficient_evidence and observed_after", () => {
  it("stays insufficient for a category with nothing to read, with history or without", () => {
    const [idle] = assess(
      [completion("c0", D0, { category: "capacity", constraintId: "constraint.capacity:clinic_a:2026-08-10", metricKey: undefined, metricValueAtCompletion: undefined })],
      history([], readings("2026-06-01", "2026-09-13", { [OVERDUE]: noisy(20) })),
    );
    expect(idle.attribution).toBe(OutcomeAttribution.INSUFFICIENT_EVIDENCE);
    expect(idle.evidence?.window).toBe("not_applicable");
    expect(idle.evidence?.confidence).toBe(0.05);
  });

  it("stays observed_after while the window is open, however complete the evidence looks", () => {
    const outcome = scenario({ now: `${addDays(D0, 10)}T12:00:00.000Z` });
    expect(outcome.attribution).toBe(OutcomeAttribution.OBSERVED_AFTER);
    expect(outcome.evidence?.window).toBe("open");
    expect(unmet(outcome)).toContain("window_closed");
    // The sentence is unchanged; the open window is carried on the evidence.
    expect(outcome.reasoning).toBe(assess([goodRecall("c0", D0).completion], undefined, `${addDays(D0, 10)}T12:00:00.000Z`)[0].reasoning);
  });
});

describe("likely_contributed", () => {
  it("is reached when every requirement holds, and each is recorded", () => {
    const outcome = scenario({});
    expect(outcome.attribution).toBe(OutcomeAttribution.LIKELY_CONTRIBUTED);
    expect(outcome.evidence?.requirements.slice(0, LIKELY_KEYS.length).map((r) => [r.key, r.met])).toEqual(LIKELY_KEYS.map((k) => [k, true]));
    expect(outcome.evidence?.metric).toMatchObject({ atCompletion: 20, atHorizon: 12, horizonDate: "2026-08-24", improvement: 8, normalVariation: 4 });
    expect(outcome.evidence?.targets).toMatchObject({ resolvable: 8, confirmedWithinWindow: 7, medianDaysToResult: 3 });
    expect(outcome.evidence?.competing).toEqual([]);
    expect(outcome.evidence?.confidence).toBe(0.75);
  });

  const failures: [string, Parameters<typeof scenario>[0], string][] = [
    ["a change within normal variation", { overrides: { "2026-08-24": 17 } }, "beyond_normal_variation"],
    ["too few live targets", { resolvable: 4, delays: [1, 2, 3, 4] }, "targets_sufficient"],
    ["too few confirmations", { delays: [1, 2, 3] }, "targets_confirmed"],
    ["confirmations arriving after the horizon", { delays: [15, 16, 17, 18, 19, 20, 21] }, "targets_confirmed"],
    ["a change the targets do not account for", { overrides: { "2026-08-24": 0 }, resolvable: 8, delays: [1, 2, 3, 4, 5, 6] }, "concentrated_in_targets"],
    ["too little stored history before", { from: "2026-08-01" }, "baseline_established"],
    ["no stored reading at the horizon", { overrides: { "2026-08-24": null, "2026-08-25": null, "2026-08-26": null, "2026-08-27": null } }, "metric_measured_at_horizon"],
    ["a withheld read", { gaps: ["completion_confirmation"] }, "data_complete"],
  ];
  for (const [label, over, key] of failures) {
    it(`is not reached with ${label}`, () => {
      const outcome = scenario(over);
      expect(outcome.attribution).toBe(OutcomeAttribution.OBSERVED_AFTER);
      expect(unmet(outcome)).toContain(key);
    });
  }

  it("never uses a reading later than the horizon's tolerance", () => {
    const outcome = scenario({ overrides: { "2026-08-24": null, "2026-08-25": null, "2026-08-26": null, "2026-08-27": null, "2026-08-28": 12 } });
    expect(outcome.evidence?.metric?.atHorizon).toBeNull();
  });

  it("cannot be reached for money, whose concentration in patients cannot be read", () => {
    const base = goodRecall("c0", D0);
    const [outcome] = assess(
      [{ ...base.completion, category: "revenue_leakage", constraintId: "constraint.revenue_leakage:clinic_a:2026-08-10", metricKey: "revenue.outstanding" }],
      history(
        [base.confirmation],
        readings("2026-06-01", "2026-09-13", { "revenue.outstanding": overdue(base.overrides), [APPOINTMENTS]: noisy(10) }),
      ),
      CLOSED_NOW,
      { "revenue.outstanding": 15 },
    );
    expect(outcome.attribution).toBe(OutcomeAttribution.OBSERVED_AFTER);
    const concentration = outcome.evidence?.requirements.find((r) => r.key === "concentrated_in_targets");
    expect(concentration?.met).toBeNull();
    expect(concentration?.detail).toMatch(/money/);
  });
});

describe("competing explanations lower confidence instead of assigning credit", () => {
  it("a pre-existing trend", () => {
    // Falling from 28 to 20 over the fortnight before the action.
    const falling: Record<string, number> = {};
    for (let i = 14; i >= 8; i -= 1) falling[addDays(D0, -i)] = 28;
    const outcome = scenario({ overrides: falling });
    expect(outcome.attribution).toBe(OutcomeAttribution.OBSERVED_AFTER);
    expect(outcome.evidence?.competing.map((c) => c.kind)).toEqual(["pre_existing_trend"]);
    expect(outcome.evidence?.confidence).toBeLessThan(0.5);
  });

  it("a simultaneous, unrelated shift in clinic activity", () => {
    const outcome = scenario({ appointments: (d) => (d > D0 ? 25 : noisy(10)(d)) });
    expect(outcome.attribution).toBe(OutcomeAttribution.OBSERVED_AFTER);
    expect(outcome.evidence?.competing.map((c) => c.kind)).toEqual(["simultaneous_shift"]);
    expect(outcome.evidence?.competing[0].detail).toMatch(/Clinic activity changed at the same time/);
  });

  it("an overlapping action over the same patients", () => {
    const base = goodRecall("c0", D0);
    const twin = { ...completion("c1", addDays(D0, 3)), targetPatientIds: base.completion.targetPatientIds };
    const outcome = scenario({ extra: [twin] });
    expect(outcome.attribution).toBe(OutcomeAttribution.OBSERVED_AFTER);
    expect(outcome.evidence?.competing.map((c) => c.kind)).toEqual(["overlapping_action"]);
  });

  it("but not an unrelated action on other patients", () => {
    const outcome = scenario({ extra: [completion("c9", addDays(D0, 3))] });
    expect(outcome.attribution).toBe(OutcomeAttribution.LIKELY_CONTRIBUTED);
  });
});

describe("strong_evidence", () => {
  const dates = ["2026-05-04", "2026-05-25", "2026-06-15", "2026-07-06", "2026-07-27"];

  it("needs three earlier likely completions, consistently, across separate weeks", () => {
    const { completions, hist } = goodRecalls(dates);
    const outcomes = assess(completions, hist);
    const byId = new Map(outcomes.map((o) => [o.completionId, o.attribution]));
    expect([0, 1, 2, 3, 4].map((i) => byId.get(`c${i}`))).toEqual([
      OutcomeAttribution.LIKELY_CONTRIBUTED,
      OutcomeAttribution.LIKELY_CONTRIBUTED,
      OutcomeAttribution.LIKELY_CONTRIBUTED,
      OutcomeAttribution.STRONG_EVIDENCE,
      OutcomeAttribution.STRONG_EVIDENCE,
    ]);
    const fourth = one(outcomes, "c3");
    expect(fourth.evidence?.comparable).toEqual({ assessable: 3, likelyContributed: 3, distinctWeeks: 4 });
    expect(fourth.evidence?.confidence).toBe(0.9);
    expect(fourth.reasoning).toMatch(/repeated association at this clinic, not proof of effect/);
  });

  it("is never reached by an outcome through completions that came after it", () => {
    const { completions, hist } = goodRecalls(dates);
    expect(one(assess(completions, hist), "c0").attribution).toBe(OutcomeAttribution.LIKELY_CONTRIBUTED);
    // Reversing the input order changes nothing: order is read from the timestamps.
    expect(assess([...completions].reverse(), hist)).toEqual(assess(completions, hist));
  });

  it("is withheld when earlier comparable outcomes were inconsistent", () => {
    const items = dates.map((d, i) => goodRecall(`c${i}`, d));
    const overrides = Object.assign({}, ...items.map((i) => i.overrides)) as Record<string, number>;
    const confirmations = items.map((i, k) => (k === 1 || k === 2 ? confirmation(i.completion.id, 8, [1]) : i.confirmation));
    const hist = history(confirmations, readings("2026-03-01", "2026-09-13", { [OVERDUE]: overdue(overrides), [APPOINTMENTS]: noisy(10) }));
    const outcomes = assess(items.map((i) => i.completion), hist);
    expect(outcomes.some((o) => o.attribution === OutcomeAttribution.STRONG_EVIDENCE)).toBe(false);
    const last = one(outcomes, "c4");
    expect(last.attribution).toBe(OutcomeAttribution.LIKELY_CONTRIBUTED);
    expect(unmet(last)).toEqual(expect.arrayContaining(["repeated_across_comparable_actions", "consistent_across_comparable_actions"]));
  });
});

describe("time alone never promotes", () => {
  it("reads the same evidence the day the window closes and three months later", () => {
    const base = goodRecall("c0", D0);
    const conf = confirmation("c0", 8, [1, 2, 2, 3, 4, 5, 6, 40, 60]);
    const early = assess([base.completion], history([conf], readings("2026-06-01", "2026-08-25", { [OVERDUE]: overdue(base.overrides), [APPOINTMENTS]: noisy(10) })), "2026-08-25T12:00:00.000Z");
    const late = assess([base.completion], history([conf], readings("2026-06-01", "2026-11-20", { [OVERDUE]: overdue({ ...base.overrides, "2026-11-01": 0 }), [APPOINTMENTS]: noisy(10) })), "2026-11-20T12:00:00.000Z");
    expect(late[0].attribution).toBe(early[0].attribution);
    expect(late[0].evidence).toEqual(early[0].evidence);
  });

  it("does not promote an outcome whose evidence was insufficient at the horizon", () => {
    const outcome = scenario({ delays: [1, 2], now: "2027-03-01T00:00:00.000Z" });
    expect(outcome.attribution).toBe(OutcomeAttribution.OBSERVED_AFTER);
  });
});

describe("wording", () => {
  it("never claims one thing produced another, at any rung", () => {
    const { completions, hist } = goodRecalls(["2026-05-04", "2026-05-25", "2026-06-15", "2026-07-06", "2026-07-27"]);
    const outcomes = [...assess(completions, hist), scenario({ delays: [1] }), scenario({ appointments: () => 30 })];
    for (const o of outcomes) {
      for (const text of [o.reasoning, ...(o.evidence?.requirements.map((r) => r.detail) ?? []), ...(o.evidence?.competing.map((c) => c.detail) ?? [])]) {
        expect(text).not.toMatch(CAUSAL);
      }
    }
  });
});

describe("evidence that could not have been known then", () => {
  const base = goodRecall("c0", D0);
  const series = { [OVERDUE]: overdue(base.overrides), [APPOINTMENTS]: noisy(10) };
  const judge = (days: ReturnType<typeof readings>, conf = confirmation("c0", 8, [1, 2, 2, 3, 4, 5, 6])) =>
    one(assess([base.completion], history([conf], days), CLOSED_NOW));
  const capped = (o: Outcome, detail: RegExp) => {
    expect(o.attribution).toBe(OutcomeAttribution.OBSERVED_AFTER);
    const temporal = o.evidence?.requirements.find((r) => r.key === "evidence_point_in_time");
    expect(temporal?.met).toBe(false);
    expect(temporal?.detail).toMatch(detail);
    expect(o.evidenceQuality.pointInTime).toBe(false);
  };

  it("stops at observed-after when the baseline before the action was recomputed later", () => {
    // Same numbers; the fourteen days before the completion were worked out weeks
    // afterwards from records as they stood by then.
    const days = readings("2026-06-01", "2026-09-13", series).map((d) =>
      d.date >= addDays(D0, -28) && d.date < D0 ? { ...d, provenance: { [OVERDUE]: "recomputed_later", [APPOINTMENTS]: "recomputed_later" } } : d,
    );
    capped(judge(days), /recomputed later or are of unknown provenance, from 2026-07-13/);
  });

  it("stops when the reading at the horizon is of unknown provenance", () => {
    const days = readings("2026-06-01", "2026-09-13", series).map((d) => (d.date === "2026-08-24" ? { ...d, provenance: { [OVERDUE]: "unknown", [APPOINTMENTS]: "observed_at_time" } } : d));
    capped(judge(days), /from 2026-08-24/);
  });

  it("accepts readings reconstructed later from state as known on their own day", () => {
    const outcome = judge(readings("2026-06-01", "2026-09-13", series, "point_in_time_reconstruction"));
    expect(outcome.attribution).toBe(OutcomeAttribution.LIKELY_CONTRIBUTED);
    expect(outcome.evidenceQuality).toMatchObject({ completion: "staff_declared", completionTime: "declaration_time", pointInTime: true, results: { objectivelyObserved: 7, notObserved: 0, timing: "point_in_time" } });
  });

  it("stops when the targets' results were read from records as they stand now", () => {
    capped(judge(readings("2026-06-01", "2026-09-13", series), confirmation("c0", 8, [1, 2, 2, 3, 4, 5, 6], true, { timing: "current_state" })), /as they stand now/);
  });

  it("never counts staff-declared results toward the targets, however many there are", () => {
    const declared = judge(readings("2026-06-01", "2026-09-13", series), confirmation("c0", 8, [1, 2, 2, 3, 4, 5, 6], true, { source: "staff_declared" }));
    expect(declared.attribution).toBe(OutcomeAttribution.OBSERVED_AFTER);
    expect(declared.evidence?.targets).toMatchObject({ confirmedWithinWindow: 0, declaredWithinWindow: 7, daysToResult: [] });
    expect(unmet(declared)).toContain("targets_confirmed");
    expect(declared.evidenceQuality.results).toEqual({ objectivelyObserved: 0, notObserved: 7, timing: "point_in_time" });
  });

  it("treats a result with no stated kind or timing as neither observed nor point in time", () => {
    const bare = { completionId: "c0", targeted: 8, resolvable: 8, verifiable: true, delaysDays: [1, 2, 2, 3, 4, 5, 6] };
    const outcome = judge(readings("2026-06-01", "2026-09-13", series), bare);
    expect(outcome.attribution).toBe(OutcomeAttribution.OBSERVED_AFTER);
    expect(unmet(outcome)).toEqual(expect.arrayContaining(["targets_confirmed", "evidence_point_in_time"]));
  });

  it("builds no strong evidence on earlier outcomes that were not point in time", () => {
    const { completions, hist } = goodRecalls(["2026-05-04", "2026-05-25", "2026-06-15", "2026-07-06", "2026-07-27"]);
    const cut = "2026-07-01";
    const days = hist.metricDays.map((d) => (d.date < cut ? { ...d, provenance: Object.fromEntries(Object.keys(d.values).map((k) => [k, "recomputed_later"])) } : d));
    const outcomes = assess(completions, { ...hist, metricDays: days });
    expect(outcomes.some((o) => o.attribution === OutcomeAttribution.STRONG_EVIDENCE)).toBe(false);
  });
});
