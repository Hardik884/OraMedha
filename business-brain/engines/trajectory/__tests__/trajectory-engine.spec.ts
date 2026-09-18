/**
 * The Trajectory Engine over literal daily series.
 *
 * Every scenario is laid out week by week so the expected state can be checked by
 * hand. Index 0 is 35 days ago (outside the window); the window is the last 35
 * days including today; the reference range is built from window days older than
 * the last 14.
 */

import { describe, expect, it } from "vitest";

import { TrajectoryState } from "../../../domain";
import { addDays } from "../../../utils";
import { deriveTrajectories, TrajectoryIntegrityError } from "../trajectory-engine";
import { buildMetric } from "../../metrics/metric-ids";
import { CANCELLATIONS, CLINIC, combine, DATE, daily, flat, OTHER, UTILIZATION } from "./trajectory-fixtures";

function cancellations(values: (number | null)[]) {
  const t = deriveTrajectories({ clinicId: CLINIC, date: DATE, ...daily(values) }).byKey.get(CANCELLATIONS);
  if (t === undefined) throw new Error("no trajectory");
  return t;
}

/** Five weeks of constant weekly levels, plus one day before the window. */
function weekly(levels: [number, number, number, number, number], today?: number): number[] {
  const days = [levels[0], ...levels.flatMap((level) => flat(level, 7))];
  if (today !== undefined) days[days.length - 1] = today;
  return days;
}

describe("a single bad day is never a warning", () => {
  it("classifies a one-day spike on a flat series as NEW, not a warning", () => {
    const t = cancellations([...flat(6, 35), 12]);
    expect(t.state).toBe(TrajectoryState.NEW);
    expect(t.lifecycle.status).toBe("not_a_warning");
    expect(t.daysWorseThanNormal).toBe(1);
    expect(t.statement).toContain("is not yet a trend");
  });
});

