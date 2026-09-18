/**
 * The Wins strip's copy.
 *
 * This file writes the only sentences in the product that say something good, so
 * the tests are mostly about what those sentences may not say. Three prohibitions
 * matter, and each has a specific failure behind it:
 *
 *   - **No causal claim.** Nothing in OraMedha records which actions a clinic
 *     took, so "your team's work paid off" would be an invention. The moment such
 *     a record exists the claim belongs in an attribution model with its own
 *     confidence ladder, not smuggled in here.
 *   - **No praise.** Every line states a measurement. Praise is the first thing a
 *     dentist stops reading, and it takes the numbers beside it down with it.
 *   - **No implied trend from one day.** A single day outside the range is a real
 *     reading and a weak one, and it has to read as one.
 */

import { describe, expect, it } from "vitest";

import { ClinicDimension, type Achievement } from "@/business-brain";
import { MetricKey } from "@/business-brain/engines/metrics/metric-ids";
import {
  BaselineDirection,
  BaselineQuality,
  type MetricBaseline,
} from "@/business-brain/engines/baseline";
import type { AchievementDecision } from "@/business-brain/engines/achievement";
import { buildWins, buildWinsEmptyState } from "../wins-view";

function achievement(over: Partial<Achievement> = {}): Achievement {
  return {
    id: `achievement.${MetricKey.SCHEDULING_NO_SHOW_RATE_30D}:clinic_a:2026-09-12`,
    metricKey: MetricKey.SCHEDULING_NO_SHOW_RATE_30D,
    dimension: ClinicDimension.ATTENDANCE,
    current: 6,
    baseline: 11,
    delta: -5,
    bandEdge: 8.8,
    observations: 12,
    consecutiveDays: 2,
    sustained: true,
    confidence: 0.7,
    measuredAt: "2026-09-12T09:00:00.000Z",
    ...over,
  };
}

describe("the collapsed line", () => {
  it("carries the figure, the comparison and the duration", () => {
    // Everything needed to decide whether to care, without expanding. A win a
    // dentist has to open to understand is a win they skip.
    const [win] = buildWins([achievement()]);
    expect(win.title).toBe("Fewer no-shows");
    expect(win.headline).toBe("Down to 6% from your usual 11% · 2 days running");
  });

  it("says up for a metric that improved by rising", () => {
    const [win] = buildWins([
      achievement({
        metricKey: MetricKey.REVENUE_PRODUCTION_PAID_RATE_30D,
        dimension: ClinicDimension.FINANCIAL_HEALTH,
        current: 91,
        baseline: 74,
        delta: 17,
        consecutiveDays: 5,
      }),
    ]);
    expect(win.title).toBe("More of your work paid for");
    expect(win.headline).toBe("Up to 91% from your usual 74% · 5 days running");
  });

  it("uses the unit a clinic would say aloud", () => {
    const minutes = buildWins([
      achievement({
        metricKey: MetricKey.QUEUE_AVERAGE_WAITING_TIME,
        dimension: ClinicDimension.PATIENT_FLOW,
        current: 12,
        baseline: 38,
        delta: -26,
      }),
    ])[0];
    expect(minutes.headline).toContain("12 min");
    expect(minutes.headline).toContain("38 min");

    const patients = buildWins([
      achievement({
        metricKey: MetricKey.FOLLOWUPS_OVERDUE,
        dimension: ClinicDimension.RETENTION_RECALL,
        current: 1,
        baseline: 14,
        delta: -13,
      }),
    ])[0];
    // Singular for one, plural for the rest — a small thing that reads as care.
    expect(patients.headline).toContain("1 patient ");
    expect(patients.headline).toContain("14 patients");
  });

  it("labels a single day as a first day, never as a run", () => {
    const [win] = buildWins([achievement({ consecutiveDays: 1, sustained: false })]);
    expect(win.headline).toContain("first day outside your usual range");
    expect(win.headline).not.toContain("days running");
  });
});

