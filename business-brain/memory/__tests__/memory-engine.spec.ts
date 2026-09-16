/**
 * Clinic Memory: derived from stored evidence, revalidated against the most
 * recent evidence, clinic-scoped, and rebuildable to the same digest.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_ATTRIBUTION_CONFIG } from "../../engines/outcome";
import { DEFAULT_LEARNING_CONFIG } from "../../engines/learning";
import { FINDINGS_CONFIG } from "../../engines/findings/findings-config";
import { DEFAULT_SIGNAL_THRESHOLDS } from "../../engines/signals";
import { addDays } from "../../utils";
import {
  APPOINTMENTS,
  assess,
  completion,
  confirmation,
  goodRecall,
  goodRecalls,
  history,
  noisy,
  OVERDUE,
  overdue,
  readings,
  snapshotFinding,
} from "../../engines/learning/__tests__/learning-fixtures";
import { DEFAULT_MEMORY_CONFIG } from "../memory-config";
import { memoryId, MemoryIntegrityError } from "../memory-engine";
import { build, CLINIC, DATE, days, decision, entryOf, opportunity, problem, strings, weekdayOf } from "./memory-fixtures";

const flat20 = (from = "2026-06-01", to = DATE, overrides: Record<string, number | null> = {}) =>
  readings(from, to, { [OVERDUE]: overdue(overrides) });

/** Overrides setting every date in [from, to] to `value`. */
function span(from: string, to: string, value: number | null): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (let d = from; d <= to; d = addDays(d, 1)) out[d] = value;
  return out;
}

describe("insufficient evidence", () => {
  it("remembers nothing from nothing", () => {
    const memory = build();
    expect(memory.entries).toEqual([]);
    expect(memory.coverage).toEqual({ metricDays: 0, recordedDays: 0, outcomes: 0, gaps: [] });
  });

  it("establishes no normal range until an established period and a recent period both exist", () => {
    expect(entryOf(build({ metricDays: flat20("2026-08-20") }), "normal_range", OVERDUE)).toBeUndefined();
  });

  it("forms no recurring problem from two episodes", () => {
    const snaps = days("2026-06-01", DATE, (i) => (i < 5 || (i >= 40 && i < 45) ? [problem()] : []));
    expect(build({ snapshots: snaps }).entries.filter((e) => e.type === "recurring_problem")).toEqual([]);
  });
});

describe("normal ranges and historical changes", () => {
  it("creates an active range revalidated against the most recent 28 days", () => {
    const e = entryOf(build({ metricDays: flat20() }), "normal_range", OVERDUE);
    expect(e).toMatchObject({
      id: memoryId("normal_range", OVERDUE, null, CLINIC),
      status: "active",
      statusReason: { code: "held_in_recent_evidence", detail: { shareInside: 1, recentObservations: 28 } },
      facts: { median: 20, lower: 16, upper: 24, observations: 28 },
      revalidation: { basis: "recent_28_days", window: { from: "2026-08-18", to: DATE }, holds: true },
      supersededBy: null,
    });
    expect(e?.evidence).toMatchObject({
      refs: [{ kind: "metric_history", from: "2026-07-21", to: "2026-08-17", count: 28 }],
      observationCount: 28,
      supportingPeriod: { from: "2026-07-21", to: "2026-08-17" },
      coverage: 1,
    });
    expect(e?.confidence).toBe(0.95);
  });

  it("weakens when recent readings only partly stay inside it", () => {
    const e = entryOf(build({ metricDays: flat20("2026-06-01", DATE, span("2026-09-03", DATE, 30)) }), "normal_range", OVERDUE);
    expect(e?.status).toBe("weakening");
    expect(e?.statusReason).toEqual({ code: "partially_held_in_recent_evidence", detail: { shareInside: 0.57, recentObservations: 28 } });
    expect(e?.confidence).toBe(0.75);
  });

  it("goes stale when recent readings contradict it, short of a sustained shift", () => {
    const memory = build({ metricDays: flat20("2026-06-01", DATE, span("2026-08-26", DATE, 30)) });
    expect(entryOf(memory, "normal_range", OVERDUE)?.statusReason.code).toBe("contradicted_by_recent_evidence");
    expect(entryOf(memory, "normal_range", OVERDUE)?.status).toBe("stale");
    expect(memory.entries.filter((e) => e.type === "historical_change")).toEqual([]);
  });

  it("goes stale when nothing recent can revalidate it — absence is not agreement", () => {
    const e = entryOf(build({ metricDays: flat20("2026-06-01", "2026-08-20") }), "normal_range", OVERDUE);
    expect(e).toMatchObject({ status: "stale", statusReason: { code: "not_revalidated", detail: { recentObservations: 3 } }, revalidation: { holds: null } });
  });

  it("weakens on thin recent coverage", () => {
    const sparse: Record<string, number | null> = {};
    for (let d = "2026-08-18"; d <= DATE; d = addDays(d, 1)) if (Number(d.slice(8)) % 3 !== 0) sparse[d] = null;
    const e = entryOf(build({ metricDays: flat20("2026-06-01", DATE, sparse) }), "normal_range", OVERDUE);
    expect(e?.statusReason.code).toBe("thin_recent_coverage");
    expect(e?.status).toBe("weakening");
  });

  it("records a sustained shift as a historical change, and supersedes the range before it", () => {
    const memory = build({ metricDays: readings("2026-05-01", DATE, { [OVERDUE]: (d) => (d < "2026-08-01" ? noisy(20)(d) : noisy(40)(d)) }) });
    const change = entryOf(memory, "historical_change", OVERDUE, "2026-08-01");
    expect(change).toMatchObject({
      status: "active",
      facts: { changeDate: "2026-08-01", direction: "up", beforeMedian: 20, beforeLower: 16, beforeUpper: 24, afterMedian: 40 },
    });
    const current = entryOf(memory, "normal_range", OVERDUE);
    const before = entryOf(memory, "normal_range", OVERDUE, "2026-08-01");
    expect(current).toMatchObject({ status: "active", facts: { median: 40 } });
    expect(before).toMatchObject({ status: "superseded", supersededBy: current?.id, statusReason: { code: "level_shift" }, facts: { median: 20 } });
  });
});

