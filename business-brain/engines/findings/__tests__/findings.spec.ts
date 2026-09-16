/**
 * Unified findings and the single prioritiser, over literal producer output.
 *
 * Grouped by the rules the tranche set: normalisation adds no logic, one order
 * with a reason for every placement, problems vs opportunities, low confidence,
 * insufficient data, duplicates and cascades, wins that never hide problems, and
 * tenant isolation.
 */

import { describe, expect, it } from "vitest";

import { ConstraintCategory, FindingKind, type Constraint } from "../../../domain";
import { FindingIntegrityError, normalizeFindings, CONSTRAINT_KIND } from "../normalize";
import { prioritizeFindings, rankFindings } from "../prioritize";
import {
  achievement,
  CLINIC,
  constraint,
  DATE,
  diagnosis,
  hoursFromNow,
  NOW,
  opportunity,
  OTHER,
  outcome,
  problem,
  sources,
  value,
  withProblems,
} from "./findings-fixtures";

const prioritize = (s: ReturnType<typeof sources>) => prioritizeFindings({ sources: s, now: NOW });
const everything = (r: ReturnType<typeof prioritize>) => [
  ...(r.top ? [r.top] : []),
  ...r.next,
  ...r.supporting,
  ...r.wins,
  ...r.noActionRequired,
];

describe("normalisation adds no detection of its own", () => {
  it("gives every constraint category a kind, by tense", () => {
    for (const category of Object.values(ConstraintCategory)) {
      expect(CONSTRAINT_KIND[category], category).toBeDefined();
    }
    expect(CONSTRAINT_KIND.forward_schedule).toBe(FindingKind.EARLY_WARNING);
    expect(CONSTRAINT_KIND.patient_flow).toBe(FindingKind.OPERATIONAL_RISK);
    expect(CONSTRAINT_KIND.revenue_leakage).toBe(FindingKind.PROBLEM);
  });

  it("copies a constraint's severity, value, timeframe, trend and persistence from its producers", () => {
    const p = problem("revenue_leakage", "high", {
      persistence: "worsening",
      consecutiveDays: 4,
      timeframe: "today",
      value: value(52_000, "currency", "owed"),
    });
    const [f] = normalizeFindings(withProblems([p]));
    expect(f.kind).toBe(FindingKind.PROBLEM);
    expect(f.evidence).toMatchObject({
      severity: "high",
      impact: { value: 52_000, unit: "currency" },
      timeframe: "today",
      trend: "worsening",
      consecutiveDays: 4,
      actionable: true,
      confidence: 0.8,
    });
  });

  it("turns only a measured improvement observed after an action into a win", () => {
    const findings = normalizeFindings(
      sources({ outcomes: [outcome("followups.overdue", true), outcome("a", false), outcome("b", true, "insufficient_evidence")] }),
    );
    expect(findings.map((f) => f.source.id)).toEqual(["outcome.followups.overdue"]);
    expect(findings[0].kind).toBe(FindingKind.WIN);
  });

  it("carries an opportunity's deadline, affected patients and open time", () => {
    const [f] = normalizeFindings(sources({ opportunities: [opportunity({ expiresAt: hoursFromNow(50), patients: 4, minutes: 372 })] }));
    expect(f.evidence.expiresAt).toBe(hoursFromNow(50));
    expect(f.evidence.scope).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ unit: "patients", value: 4 }),
        expect.objectContaining({ unit: "minutes", value: 372 }),
      ]),
    );
  });
});