describe("the expanded explanation", () => {
  it("explains a sustained improvement against the clinic's own records", () => {
    const [win] = buildWins([achievement({ consecutiveDays: 3 })]);
    expect(win.explanation).toContain("3 days running");
    expect(win.explanation).toContain("your own records");
    expect(win.explanation).toContain("normal variation");
  });

  it("counts a weekday baseline in its own weekday, never in days", () => {
    // A Saturday is judged against Saturdays (see MetricSpan), so three
    // consecutive readings are three WEEKS. Calling them "3 days running" would
    // be false, and it is the sentence a dentist would check first.
    const [win] = buildWins([
      achievement({
        metricKey: MetricKey.QUEUE_AVERAGE_WAITING_TIME,
        consecutiveDays: 3,
        observations: 9,
        basis: "same_weekday",
        weekday: 6,
      }),
    ]);
    expect(win.headline).toContain("3 Saturdays running");
    expect(win.explanation).toContain("your own Saturdays");
    expect(win.evidence).toContainEqual({
      label: "Measured against",
      value: "9 Saturdays of your own records",
    });
  });

  it("says plainly that one day is not yet a trend", () => {
    const [win] = buildWins([achievement({ consecutiveDays: 1, sustained: false })]);
    expect(win.explanation).toContain("first day");
    expect(win.explanation).toContain("not yet a trend");
  });

  it("makes no causal claim, in either case", () => {
    const causal =
      /\bbecause\b|\bcaused\b|\bthanks to\b|\byour (team|work|effort)\b|\bresult of\b|\bdue to\b|\bled to\b/i;
    for (const sustained of [true, false]) {
      const [win] = buildWins([
        achievement({ sustained, consecutiveDays: sustained ? 3 : 1 }),
      ]);
      expect(win.explanation).not.toMatch(causal);
      expect(win.headline).not.toMatch(causal);
    }
  });

  it("does not congratulate", () => {
    const praise =
      /\bwell done\b|\bgreat\b|\bexcellent\b|\bcongratulat|\bbrilliant\b|\bfantastic\b|\bkeep it up\b|\bproud\b/i;
    const wins = buildWins([
      achievement(),
      achievement({
        metricKey: MetricKey.REVENUE_PRODUCTION_PAID_RATE_30D,
        current: 92,
        baseline: 70,
        delta: 22,
      }),
    ]);
    for (const win of wins) {
      expect(win.title).not.toMatch(praise);
      expect(win.headline).not.toMatch(praise);
      expect(win.explanation).not.toMatch(praise);
    }
  });

  it("gives no advice", () => {
    // A win is not a recommendation. Advice lives in the action cards, which is
    // the only place in the whole system licensed to give it.
    const advisory = /\byou should\b|\bmust\b|\btry\b|\bconsider\b|\brecommend\b/i;
    const [win] = buildWins([achievement()]);
    expect(win.explanation).not.toMatch(advisory);
  });
});

describe("the evidence list", () => {
  it("states the numbers behind the claim, in plain words", () => {
    const [win] = buildWins([achievement({ consecutiveDays: 4, observations: 21 })]);
    const byLabel = new Map(win.evidence.map((e) => [e.label, e.value]));

    expect(byLabel.get("Now")).toBe("6%");
    expect(byLabel.get("Your usual")).toBe("11%");
    expect(byLabel.get("Outside your usual range for")).toBe("4 consecutive days");
    expect(byLabel.get("Measured against")).toBe("21 days of your own records");
    expect(byLabel.get("Part of")).toBe("Attendance");
  });

  it("reads a single day correctly", () => {
    const [win] = buildWins([achievement({ consecutiveDays: 1, sustained: false })]);
    const byLabel = new Map(win.evidence.map((e) => [e.label, e.value]));
    expect(byLabel.get("Outside your usual range for")).toBe("1 day");
  });

  it("exposes no metric keys, thresholds or engine vocabulary", () => {
    // "Do not expose unnecessary technical implementation details." A dentist
    // should never see `scheduling.no_show_rate_30d`, a MAD, or a band edge.
    const technical = /_30d|mad\b|baselineQuality|median|deviation|band|threshold|signal|constraint/i;
    const [win] = buildWins([achievement()]);
    const rendered = [
      win.title,
      win.headline,
      win.explanation,
      ...win.evidence.flatMap((e) => [e.label, e.value]),
    ].join(" | ");
    expect(rendered).not.toMatch(technical);
  });
});

describe("hygiene", () => {
  it("renders nothing for no achievements", () => {
    expect(buildWins([])).toEqual([]);
  });

  it("preserves the engine's order and its cap", () => {
    // The cap is enforced upstream; this file must not reorder or add to it.
    const wins = buildWins([
      achievement({ id: "a" }),
      achievement({ id: "b", metricKey: MetricKey.FOLLOWUPS_OVERDUE, current: 2, baseline: 15 }),
    ]);
    expect(wins.map((w) => w.id)).toEqual(["a", "b"]);
  });

  it("is a pure function of what it was given", () => {
    const input = [achievement()];
    expect(buildWins(input)).toEqual(buildWins(input));
  });

  it("carries each clinic's own ids through untouched", () => {
    const a = buildWins([achievement({ id: "achievement.x:clinic_a:2026-09-12" })]);
    const b = buildWins([achievement({ id: "achievement.x:clinic_b:2026-09-12" })]);
    expect(a[0].id).toContain("clinic_a");
    expect(b[0].id).toContain("clinic_b");
  });
});

// ── The empty state, which is most days ─────────────────────────────────────