describe("weekday patterns", () => {
  const FROM = "2026-03-30";
  const series = (friday: (date: string) => number) => (d: string) =>
    weekdayOf(d) === 0 ? 0 : weekdayOf(d) === 5 ? friday(d) : noisy(10)(d);

  it("remembers a consistently low Friday, and never a closed Sunday", () => {
    const memory = build({ metricDays: readings(FROM, DATE, { [APPOINTMENTS]: series(() => 3) }) });
    const friday = entryOf(memory, "weekday_pattern", APPOINTMENTS, "5");
    expect(friday).toMatchObject({
      status: "active",
      facts: { weekday: 5, side: "low", weekdayMedian: 3, otherDaysMedian: 10, occurrences: 12, consistency: 1 },
      revalidation: { basis: "last_6_weekday_occurrences", holds: true },
    });
    expect(memory.entries.filter((e) => e.type === "weekday_pattern").map((e) => e.subject.qualifier)).toEqual(["5"]);
  });

  it("weakens when recent Fridays stop being low", () => {
    const memory = build({ metricDays: readings(FROM, DATE, { [APPOINTMENTS]: series((d) => (d >= "2026-08-28" ? 11 : 3)) }) });
    expect(entryOf(memory, "weekday_pattern", APPOINTMENTS, "5")).toMatchObject({
      status: "weakening",
      statusReason: { code: "partially_held_in_recent_evidence", detail: { recentShare: 0.5, recentOccurrences: 6 } },
    });
  });

  it("goes stale when the clinic's Fridays changed for a sustained period", () => {
    const memory = build({ metricDays: readings(FROM, DATE, { [APPOINTMENTS]: series((d) => (d >= "2026-06-23" ? 11 : 3)) }) });
    expect(entryOf(memory, "weekday_pattern", APPOINTMENTS, "5")).toMatchObject({
      status: "stale",
      statusReason: { code: "contradicted_by_recent_evidence" },
      evidence: { supportingPeriod: { from: "2026-03-31", to: "2026-06-22" } },
    });
  });
});