describe("insufficient data lowers confidence and never zeroes it", () => {
  it("applies each named penalty and floors the result above zero", () => {
    const thin = problem("scheduling", "medium", { confidence: 0.15, persistence: "insufficient_history", cappedByUnknown: true });
    const [f] = normalizeFindings(withProblems([thin]));
    expect(f.evidence.sourceConfidence).toBe(0.15);
    expect(f.evidence.confidence).toBe(0.05);
    expect(f.evidence.dataQuality.map((n) => n.penalty)).toEqual([0.1, 0.1]);
  });

  it("keeps a thin-evidence finding on the list — lower, not gone", () => {
    const thin = problem("scheduling", "high", { confidence: 0.2, persistence: "insufficient_history" });
    const r = prioritize(withProblems([thin]));
    expect(r.top?.finding.category).toBe("scheduling");
    expect(r.top?.factors).toMatchObject({ stakes: 3, effectiveStakes: 2, confidenceBand: "low" });
    expect(r.top?.explanation).toContain("counted as medium because the evidence is thin");
  });

  it("reports opportunity types that could not be measured instead of scoring them", () => {
    const r = prioritizeFindings({
      sources: sources(),
      now: NOW,
      opportunityAssessments: [
        { type: "freed_slot_refill", outcome: "insufficient_data", reason: "The forward appointment book was not read.", detected: 0 },
        { type: "unpaid_delivered_work", outcome: "not_detected", reason: "Nobody owes anything.", detected: 0 },
      ],
    });
    expect(r.unmeasured).toEqual([{ source: "opportunity.freed_slot_refill", reason: "The forward appointment book was not read." }]);
    expect(r.top).toBeNull();
  });
});

describe("one order, and a measured reason for every place in it", () => {
  it("returns a top finding, the next three, and the rest as supporting", () => {
    const severities: Constraint["severity"][] = ["critical", "high", "high", "medium", "medium", "low"];
    const categories: ConstraintCategory[] = ["revenue_leakage", "scheduling", "retention", "capacity", "reactivation", "acquisition"];
    const r = prioritize(withProblems(categories.map((c, i) => problem(c, severities[i]))));
    expect(r.top?.finding.category).toBe("revenue_leakage");
    expect(r.next.map((x) => x.rank)).toEqual([2, 3, 4]);
    expect(r.supporting.map((x) => x.rank)).toEqual([5, 6]);
    expect(r.top?.explanation.startsWith("Ranked 1st:")).toBe(true);
    for (const x of [r.top, ...r.next, ...r.supporting]) expect(x?.explanation.length).toBeGreaterThan(20);
    expect(r.supporting.at(-1)?.comparedWithNext).toBeNull();
  });

  it("explains a first place in measured terms", () => {
    const r = prioritize(sources({ opportunities: [opportunity({ expiresAt: hoursFromNow(72), patients: 4, minutes: 372, confidence: 0.9 })] }));
    expect(r.top?.explanation).toContain("expires in 3 days");
    expect(r.top?.explanation).toContain("affects 4 patients");
    expect(r.top?.explanation).toContain("6.2 hours (unused chair time)");
    expect(r.top?.explanation).toContain("high confidence (0.90)");
  });

  it("gives the same order for the same findings in any input order", () => {
    const ps = [problem("scheduling", "medium"), problem("retention", "medium", { persistence: "worsening" }), problem("capacity", "high")];
    const a = prioritize(withProblems(ps));
    const b = prioritize(withProblems([...ps].reverse()));
    expect(a).toEqual(b);
  });

  it("never phrases a causal claim about the clinic", () => {
    const r = prioritize(withProblems([problem("scheduling", "high", { persistence: "worsening" }), problem("retention", "medium")], {
      opportunities: [opportunity({ priority: "high" })],
      achievements: [achievement("scheduling.no_show_rate_30d")],
    }));
    const text = everything(r).flatMap((x) => [x.explanation, x.comparedWithNext ?? ""]).join(" ");
    expect(text).not.toMatch(/\bcaused\b|\bdue to\b|\bled to\b|\bresult(ed)? (of|in)\b|\bthanks to\b|\bdriven by\b|\bwill (earn|increase|book)\b/i);
  });
});

describe("problems and opportunities compete on the same measured terms", () => {
  it("does not let an opportunity's deadline outrank a more serious problem", () => {
    const r = prioritize(withProblems([problem("revenue_leakage", "high")], {
      opportunities: [opportunity({ priority: "medium", expiresAt: hoursFromNow(20) })],
    }));
    expect(r.top?.finding.kind).toBe(FindingKind.PROBLEM);
    expect(r.top?.comparedWithNext).toContain("its stakes are higher (high vs medium)");
  });

  it("puts the one that expires first ahead when the stakes are equal", () => {
    const r = prioritize(withProblems([problem("retention", "medium", { timeframe: "this_week" })], {
      opportunities: [opportunity({ priority: "medium", expiresAt: hoursFromNow(72) })],
    }));
    expect(r.top?.finding.kind).toBe(FindingKind.OPPORTUNITY);
    expect(r.top?.comparedWithNext).toContain("more time-sensitive (expires in 3 days vs to act on this week)");
  });

  it("puts a worsening problem ahead of an equally serious, equally urgent opportunity", () => {
    const r = prioritize(withProblems([problem("retention", "medium", { timeframe: "this_week", persistence: "worsening" })], {
      opportunities: [opportunity({ priority: "medium", expiresAt: hoursFromNow(140) })],
    }));
    expect(r.top?.finding.kind).toBe(FindingKind.PROBLEM);
    expect(r.top?.comparedWithNext).toContain("worsening while the other is not worsening");
  });
});

