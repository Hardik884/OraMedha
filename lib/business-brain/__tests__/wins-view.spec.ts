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
import { buildWins } from "../wins-view";

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
    expect(win.explanation).toContain("normal day-to-day variation");
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
