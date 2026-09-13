/**
 * Temporal projection — the persistence the engine always computed, on screen.
 *
 * The Diagnosis Engine has classified every finding as transient, intermittent,
 * sustained, worsening or improving since it was built, with a consecutive-day
 * count behind it. The projection discarded all of it, so a dentist saw a flat
 * statement of today for a problem the engine knew was in its third day.
 *
 * This suite covers the projection only — the classification itself has its own
 * tests. What matters here is the translation, and one rule dominates it:
 * `insufficient_history` must produce NOTHING. A clinic three days old has no
 * history to report, and filling the chip with "New today" would turn an absence
 * of data into a claim about the clinic.
 */

import { describe, expect, it } from "vitest";

import type { Diagnosis, Persistence, PersistenceDetail } from "@/business-brain";
import { deriveConstraints } from "@/business-brain/engines/constraint";
import { diagnoseMetrics } from "@/business-brain/engines/diagnosis/__tests__/fixtures/diagnose-harness";
import {
  CLINIC_ID,
  DATE,
  DORMANT_PATIENT_BASE,
  NOW,
  PRIOR,
  run,
  shiftDate,
} from "@/business-brain/engines/diagnosis/__tests__/fixtures/run-fixtures";
import { buildBriefing, trendFor } from "../briefing-view";

/** A diagnosis reduced to the two fields the projection reads. */
function diagnosis(
  persistence: Persistence,
  detail?: Partial<PersistenceDetail>,
): Diagnosis {
  return {
    persistence,
    persistenceDetail: {
      consecutiveDays: 1,
      priorFiredDays: 0,
      unknownDays: 0,
      historyDaysSupplied: 7,
      cappedByUnknown: false,
      ...detail,
    },
  } as unknown as Diagnosis;
}

// ── The translation ──────────────────────────────────────────────────────────

describe("trendFor", () => {
  it("says nothing at all when the engine could not classify", () => {
    // The rule that matters most. A clinic with no history gets silence, never a
    // default — "New today" would be a claim about history rather than the
    // absence of it.
    expect(trendFor(diagnosis("insufficient_history"))).toBeNull();
  });

  it("says nothing when there is no diagnosis behind the card", () => {
    expect(trendFor(null)).toBeNull();
  });

  it("calls a first appearance new, without alarm", () => {
    const trend = trendFor(diagnosis("transient"));
    expect(trend?.label).toBe("New today");
    expect(trend?.tone).toBe("neutral");
  });

  it("counts the consecutive days for a sustained finding", () => {
    expect(trendFor(diagnosis("sustained", { consecutiveDays: 3 }))?.label).toBe(
      "3rd day running",
    );
    expect(trendFor(diagnosis("sustained", { consecutiveDays: 2 }))?.label).toBe(
      "2nd day running",
    );
    expect(trendFor(diagnosis("sustained", { consecutiveDays: 21 }))?.label).toBe(
      "21st day running",
    );
  });

  it("gets the awkward ordinals right", () => {
    // 11th, 12th and 13th are the ones a naive suffix rule renders as "11st".
    expect(trendFor(diagnosis("sustained", { consecutiveDays: 11 }))?.label).toBe(
      "11th day running",
    );
    expect(trendFor(diagnosis("sustained", { consecutiveDays: 12 }))?.label).toBe(
      "12th day running",
    );
    expect(trendFor(diagnosis("sustained", { consecutiveDays: 13 }))?.label).toBe(
      "13th day running",
    );
    expect(trendFor(diagnosis("sustained", { consecutiveDays: 22 }))?.label).toBe(
      "22nd day running",
    );
  });

  it("falls back to a plain word rather than claiming a 1st day running", () => {
    expect(trendFor(diagnosis("sustained", { consecutiveDays: 1 }))?.label).toBe("Ongoing");
  });

  it("flags a worsening finding, and colours it as bad news", () => {
    const trend = trendFor(diagnosis("worsening", { consecutiveDays: 4 }));
    expect(trend?.label).toBe("Worsening");
    expect(trend?.tone).toBe("worsening");
    expect(trend?.detail).toContain("4 days in a row");
  });

  it("flags an improving finding, and colours it as good news", () => {
    // Still a problem — it earns the only positive colour on a problem card
    // because the direction of travel is worth seeing without expanding.
    const trend = trendFor(diagnosis("improving"));
    expect(trend?.label).toBe("Improving");
    expect(trend?.tone).toBe("improving");
  });

  it("says when missing data, not clinic behaviour, produced the loose reading", () => {
    // Presenting a data gap as "it comes and goes" would state something about
    // the clinic that was really a statement about the measurement.
    const capped = trendFor(diagnosis("intermittent", { cappedByUnknown: true, unknownDays: 2 }));
    expect(capped?.label).toBe("On and off");
    expect(capped?.detail).toContain("could not be measured");

    const genuine = trendFor(diagnosis("intermittent", { priorFiredDays: 3 }));
    expect(genuine?.detail).not.toContain("could not be measured");
    expect(genuine?.detail).toContain("3");
  });

  it("never gives advice", () => {
    // The projection inherits the engines' discipline: it states a measurement.
    // "Worsening" is a statement that the breach grew, not a theory about why or
    // an instruction about what to do.
    const advisory = /\bshould\b|\bmust\b|\btry\b|\bconsider\b|\brecommend\b|\bneed to\b/i;
    for (const p of [
      "transient",
      "intermittent",
      "sustained",
      "worsening",
      "improving",
    ] as Persistence[]) {
      const trend = trendFor(diagnosis(p, { consecutiveDays: 3 }));
      expect(trend?.label).not.toMatch(advisory);
      expect(trend?.detail).not.toMatch(advisory);
    }
  });
});