describe("when nothing qualifies", () => {
  /** A baseline shaped for a decision trace. */
  function baseline(over: Partial<MetricBaseline> = {}): MetricBaseline {
    return {
      key: MetricKey.SCHEDULING_NO_SHOW_RATE_30D,
      current: 5,
      median: 5,
      mad: 1,
      deviation: 1,
      lower: 3,
      upper: 7,
      delta: 0,
      deltaPercent: 0,
      observations: 12,
      basis: "all_days",
      weekday: null,
      sample: null,
      clamped: false,
      quality: BaselineQuality.ADEQUATE,
      position: "inside",
      consecutiveOutside: 0,
      confidence: 0.7,
      ...over,
    };
  }

  function decision(over: Partial<AchievementDecision> = {}): AchievementDecision {
    return {
      metricKey: MetricKey.SCHEDULING_NO_SHOW_RATE_30D,
      emitted: false,
      rejection: "inside_normal_range",
      reasoning: "inside the normal range",
      dimension: ClinicDimension.ATTENDANCE,
      direction: BaselineDirection.LOWER_IS_BETTER,
      minimumDelta: 2,
      baseline: baseline(),
      ...over,
    };
  }

  it("says what was checked rather than rendering nothing", () => {
    // The defect this fixes. Seven measures ran, all correctly found nothing,
    // and the page showed silence — which a reader cannot tell from a broken
    // feature.
    const empty = buildWinsEmptyState([decision()]);
    expect(empty?.headline).toContain("Nothing outside your usual range");
  });

  it("shows the closest reading and what would make it a win", () => {
    const empty = buildWinsEmptyState([decision({ baseline: baseline({ current: 3.4 }) })]);
    const [near] = empty?.nearMisses ?? [];
    expect(near?.title).toBe("Fewer no-shows");
    expect(near?.line).toContain("inside your usual");
    // Falsifiable: a dentist can check tomorrow whether it was true.
    expect(near?.whatWouldShowIt).toContain("below 3%");
  });

  it("ranks by closeness to the edge, not by size of the number", () => {
    const empty = buildWinsEmptyState([
      decision({ baseline: baseline({ current: 6.9 }) }),
      decision({
        metricKey: MetricKey.FOLLOWUPS_OVERDUE,
        baseline: baseline({
          key: MetricKey.FOLLOWUPS_OVERDUE,
          current: 3.1,
          median: 5,
          lower: 3,
          upper: 7,
        }),
      }),
    ]);
    expect(empty?.nearMisses[0]?.title).toBe("Smaller overdue recall list");
  });

  it("says plainly when a measure is already where it should be", () => {
    // Not a gap. A clinic whose best measure never appears here should be told
    // why, instead of concluding the feature ignores it.
    const empty = buildWinsEmptyState([
      decision({ rejection: "already_good", baseline: baseline({ current: 1, median: 1 }) }),
    ]);
    expect(empty?.nearMisses[0]?.line).toContain("already where it should be");
    expect(empty?.nearMisses[0]?.whatWouldShowIt).toContain("will not appear");
  });

  it("counts the days towards a normal range while it is still learning", () => {
    const empty = buildWinsEmptyState([
      decision({
        rejection: "baseline_too_thin",
        baseline: baseline({ observations: 3, quality: BaselineQuality.THIN }),
      }),
    ]);
    expect(empty?.learning).toContain("3 of the 6");
    // Nothing is claimed about a clinic whose range does not exist yet.
    expect(empty?.nearMisses).toEqual([]);
  });

  it("does not tell a clinic to wait when waiting will not help", () => {
    // Six months of faithful records and five appointments a week. "Still
    // learning" would be advice this clinic could follow for a year without it
    // becoming true; the honest answer names the denominator.
    const empty = buildWinsEmptyState([
      decision({
        rejection: "sample_too_small",
        baseline: baseline({
          observations: 90,
          quality: BaselineQuality.STRONG,
          sample: {
            key: MetricKey.SCHEDULING_APPOINTMENTS_30D,
            noun: "appointments",
            minimum: 50,
            current: 22,
            median: 20,
            sufficientToday: false,
            daysExcluded: 0,
          },
        }),
      }),
    ]);
    expect(empty?.learning).toContain("too few appointments");
    expect(empty?.learning).toContain("50");
    expect(empty?.learning).not.toContain("Still learning");
  });

  it("never dresses a metric moving the WRONG way as a near miss", () => {
    // That is a problem, and the briefing has a place for problems. Putting it in
    // the quietest block on the page would bury it.
    const empty = buildWinsEmptyState([
      decision({
        rejection: "wrong_direction",
        baseline: baseline({ current: 12, position: "above" }),
      }),
    ]);
    expect(empty?.nearMisses).toEqual([]);
  });

  it("renders nothing at all when a win did qualify", () => {
    expect(buildWinsEmptyState([decision({ emitted: true, rejection: undefined })])).toBeNull();
    expect(buildWinsEmptyState([])).toBeNull();
  });

  it("shows at most three, the same cap the wins have", () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      decision({ metricKey: `metric.${i}`, baseline: baseline({ key: `metric.${i}`, current: 5 + i * 0.1 }) }),
    );
    expect(buildWinsEmptyState(many)?.nearMisses).toHaveLength(3);
  });
});