describe("low confidence cannot dominate", () => {
  it("ranks a well-evidenced high finding above a thinly evidenced critical one", () => {
    const r = prioritize(withProblems([
      problem("revenue_leakage", "critical", { confidence: 0.2 }),
      problem("scheduling", "high", { confidence: 0.9 }),
    ]));
    expect(r.top?.finding.category).toBe("scheduling");
    expect(r.top?.comparedWithNext).toContain("its evidence is more complete");
  });

  it("still ranks a thinly evidenced critical finding above a well-evidenced medium one", () => {
    const r = prioritize(withProblems([
      problem("revenue_leakage", "critical", { confidence: 0.2 }),
      problem("scheduling", "medium", { confidence: 0.95 }),
    ]));
    expect(r.top?.finding.category).toBe("revenue_leakage");
  });
});

describe("wins never hide problems, and some findings need nothing", () => {
  it("keeps every positive finding out of the ranked order", () => {
    const r = prioritize(withProblems([problem("acquisition", "low", { persistence: "worsening" })], {
      achievements: ["a", "b", "c"].map((k) => achievement(k, { confidence: 0.99 })),
    }));
    expect(r.top?.finding.category).toBe("acquisition");
    expect(r.wins).toHaveLength(3);
    expect([r.top, ...r.next, ...r.supporting].some((x) => x?.finding.polarity === "positive")).toBe(false);
  });

  it("has no top finding when only good news exists", () => {
    const r = prioritize(sources({ achievements: [achievement("a")] }));
    expect(r.top).toBeNull();
    expect(r.wins).toHaveLength(1);
  });

  it("files a low, already-improving problem and an expired opportunity under no action, each saying why", () => {
    const r = prioritize(withProblems([problem("acquisition", "low", { persistence: "improving" })], {
      opportunities: [opportunity({ expiresAt: hoursFromNow(-2) })],
    }));
    expect(r.top).toBeNull();
    const reasons = r.noActionRequired.map((x) => x.explanation);
    expect(reasons.some((e) => e.includes("the stakes are low and it is already improving"))).toBe(true);
    expect(reasons.some((e) => e.includes("its window to act has already passed"))).toBe(true);
  });
});

