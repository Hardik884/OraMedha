/**
 * Root causes inside the Finding abstraction and the single prioritiser.
 *
 * An analysis is evidence ON a finding: it attaches to exactly the finding it
 * names, never becomes a finding of its own, and the prioritiser uses it only as
 * a stated tie-break — never as a second ranking.
 */

import { describe, expect, it } from "vitest";

import { ConstraintCategory, type Finding, type RootCauseAnalysis } from "../../../domain";
import { MetricKey } from "../../metrics/metric-ids";
import { deriveTrajectories } from "../../trajectory";
import { daily, flat } from "../../trajectory/__tests__/trajectory-fixtures";
import { deriveRootCauses, rootCauseSubjects } from "../../root-cause";
import { appt, book, weekdays } from "../../root-cause/__tests__/root-cause-fixtures";
import { FindingIntegrityError, normalizeFindings } from "../normalize";
import { prioritizeFindings } from "../prioritize";
import { CLINIC, DATE, NOW, OTHER, opportunity, problem, withProblems } from "./findings-fixtures";

const S = ConstraintCategory.SCHEDULING;

function eveningBook() {
  let evening = 0;
  return book({
    appointments: weekdays().flatMap((d, i) => [
      ...["09:00", "09:30", "10:00"].map((t, j) => appt(`m${i}_${j}`, d, t, i === 3 && j === 0 ? "cancelled" : "completed")),
      appt(`e${i}`, d, "18:00", evening++ < 12 ? "cancelled" : "completed"),
    ]),
  });
}

function analysesFor(findings: readonly Finding[], schedule = eveningBook()): readonly RootCauseAnalysis[] {
  return deriveRootCauses({
    clinicId: CLINIC,
    date: DATE,
    now: "2026-09-14T23:00:00.000Z",
    timezone: "UTC",
    subjects: rootCauseSubjects(findings),
    schedule,
    capacity: null,
  });
}

describe("root-cause subjects", () => {
  it("are the negative findings with a question, one each", () => {
    const sources = withProblems(
      [problem(S, "high"), problem(ConstraintCategory.REVENUE_LEAKAGE, "high"), problem(ConstraintCategory.CAPACITY, "medium")],
      { opportunities: [opportunity({})] },
    );
    const findings = normalizeFindings(sources);
    const subjects = rootCauseSubjects(findings);
    expect(subjects.map((s) => s.category).sort()).toEqual([ConstraintCategory.CAPACITY, S]);
    const ids = new Set(findings.map((f) => f.id));
    expect(subjects.every((s) => ids.has(s.parentFindingId))).toBe(true);
    // Revenue leakage has no reliable dimension to split by; the opportunity is not a problem.
    expect(subjects.find((s) => s.category === ConstraintCategory.REVENUE_LEAKAGE)).toBeUndefined();
  });

  it("focus a trajectory-only warning on the one rate that moved", () => {
    const weekly = (levels: number[]) => [levels[0], ...levels.flatMap((l) => flat(l, 7))];
    const t = deriveTrajectories({
      clinicId: CLINIC,
      date: DATE,
      ...daily(weekly([2, 3, 4, 6, 8]), MetricKey.SCHEDULING_NO_SHOW_RATE_30D, CLINIC, DATE),
    }).byKey.get(MetricKey.SCHEDULING_NO_SHOW_RATE_30D);
    const findings = normalizeFindings(withProblems([], { trajectories: t ? [t] : [] }));
    const subjects = rootCauseSubjects(findings);
    expect(subjects).toHaveLength(1);
    expect(subjects[0].focus).toBe("no_show");
    // A constraint about attrition is about every lost appointment.
    expect(rootCauseSubjects(normalizeFindings(withProblems([problem(S, "high")])))[0].focus).toBe("lost");
  });
});