describe("recurring findings", () => {
  const FROM = "2026-05-01";

  it("remembers a problem flagged in separate episodes, with its typical resolution time", () => {
    const memory = build({ snapshots: days(FROM, DATE, (i) => (i % 20 < 5 ? [problem()] : [])) });
    expect(entryOf(memory, "recurring_problem", "retention")).toMatchObject({
      status: "active",
      facts: {
        episodes: 7,
        closedEpisodes: 6,
        recurrencesAfterResolution: 6,
        medianIntervalDays: 20,
        typicalResolutionDays: 5,
        lastEpisodeStart: "2026-08-29",
        currentlyFlagged: 0,
        windowDays: 365,
      },
      revalidation: { basis: "last_recurrence_interval" },
    });
  });

  it("weakens when it has not recurred within its own usual interval", () => {
    const e = entryOf(build({ snapshots: days(FROM, DATE, (i) => (i < 105 && i % 20 < 5 ? [problem()] : [])) }), "recurring_problem", "retention");
    expect(e).toMatchObject({ status: "weakening", statusReason: { code: "not_recurred_within_interval", detail: { daysSinceLastStart: 36, medianIntervalDays: 20 } } });
  });

  it("goes stale after two intervals without recurring", () => {
    const e = entryOf(build({ snapshots: days(FROM, DATE, (i) => (i < 85 && i % 20 < 5 ? [problem()] : [])) }), "recurring_problem", "retention");
    expect(e?.status).toBe("stale");
    expect(e?.statusReason.code).toBe("not_recurred_within_interval");
  });

  it("goes stale — not resolved — when too few days were recorded to know", () => {
    const e = entryOf(build({ snapshots: days(FROM, addDays(FROM, 110), (i) => (i < 105 && i % 20 < 5 ? [problem()] : [])) }), "recurring_problem", "retention");
    expect(e).toMatchObject({ status: "stale", statusReason: { code: "not_revalidated" } });
  });

  it("remembers a recurring opportunity the same way", () => {
    const memory = build({ snapshots: days(FROM, DATE, (i, d) => (i % 20 < 5 ? [opportunity(d)] : [])) });
    expect(entryOf(memory, "recurring_opportunity", "forward_capacity_match")).toMatchObject({ status: "active", facts: { episodes: 7 } });
  });

  it("remembers a recurring root-cause concentration, never a treatment-type one, and lets it go stale", () => {
    const withCause = (outcome: "explained" | "no_concentration") =>
      snapshotFinding("scheduling", {
        rootCauses: [
          {
            question: "attrition",
            outcome,
            associations: outcome === "explained" ? [{ dimension: "session", group: "2" }, { dimension: "treatment_type", group: "root canal" }] : [],
          },
        ],
      });
    const steady = build({ snapshots: days("2026-07-17", DATE, () => [withCause("explained")]) });
    expect(entryOf(steady, "recurring_root_cause", "attrition.session", "2")).toMatchObject({
      status: "active",
      facts: { observedDays: 60, analysedDays: 60, share: 1 },
    });
    expect(steady.entries.some((e) => e.subject.key.includes("treatment_type"))).toBe(false);

    const faded = build({ snapshots: days("2026-07-17", DATE, (i) => [withCause(i < 32 ? "explained" : "no_concentration")]) });
    expect(entryOf(faded, "recurring_root_cause", "attrition.session", "2")).toMatchObject({
      status: "stale",
      statusReason: { code: "contradicted_by_recent_evidence", detail: { recentShare: 0, recentAnalysedDays: 28 } },
    });
  });
});