// ── Through the real pipeline ────────────────────────────────────────────────

describe("the trend reaches the problem card", () => {
  /** Compose the projection the way the page does, with real engines. */
  function briefingFor(
    values: Parameters<typeof diagnoseMetrics>[0],
    options?: { history?: boolean },
  ) {
    const history = options?.history
      ? [-3, -2, -1].map((offset) => run(values, { date: shiftDate(DATE, offset) }))
      : undefined;
    const diagnoses = diagnoseMetrics(values, { history, previous: PRIOR }).diagnoses;
    const { constraints } = deriveConstraints(diagnoses, CLINIC_ID, DATE, NOW);
    return buildBriefing(
      { constraints, diagnoses, valueAtStake: new Map(), workflows: [] } as unknown as Parameters<
        typeof buildBriefing
      >[0],
      [],
    );
  }

  it("attaches a trend to every card once history exists", () => {
    const { problems } = briefingFor(DORMANT_PATIENT_BASE, { history: true });
    expect(problems.length).toBeGreaterThan(0);
    for (const problem of problems) {
      expect(problem.trend, `no trend on ${problem.category}`).not.toBeNull();
    }
  });

  it("reports a finding present on four consecutive days as such", () => {
    // The fixture fires the same pattern on three prior days plus today, which is
    // exactly what the engine calls sustained — and what the card should say.
    const { problems } = briefingFor(DORMANT_PATIENT_BASE, { history: true });
    const card = problems.find((p) => p.category === "reactivation");
    expect(card?.trend?.label).toMatch(/day running|Worsening|Improving/);
  });

  it("leaves every card silent when there is no history to classify from", () => {
    // A brand-new clinic. Every diagnosis is correctly `insufficient_history`, so
    // no card claims anything about duration.
    const { problems } = briefingFor(DORMANT_PATIENT_BASE);
    expect(problems.length).toBeGreaterThan(0);
    for (const problem of problems) {
      expect(problem.trend, `${problem.category} invented a trend`).toBeNull();
    }
  });

  it("stays stable across identical runs", () => {
    const a = briefingFor(DORMANT_PATIENT_BASE, { history: true });
    const b = briefingFor(DORMANT_PATIENT_BASE, { history: true });
    expect(b.problems.map((p) => p.trend)).toEqual(a.problems.map((p) => p.trend));
  });
});