describe("persistent deterioration", () => {
  // Weekly levels 5 → 6 → 7 → 9 → 11. Reference (weeks 1–3) median 6, band 4–8.
  const t = cancellations(weekly([5, 6, 7, 9, 11]));

  it("is WORSENING, with four consecutive material weekly steps", () => {
    expect(t.state).toBe(TrajectoryState.WORSENING);
    expect(t.consecutiveWorseningWeeks).toBe(4);
    expect(t.position).toBe("worse_than_normal");
    expect(t.reference).toMatchObject({ median: 6, lower: 4, upper: 8 });
    expect(t.statement).toBe(
      "The 30-day cancellation rate is above your normal range (11%; usual 4%–8%) and has worsened for 4 consecutive weeks.",
    );
  });

  it("exposes the evidence behind the statement", () => {
    expect(t.current).toBe(11);
    expect(t.deviation).toBe(5);
    expect(t.weeks.map((w) => w.value)).toEqual([5, 6, 7, 9, 11]);
    expect(t.slopePerWeek).toBeGreaterThan(0);
    expect(t.daysWorseThanNormal).toBe(14);
    expect(t.observations).toBe(35);
    expect(t.coverage).toBe(1);
    expect(t.firstDetectedDate).toBe(addDays(DATE, -13));
    expect(t.conflict).toBeNull();
    expect(t.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("is not quieted while it keeps worsening week on week", () => {
    expect(t.lifecycle.status).toBe("worsening_further");
  });
});

describe("improving, recovering and resolved", () => {
  it("is IMPROVING when still worse than normal but moving the right way for two weeks", () => {
    const t = cancellations(weekly([6, 6, 14, 12, 10]));
    expect(t.state).toBe(TrajectoryState.IMPROVING);
    expect(t.consecutiveImprovingWeeks).toBe(2);
    expect(t.statement).toContain("has been above your normal range for 3 weeks but has improved for 2 consecutive weeks");
  });

  it("is RECOVERING when back inside after a sustained episode, but only for a few days", () => {
    // 18 bad days, then the last 3 back at normal.
    const t = cancellations([...flat(6, 15), ...flat(13, 18), ...flat(6, 3)]);
    expect(t.state).toBe(TrajectoryState.RECOVERING);
    expect(t.priorDaysWorseThanNormal).toBe(18);
    expect(t.daysBackToNormal).toBe(3);
    expect(t.lifecycle.status).toBe("recovering");
  });

  it("is RESOLVED once back inside for a full week, so the episode stops alarming", () => {
    const t = cancellations([...flat(6, 15), ...flat(13, 11), ...flat(6, 10)]);
    expect(t.state).toBe(TrajectoryState.RESOLVED);
    expect(t.daysBackToNormal).toBe(10);
    expect(t.lifecycle.status).toBe("resolved");
    expect(t.statement).toContain("has been back within your normal range for 10 measured days");
  });
});

describe("flat and conflicting series", () => {
  it("is STABLE on a flat series", () => {
    const t = cancellations(flat(6, 36));
    expect(t.state).toBe(TrajectoryState.STABLE);
    expect(t.lifecycle.status).toBe("not_a_warning");
    expect(t.consecutiveWorseningWeeks).toBe(0);
  });

  it("is STABLE when weekly movement stays below the material step", () => {
    const t = cancellations(weekly([6, 6.3, 6.6, 6.9, 7.2]));
    expect(t.state).toBe(TrajectoryState.STABLE);
  });

  it("flags a worsening direction that has not left the normal range, and lowers confidence", () => {
    // Reference 4, 6, 8 → median 6, band 2–10. Weekly 4 → 6 → 8 → 9 → 10.
    const inside = cancellations(weekly([4, 6, 8, 9, 10]));
    const outside = cancellations(weekly([5, 6, 7, 9, 11]));
    expect(inside.state).toBe(TrajectoryState.WORSENING);
    expect(inside.position).toBe("within_normal");
    expect(inside.conflict).toBe("worsening_within_normal_range");
    expect(inside.confidence).toBeLessThan(outside.confidence);
    expect(inside.statement).toContain("has not yet moved beyond your normal range");
  });

  it("needs more weekly steps to call a within-range series worsening", () => {
    // A noisy but flat reference (4, 6, 8 every week → median 6, band 2–10), then
    // two material steps to 7 and 8: still inside the range, so stable.
    const noisy = Array.from({ length: 22 }, (_, i) => [4, 6, 8][i % 3]);
    const t = cancellations([...noisy, ...flat(7, 7), ...flat(8, 7)]);
    expect(t.consecutiveWorseningWeeks).toBe(2);
    expect(t.position).toBe("within_normal");
    expect(t.state).toBe(TrajectoryState.STABLE);
  });

  it("reads lower-is-worse metrics the other way round", () => {
    const t = deriveTrajectories({ clinicId: CLINIC, date: DATE, ...daily(weekly([80, 80, 80, 60, 60]), UTILIZATION) }).byKey.get(UTILIZATION);
    expect(t?.state).toBe(TrajectoryState.PERSISTENT);
    expect(t?.statement).toContain("below your normal range for 2 weeks");
  });
});

describe("insufficient history and thin samples", () => {
  it("is insufficient with only a few days of history", () => {
    const t = cancellations([...Array<null>(31).fill(null), 6, 7, 6, 7, 12]);
    expect(t.state).toBe(TrajectoryState.INSUFFICIENT_DATA);
    expect(t.insufficientReason).toContain("to define this clinic's normal range");
    expect(t.confidence).toBeGreaterThan(0);
  });

  it("is insufficient when weeks have too few measured days to have a median", () => {
    // Two measured days a week: every week is unmeasured.
    const sparse: (number | null)[] = Array.from({ length: 36 }, (_, i) => (i % 7 === 0 || i % 7 === 3 ? 6 : null));
    sparse[35] = 12;
    const t = cancellations(sparse);
    expect(t.state).toBe(TrajectoryState.INSUFFICIENT_DATA);
  });

  it("is insufficient when today was not measured", () => {
    const t = cancellations([...flat(6, 35), null]);
    expect(t.state).toBe(TrajectoryState.INSUFFICIENT_DATA);
    expect(t.insufficientReason).toBe("it was not measured today");
  });

  it("treats missing days as missing, never as zero", () => {
    // A lower-is-worse metric at a steady 80 with a missing week: zeros would read
    // as a collapse in utilization. Missing days must change nothing but coverage.
    const values: (number | null)[] = weekly([80, 80, 80, 80, 80]);
    for (let i = 22; i <= 28; i += 1) values[i] = null;
    const t = deriveTrajectories({ clinicId: CLINIC, date: DATE, ...daily(values, UTILIZATION) }).byKey.get(UTILIZATION);
    expect(t?.state).toBe(TrajectoryState.STABLE);
    expect(t?.observations).toBe(28);
    expect(t?.weeks.map((w) => w.value)).toEqual([80, 80, 80, null, 80]);
    expect(t?.confidenceBasis.join(" ")).toContain("not every week had enough measured days");
  });

  it("reports an unmeasured metric as insufficient rather than omitting it", () => {
    const result = deriveTrajectories({ clinicId: CLINIC, date: DATE, current: [], history: [] });
    expect(result.trajectories.length).toBeGreaterThan(5);
    expect(result.trajectories.every((t) => t.state === TrajectoryState.INSUFFICIENT_DATA)).toBe(true);
  });
});

describe("a rate with too little behind it", () => {
  it("has no reference range at all when the days were too small to carry the rate", () => {
    // Five appointments a week. Every reading is real; none of them can be a
    // point in a range, because one cancellation is twenty points.
    const t = deriveTrajectories({
      clinicId: CLINIC,
      date: DATE,
      ...daily(flat(6, 36), CANCELLATIONS, CLINIC, DATE, flat(5, 36)),
    }).byKey.get(CANCELLATIONS);

    expect(t?.state).toBe(TrajectoryState.INSUFFICIENT_DATA);
    // And it says WHICH thing is missing. "Wait for more days" would be advice
    // this clinic could follow for a year without it becoming true.
    expect(t?.insufficientReason).toContain("behind the rate");
    expect(t?.insufficientReason).not.toContain("measured days older than");
  });

  it("builds the range from the days that could carry it", () => {
    // Four quiet days in an otherwise ordinary five weeks. Before the rule they
    // were points in the range; now they are not evidence about the rate.
    const samples = flat(90, 36);
    for (const i of [2, 3, 4, 5]) samples[i] = 4;
    const values = flat(6, 36);
    for (const i of [2, 3, 4, 5]) values[i] = 50;

    const t = deriveTrajectories({
      clinicId: CLINIC,
      date: DATE,
      ...daily(values, CANCELLATIONS, CLINIC, DATE, samples),
    }).byKey.get(CANCELLATIONS);

    expect(t?.state).toBe(TrajectoryState.STABLE);
    expect(t?.reference?.median).toBe(6);
  });
});

describe("lifecycle", () => {
  it("marks a warning that has held without change as unchanged", () => {
    const t = cancellations([...flat(6, 15), ...flat(12, 21)]);
    expect(t.state).toBe(TrajectoryState.PERSISTENT);
    expect(t.lifecycle.status).toBe("unchanged");
    expect(t.lifecycle.unchangedDays).toBeGreaterThanOrEqual(7);
  });

  it("marks a warning that has only just become persistent as new, naming what it was before", () => {
    // Eight bad days: persistent today (≥ 7), new yesterday but one.
    const t = cancellations([...flat(6, 28), ...flat(12, 8)]);
    expect(t.state).toBe(TrajectoryState.PERSISTENT);
    expect(t.lifecycle.status).toBe("new_warning");
    expect(t.lifecycle.previousState).toBe(TrajectoryState.NEW);
    expect(t.lastChangedDate).toBe(addDays(DATE, -1));
  });
});

describe("determinism and isolation", () => {
  it("returns identical trajectories for the same history in any order", () => {
    const input = combine(daily(weekly([5, 6, 7, 9, 11])), daily(weekly([80, 80, 80, 60, 60]), UTILIZATION));
    const a = deriveTrajectories({ clinicId: CLINIC, date: DATE, ...input });
    const b = deriveTrajectories({ clinicId: CLINIC, date: DATE, current: input.current, history: [...input.history].reverse() });
    expect(a.trajectories).toEqual(b.trajectories);
  });

  it("never reads a day at or after today as history", () => {
    const input = daily(flat(6, 36));
    const future = { date: addDays(DATE, 1), metrics: [buildMetric(CANCELLATIONS, 99, CLINIC, addDays(DATE, 1), DATE)] };
    const t = deriveTrajectories({ clinicId: CLINIC, date: DATE, current: input.current, history: [...input.history, future] }).byKey.get(CANCELLATIONS);
    expect(t?.state).toBe(TrajectoryState.STABLE);
  });

  it("refuses history from another clinic", () => {
    const input = daily(flat(6, 36));
    const foreign = daily(flat(6, 36), CANCELLATIONS, OTHER);
    expect(() =>
      deriveTrajectories({ clinicId: CLINIC, date: DATE, current: input.current, history: [...input.history, foreign.history[0]] }),
    ).toThrow(TrajectoryIntegrityError);
  });
});