describe("action memories from the Learning Engine", () => {
  const WEEKLY = ["2026-05-04", "2026-05-25", "2026-06-15", "2026-07-06", "2026-07-27"];

  it("remembers an action that repeatedly worked, only past the learning standard", () => {
    const { completions, hist } = goodRecalls(WEEKLY);
    const memory = build({ outcomes: assess(completions, hist) });
    const effective = entryOf(memory, "action_effective", "retention");
    expect(effective).toMatchObject({
      status: "active",
      facts: { level: "strong_evidence", outcomes: 5, likelyContributed: 5 },
      evidence: { refs: [{ kind: "learning", ref: `learning.repeated_improvement:retention:${CLINIC}` }], observationCount: 5 },
      revalidation: { basis: "last_5_closed_outcomes", holds: true },
    });
    expect(entryOf(memory, "action_time_to_result", "retention")?.status).toBe("active");
    // Four closed outcomes do not meet the standard, so nothing is remembered.
    const four = goodRecalls(WEEKLY.slice(0, 4));
    expect(build({ outcomes: assess(four.completions, four.hist) }).entries.filter((e) => e.type === "action_effective")).toEqual([]);
  });

  it("remembers an action repeatedly followed by no measurable change", () => {
    const completions = ["2026-04-27", "2026-05-18", "2026-06-08", "2026-06-29", "2026-07-20", "2026-08-10"].map((d, i) => completion(`n${i}`, d));
    const outcomes = assess(completions, history(completions.map((c) => confirmation(c.id, 8, [])), readings("2026-03-01", "2026-09-13", { [OVERDUE]: noisy(20), [APPOINTMENTS]: noisy(10) })));
    expect(entryOf(build({ outcomes }), "action_no_change", "retention")?.status).toBe("active");
  });

  it("supersedes a worked-before memory when the most recent outcomes show no change", () => {
    const dates = Array.from({ length: 11 }, (_, i) => addDays("2026-01-26", i * 21));
    const items = dates.map((d, i) => goodRecall(`c${i}`, d));
    const overrides = Object.assign({}, ...items.slice(0, 8).map((x) => x.overrides)) as Record<string, number>;
    const confirmations = items.map((x, i) => (i < 8 ? x.confirmation : confirmation(x.completion.id, 8, [])));
    const outcomes = assess(
      items.map((x) => x.completion),
      history(confirmations, readings("2025-12-01", "2026-09-13", { [OVERDUE]: overdue(overrides), [APPOINTMENTS]: noisy(10) })),
    );
    const memory = build({ outcomes });
    const noChange = entryOf(memory, "action_no_change", "retention");
    expect(noChange?.status).toBe("active");
    expect(entryOf(memory, "action_effective", "retention")).toMatchObject({
      status: "superseded",
      supersededBy: noChange?.id,
      statusReason: { code: "replaced_by_newer_pattern", detail: { by: "no_measurable_change" } },
    });
  });

  function withUnmeasurable(unmeasurable: string[]) {
    const { completions, hist } = goodRecalls(["2026-03-02", "2026-03-23", "2026-04-13", "2026-05-04", "2026-05-25"]);
    const extra = unmeasurable.map((d, i) => completion(`u${i}`, d, { metricKey: undefined, metricValueAtCompletion: undefined }));
    return build({ outcomes: assess([...completions, ...extra], hist) });
  }

  it("weakens an action memory the recent outcomes cannot confirm while the clinic keeps acting", () => {
    expect(entryOf(withUnmeasurable(["2026-07-27", "2026-08-17", "2026-09-07"]), "action_effective", "retention")).toMatchObject({
      status: "weakening",
      statusReason: { code: "partially_held_in_recent_evidence" },
    });
  });

  it("stales an action memory the clinic has stopped repeating, by its own cadence", () => {
    expect(entryOf(withUnmeasurable(["2026-06-15", "2026-07-06", "2026-07-27"]), "action_effective", "retention")).toMatchObject({
      status: "stale",
      statusReason: { code: "not_revalidated", detail: { daysSinceLastCompletion: 49, typicalIntervalDays: 21 } },
      revalidation: { basis: "clinic_completion_cadence" },
    });
  });

  it("remembers an ignored action, and stales it once recent recommendations are acted on", () => {
    const snaps = days("2026-04-18", DATE, () => [snapshotFinding("retention")]);
    expect(entryOf(build({ snapshots: snaps }), "action_ignored", "retention")?.status).toBe("active");

    const acted = Array.from({ length: 14 }, (_, i) => completion(`a${i}`, addDays("2026-08-18", i * 2)));
    const outcomes = assess(acted, history([], readings("2026-06-01", "2026-09-13", { [OVERDUE]: noisy(20) })));
    expect(entryOf(build({ snapshots: snaps, outcomes }), "action_ignored", "retention")).toMatchObject({
      status: "stale",
      statusReason: { code: "contradicted_by_recent_evidence" },
    });
  });
});