describe("one event produces one finding", () => {
  const forward = () => problem("forward_schedule", "medium");

  it("collapses an opportunity into the constraint it measures", () => {
    const f = forward();
    const r = prioritize(withProblems([f], { opportunities: [opportunity({ constraintId: f.constraint.id, priority: "medium" })] }));
    const ranked = [r.top, ...r.next].filter(Boolean);
    expect(ranked).toHaveLength(1);
    expect(r.supporting).toHaveLength(1);
    expect(r.supporting[0].supports).toBe(ranked[0]?.finding.id);
    expect(r.supporting[0].explanation).toContain("Supports “");
  });

  it("collapses a freed slot into the capacity match it overlaps", () => {
    const week = opportunity({ id: "opportunity.forward_capacity_match:clinic_a:2026-09-14", overlapsWith: ["opportunity.freed_slot_refill:clinic_a:2026-09-14:a1"] });
    const slot = opportunity({ id: "opportunity.freed_slot_refill:clinic_a:2026-09-14:a1", type: "freed_slot_refill", overlapsWith: [week.id], expiresAt: hoursFromNow(10), priority: "high" });
    const r = prioritize(sources({ opportunities: [week, slot] }));
    expect(r.next).toHaveLength(0);
    // The slot leads: equally real, higher stakes and it expires first.
    expect(r.top?.finding.source.id).toBe(slot.id);
    expect(r.supporting[0].collapseReason).toBe("it draws on the same open chair time");
  });

  it("does not cascade: two different constraints stay two findings even when their opportunities overlap", () => {
    const lost = problem("scheduling", "medium");
    const ahead = forward();
    const slot = opportunity({ id: "opportunity.freed_slot_refill:clinic_a:2026-09-14:a1", type: "freed_slot_refill", constraintId: lost.constraint.id, overlapsWith: ["opportunity.forward_capacity_match:clinic_a:2026-09-14"] });
    const week = opportunity({ id: "opportunity.forward_capacity_match:clinic_a:2026-09-14", constraintId: ahead.constraint.id, overlapsWith: [slot.id] });
    const r = prioritize(withProblems([lost, ahead], { opportunities: [slot, week] }));
    expect([r.top, ...r.next].filter(Boolean)).toHaveLength(2);
    expect(r.supporting).toHaveLength(2);
  });

  it("joins idle chair time and unbooked treatment only when the Diagnosis Engine settled them as one story", () => {
    const capacity = problem("capacity", "medium");
    const acceptance = problem("treatment_acceptance", "medium");
    const settled = diagnosis("demand_supply_mismatch", {
      id: "diagnosis.dsm",
      pattern: "demand_supply_mismatch",
      hypotheses: [{ id: "diagnosis.dsm#h.unconverted_demand", status: "supported" }],
    });
    const joined = prioritize(withProblems([capacity, acceptance], { diagnoses: [settled] }));
    expect([joined.top, ...joined.next].filter(Boolean)).toHaveLength(1);

    const open = diagnosis("demand_supply_mismatch", {
      id: "diagnosis.dsm",
      pattern: "demand_supply_mismatch",
      hypotheses: [{ id: "diagnosis.dsm#h.unconverted_demand", status: "undetermined" }],
    });
    const separate = prioritize(withProblems([capacity, acceptance], { diagnoses: [open] }));
    expect([separate.top, ...separate.next].filter(Boolean)).toHaveLength(2);
  });

  it("joins an achievement and an observed outcome about the same metric into one win", () => {
    const r = prioritize(sources({ achievements: [achievement("followups.overdue")], outcomes: [outcome("followups.overdue", true)] }));
    expect(r.wins).toHaveLength(2);
    expect(r.wins.filter((w) => w.supports === null)).toHaveLength(1);
  });

  it("accounts for every finding exactly once", () => {
    const f = forward();
    const s = withProblems([f, problem("revenue_leakage", "high")], {
      opportunities: [opportunity({ constraintId: f.constraint.id })],
      achievements: [achievement("x")],
    });
    const ids = everything(prioritize(s)).map((x) => x.finding.id);
    expect(ids).toHaveLength(normalizeFindings(s).length);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("multi-clinic isolation", () => {
  it("refuses a constraint from another clinic", () => {
    expect(() => normalizeFindings(sources({ constraints: [{ ...constraint("scheduling", "high"), id: `constraint.scheduling:${OTHER}:${DATE}` }] }))).toThrow(FindingIntegrityError);
  });

  it("refuses an opportunity or achievement from another clinic", () => {
    expect(() => normalizeFindings(sources({ opportunities: [opportunity({ clinicId: OTHER })] }))).toThrow(FindingIntegrityError);
    expect(() => normalizeFindings(sources({ achievements: [achievement("a", { id: `achievement.a:${OTHER}:${DATE}` })] }))).toThrow(FindingIntegrityError);
  });

  it("refuses to rank a finding from another clinic", () => {
    const [foreign] = normalizeFindings(sources({ clinicId: OTHER, opportunities: [opportunity({ clinicId: OTHER })] }));
    expect(() => rankFindings([foreign], { sources: sources(), now: NOW })).toThrow(FindingIntegrityError);
  });

  it("ranks two clinics' identical findings independently and identically", () => {
    const a = prioritize(withProblems([problem("scheduling", "high")]));
    const b = prioritizeFindings({ sources: { ...sources({ clinicId: OTHER }), opportunities: [opportunity({ clinicId: OTHER })] }, now: NOW });
    expect(a.clinicId).toBe(CLINIC);
    expect(b.clinicId).toBe(OTHER);
    expect(everything(b).every((x) => x.finding.clinicId === OTHER)).toBe(true);
  });
});