describe("attaching analyses to findings", () => {
  const sources = withProblems([problem(S, "high"), problem(ConstraintCategory.REVENUE_LEAKAGE, "medium")]);
  const plain = normalizeFindings(sources);
  const analyses = analysesFor(plain);

  it("attach to the correct parent and to nothing else", () => {
    const attached = normalizeFindings({ ...sources, rootCauses: analyses });
    const parent = attached.find((f) => f.category === S);
    expect(parent?.evidence.rootCauses.map((r) => r.parentFindingId)).toEqual([parent?.id]);
    expect(attached.filter((f) => f.category !== S).every((f) => f.evidence.rootCauses.length === 0)).toBe(true);
  });

  it("add no finding, and leave every other field as it was", () => {
    const attached = normalizeFindings({ ...sources, rootCauses: analyses });
    expect(attached.map((f) => f.id)).toEqual(plain.map((f) => f.id));
    const strip = (fs: readonly Finding[]) => fs.map((f) => ({ ...f, evidence: { ...f.evidence, rootCauses: [] } }));
    expect(strip(attached)).toEqual(strip(plain));
  });

  it("refuse an analysis for another clinic, or for a finding this run did not produce", () => {
    expect(() => normalizeFindings({ ...sources, rootCauses: [{ ...analyses[0], clinicId: OTHER }] })).toThrow(FindingIntegrityError);
    expect(() => normalizeFindings({ ...sources, rootCauses: [{ ...analyses[0], parentFindingId: "finding.problem:ghost" }] })).toThrow(
      /did not produce/,
    );
  });
});

describe("the prioritiser and root causes", () => {
  it("carry the analysis statement in the finding's explanation, including insufficient evidence", () => {
    const sources = withProblems([problem(S, "high")]);
    const explained = prioritizeFindings({ sources: { ...sources, rootCauses: analysesFor(normalizeFindings(sources)) }, now: NOW });
    expect(explained.top?.explanation).toContain("Lost appointments are concentrated in evening appointments (17:00 onwards): 60% (12 of 20)");

    const thin = analysesFor(normalizeFindings(sources), book({ appointments: [appt("a", "2026-09-01", "09:00", "cancelled")] }));
    const insufficient = prioritizeFindings({ sources: { ...sources, rootCauses: thin }, now: NOW });
    expect(insufficient.top?.explanation).toContain("Insufficient evidence to explain where this is concentrated");
  });

  it("do not change stakes, urgency, trend, impact or confidence — only a stated tie-break", () => {
    const sources = withProblems([problem(S, "high"), problem(ConstraintCategory.REVENUE_LEAKAGE, "critical")]);
    const without = prioritizeFindings({ sources, now: NOW });
    const withCauses = prioritizeFindings({ sources: { ...sources, rootCauses: analysesFor(normalizeFindings(sources)) }, now: NOW });
    // A located high-stakes problem never outranks an unlocated critical one.
    expect(withCauses.top?.finding.id).toBe(without.top?.finding.id);
    expect(withCauses.top?.finding.category).toBe(ConstraintCategory.REVENUE_LEAKAGE);
    const scheduling = [...withCauses.next, ...withCauses.supporting].find((r) => r.finding.category === S);
    const before = [...without.next, ...without.supporting].find((r) => r.finding.category === S);
    expect(scheduling?.finding.evidence.confidence).toBe(before?.finding.evidence.confidence);
    expect({ ...scheduling?.factors, located: 0 }).toEqual(before?.factors);
  });

  it("break an otherwise exact tie in favour of the finding the ledger locates, and say so", () => {
    const sources = withProblems([problem(S, "medium"), problem(ConstraintCategory.SCHEDULE_ACCURACY, "medium")]);
    const without = prioritizeFindings({ sources, now: NOW });
    expect(without.top?.finding.category).toBe(ConstraintCategory.SCHEDULE_ACCURACY);
    expect(without.top?.comparedWithNext).toMatch(/ordered by identifier/);

    // Only the scheduling finding is analysed here, so only it can be located.
    const findings = normalizeFindings(sources).filter((f) => f.category === S);
    const ranked = prioritizeFindings({ sources: { ...sources, rootCauses: analysesFor(findings) }, now: NOW });
    expect(ranked.top?.finding.category).toBe(S);
    expect(ranked.top?.factors.located).toBe(1);
    expect(ranked.top?.comparedWithNext).toMatch(/the ledger locates where it is concentrated/);
  });

  it("do not count an insufficient or unconcentrated analysis as located", () => {
    const sources = withProblems([problem(S, "medium")]);
    const thin = analysesFor(normalizeFindings(sources), book());
    const ranked = prioritizeFindings({ sources: { ...sources, rootCauses: thin }, now: NOW });
    expect(thin[0].outcome).toBe("insufficient_evidence");
    expect(ranked.top?.factors.located).toBe(0);
  });
});