describe("human decisions", () => {
  const { completions, hist } = goodRecalls(["2026-05-04", "2026-05-25", "2026-06-15", "2026-07-06", "2026-07-27"]);
  const outcomes = assess(completions, hist);
  const PROPOSAL = `proposal.action_preference:learning.repeated_improvement:retention:${CLINIC}`;

  it("keeps an accepted proposal separate from the learning it rests on, and current while the evidence holds", () => {
    const memory = build({ outcomes, decisions: [decision({ target: { type: "proposal", id: PROPOSAL } })] });
    expect(memory.decisions).toEqual([
      expect.objectContaining({ target: { type: "proposal", id: PROPOSAL }, decision: "accepted", needsReview: false, history: [] }),
    ]);
    // The derived memory is unchanged by the decision.
    expect(memory.entries).toEqual(build({ outcomes }).entries);
  });

  it("flags an accepted proposal for review when the evidence no longer produces it — never withdraws it", () => {
    const memory = build({ decisions: [decision({ target: { type: "proposal", id: PROPOSAL } })] });
    expect(memory.decisions[0]).toMatchObject({ decision: "accepted", needsReview: true });
  });

  it("records a rejected proposal, and lets a later revocation lift a decision while keeping its history", () => {
    const rejected = build({ outcomes, decisions: [decision({ target: { type: "proposal", id: PROPOSAL }, decision: "rejected" })] });
    expect(rejected.decisions[0]).toMatchObject({ decision: "rejected", needsReview: false });
    const revoked = build({
      outcomes,
      decisions: [
        decision({ target: { type: "proposal", id: PROPOSAL }, decision: "rejected", decidedAt: "2026-09-01T09:00:00.000Z" }),
        decision({ target: { type: "proposal", id: PROPOSAL }, decision: "accepted", decidedAt: "2026-09-05T09:00:00.000Z" }),
      ],
    });
    expect(revoked.decisions[0]).toMatchObject({ decision: "accepted", history: [{ decision: "rejected", decidedAt: "2026-09-01T09:00:00.000Z" }] });
    const lifted = build({
      outcomes,
      decisions: [
        decision({ target: { type: "proposal", id: PROPOSAL }, decidedAt: "2026-09-01T09:00:00.000Z" }),
        decision({ target: { type: "proposal", id: PROPOSAL }, decision: "revoked", decidedAt: "2026-09-05T09:00:00.000Z" }),
      ],
    });
    expect(lifted.decisions).toEqual([]);
  });

  it("marks a memory the clinic rejected as rejected, keeping its evidence, until the rejection is revoked", () => {
    const id = memoryId("normal_range", OVERDUE, null, CLINIC);
    const rejected = build({ metricDays: flat20(), decisions: [decision({ target: { type: "memory", id }, decision: "rejected", subject: "followups.overdue" })] });
    const e = entryOf(rejected, "normal_range", OVERDUE);
    expect(e).toMatchObject({ status: "rejected", statusReason: { code: "rejected_by_clinic", detail: { previousStatus: "active" } }, facts: { median: 20 } });
    expect(e?.evidence.refs.map((r) => r.kind)).toEqual(["metric_history", "decision"]);

    const restored = build({
      metricDays: flat20(),
      decisions: [
        decision({ target: { type: "memory", id }, decision: "rejected", subject: "followups.overdue", decidedAt: "2026-09-01T09:00:00.000Z" }),
        decision({ target: { type: "memory", id }, decision: "revoked", subject: "followups.overdue", decidedAt: "2026-09-02T09:00:00.000Z" }),
      ],
    });
    expect(entryOf(restored, "normal_range", OVERDUE)?.status).toBe("active");
  });
});

describe("withheld and truncated evidence never becomes positive memory", () => {
  const recalls = goodRecalls(["2026-05-04", "2026-05-25", "2026-06-15", "2026-07-06", "2026-07-27"]);
  const full = {
    metricDays: flat20(),
    snapshots: days("2026-05-01", DATE, (i) => (i % 20 < 5 ? [problem()] : [])),
    outcomes: assess(recalls.completions, recalls.hist),
  };

  it("has every kind of memory with complete evidence", () => {
    const types = new Set(build(full).entries.map((e) => e.type));
    expect([...types]).toEqual(expect.arrayContaining(["normal_range", "recurring_problem", "action_effective"]));
  });

  for (const [gap, absent] of [
    ["metric_history", ["normal_range", "historical_change", "weekday_pattern"]],
    ["finding_snapshot", ["recurring_problem", "recurring_opportunity", "recurring_root_cause", "action_ignored"]],
    ["action_completion", ["action_effective", "action_no_change", "action_time_to_result"]],
    ["action_completion_truncated", ["action_effective", "action_no_change", "action_time_to_result"]],
  ] as const) {
    it(`derives nothing that rests on ${gap}`, () => {
      const memory = build({ ...full, gaps: [gap] });
      expect(memory.entries.filter((e) => (absent as readonly string[]).includes(e.type))).toEqual([]);
      expect(memory.coverage.gaps).toEqual([gap]);
    });
  }
});

describe("isolation, reconstruction and ordering", () => {
  it("refuses another clinic's evidence and decisions", () => {
    expect(() => build({ snapshots: days(DATE, DATE, () => []).map((s) => ({ ...s, clinicId: "clinic_b" })) })).toThrow(MemoryIntegrityError);
    expect(() => build({ decisions: [{ ...decision({ target: { type: "memory", id: "memory.normal_range:x:clinic_b" } }), clinicId: "clinic_b" }] })).toThrow(MemoryIntegrityError);
    const { completions, hist } = goodRecalls(["2026-05-04"]);
    const foreign = assess(completions, hist).map((o) => ({ ...o, constraintId: o.constraintId.replace(CLINIC, "clinic_b") }));
    expect(() => build({ outcomes: foreign })).toThrow(MemoryIntegrityError);
  });

  it("rebuilds the same memory, digest included, from the same evidence in any order", () => {
    const recalls = goodRecalls(["2026-05-04", "2026-05-25", "2026-06-15", "2026-07-06", "2026-07-27"]);
    const input = {
      metricDays: flat20("2026-03-01"),
      snapshots: days("2026-05-01", DATE, (i) => (i % 20 < 5 ? [problem()] : [])),
      outcomes: assess(recalls.completions, recalls.hist),
    };
    const first = build(input);
    const again = build(input);
    const shuffled = build({ metricDays: [...input.metricDays].reverse(), snapshots: [...input.snapshots].reverse(), outcomes: [...input.outcomes].reverse() });
    expect(again).toEqual(first);
    expect(shuffled).toEqual(first);
    expect(first.digest).toMatch(/^[0-9a-f]{8}$/);
    expect(build({ ...input, metricDays: flat20("2026-03-01", DATE, { "2026-09-01": 90 }) }).digest).not.toBe(first.digest);
  });

  it("uses no evidence dated after the build, and none older than its window", () => {
    const D1 = "2026-08-20";
    const everything = { metricDays: flat20("2026-03-01", DATE, span("2026-08-21", DATE, 90)), snapshots: days("2026-05-01", DATE, (i) => (i % 20 < 5 ? [problem()] : [])) };
    const untilD1 = { metricDays: everything.metricDays.filter((d) => d.date <= D1), snapshots: everything.snapshots.filter((s) => s.date <= D1) };
    expect(build({ ...everything, date: D1 })).toEqual(build({ ...untilD1, date: D1 }));

    const ancient = [{ date: "2025-01-01", values: { [OVERDUE]: 999 } }, ...flat20()];
    expect(build({ metricDays: ancient }).entries).toEqual(build({ metricDays: flat20() }).entries);
  });
});

describe("what memory may contain", () => {
  const recalls = goodRecalls(["2026-05-04", "2026-05-25", "2026-06-15", "2026-07-06", "2026-07-27"]);
  const memory = build({
    metricDays: readings("2026-03-30", DATE, { [OVERDUE]: noisy(20), [APPOINTMENTS]: (d) => (weekdayOf(d) === 5 ? 3 : noisy(10)(d)) }),
    snapshots: days("2026-05-01", DATE, (i, d) => (i % 20 < 5 ? [problem(), opportunity(d)] : [])),
    outcomes: assess(recalls.completions, recalls.hist),
  });

  it("holds no patient identifier and no prose — only ids, codes, dates and numbers", () => {
    expect(memory.entries.length).toBeGreaterThan(5);
    const text = JSON.stringify(memory);
    for (const c of recalls.completions) for (const p of c.targetPatientIds) expect(text).not.toContain(p);
    for (const s of strings(memory)) expect(s).toMatch(/^[A-Za-z0-9_.:-]+$/);
  });

  it("changes no threshold, rule, ranking or action configuration", () => {
    const configs = () => JSON.stringify([DEFAULT_SIGNAL_THRESHOLDS, FINDINGS_CONFIG, DEFAULT_ATTRIBUTION_CONFIG, DEFAULT_LEARNING_CONFIG, DEFAULT_MEMORY_CONFIG]);
    const before = configs();
    build({ metricDays: flat20(), decisions: [decision({ target: { type: "proposal", id: "proposal.action_preference:learning.repeated_improvement:retention:clinic_a" } })] });
    expect(configs()).toBe(before);
  });
});
