/**
 * Outcome Engine — what followed, and what may not be said about it.
 *
 * The engine's job is small and the discipline around it is the whole value, so
 * most of this suite is about refusals:
 *
 *   - an unverifiable category must never read as "nothing worked";
 *   - a completion the engine can say nothing about must still produce an
 *     outcome, or "we could not measure this" becomes indistinguishable from
 *     "this never happened";
 *   - entity facts must NOT raise the attribution rung, however compelling they
 *     look, because the rung above is not implemented;
 *   - and nothing, anywhere, may claim one thing caused another.
 */

import { describe, expect, it } from "vitest";

import {
  CompletionSource,
  OutcomeAttribution,
  OutcomeStatus,
  type ActionCompletionRecord,
  type TargetVerification,
} from "../../../domain";
import { buildMetric, MetricKey } from "../../metrics/metric-ids";
import { deriveOutcomes } from "../outcome-engine";
import { OUTCOME_SPECS, OUTCOME_SPEC_BY_CATEGORY } from "../outcome-catalog";

const CLINIC = "clinic_out";
const DATE = "2026-09-12";
const NOW = "2026-09-12T14:00:00.000Z";

function completion(over: Partial<ActionCompletionRecord> = {}): ActionCompletionRecord {
  return {
    id: "comp-1",
    category: "retention",
    constraintId: `constraint.retention:${CLINIC}:${DATE}`,
    completedAt: "2026-09-12T09:00:00.000Z",
    source: CompletionSource.DECLARED,
    targetPatientIds: ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"],
    metricKey: MetricKey.FOLLOWUPS_OVERDUE,
    metricValueAtCompletion: 12,
    ...over,
  };
}

function verification(over: Partial<TargetVerification> = {}): TargetVerification {
  return {
    completionId: "comp-1",
    targeted: 8,
    resolvable: 8,
    confirmed: 6,
    verifiable: true,
    ...over,
  };
}

function metrics(values: Partial<Record<string, number>>) {
  return Object.entries(values).map(([key, value]) =>
    buildMetric(key as MetricKey, value as number, CLINIC, DATE, `${DATE}T14:00:00.000Z`),
  );
}

function run(
  completions: readonly ActionCompletionRecord[],
  verifications: readonly TargetVerification[] = [],
  values: Partial<Record<string, number>> = {},
) {
  return deriveOutcomes({
    completions,
    verifications: new Map(verifications.map((v) => [v.completionId, v])),
    metrics: metrics(values),
    now: NOW,
  });
}

// ── observed_after ───────────────────────────────────────────────────────────

describe("observed_after", () => {
  it("states the sequence when the metric was measurable on both sides", () => {
    const { outcomes } = run([completion()], [verification()], {
      [MetricKey.FOLLOWUPS_OVERDUE]: 3,
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      id: "outcome.comp-1",
      status: OutcomeStatus.COMPLETED,
      attribution: OutcomeAttribution.OBSERVED_AFTER,
      metric: { key: MetricKey.FOLLOWUPS_OVERDUE, before: 12, after: 3, delta: -9, improved: true },
    });
  });

  it("reads the improving direction from the metric, not from the sign", () => {
    // Overdue recalls falling is an improvement; a collection RATE falling would
    // not be. The direction lives in the catalogue, and the engine must use it.
    const { outcomes } = run(
      [completion({ category: "revenue_leakage", metricKey: MetricKey.REVENUE_OUTSTANDING, metricValueAtCompletion: 40_000 })],
      [],
      { [MetricKey.REVENUE_OUTSTANDING]: 52_000 },
    );
    expect(outcomes[0]?.metric?.improved).toBe(false);
  });

  it("records a worsening honestly rather than hiding it", () => {
    // The engine states it; the VIEW is what declines to render it. Suppressing
    // it here would leave the data unable to answer a question later.
    const { outcomes } = run([completion()], [], { [MetricKey.FOLLOWUPS_OVERDUE]: 18 });
    expect(outcomes[0]?.attribution).toBe(OutcomeAttribution.OBSERVED_AFTER);
    expect(outcomes[0]?.metric).toMatchObject({ before: 12, after: 18, delta: 6, improved: false });
  });

  it("does not treat a flat reading as an improvement", () => {
    const { outcomes } = run([completion()], [], { [MetricKey.FOLLOWUPS_OVERDUE]: 12 });
    expect(outcomes[0]?.metric?.delta).toBe(0);
    expect(outcomes[0]?.metric?.improved).toBe(false);
  });
});

// ── insufficient_evidence ────────────────────────────────────────────────────

describe("insufficient_evidence", () => {
  it("is the verdict when the metric cannot be read now", () => {
    const { outcomes } = run([completion()], [verification()], {});
    expect(outcomes[0]?.attribution).toBe(OutcomeAttribution.INSUFFICIENT_EVIDENCE);
    expect(outcomes[0]?.metric).toBeUndefined();
  });

  it("is the verdict when no reading was captured at completion time", () => {
    // metric_history stores completed days, so a mid-morning value that was never
    // captured cannot be recovered. Without it there is no "from" to state.
    const { outcomes } = run(
      [completion({ metricKey: undefined, metricValueAtCompletion: undefined })],
      [verification()],
      { [MetricKey.FOLLOWUPS_OVERDUE]: 3 },
    );
    expect(outcomes[0]?.attribution).toBe(OutcomeAttribution.INSUFFICIENT_EVIDENCE);
  });

  it("is the verdict for a category with no trackable metric", () => {
    const { outcomes } = run([completion({ category: "capacity", metricKey: undefined, metricValueAtCompletion: undefined })]);
    expect(outcomes[0]?.attribution).toBe(OutcomeAttribution.INSUFFICIENT_EVIDENCE);
  });

  it("ignores a captured reading whose key does not match the category's metric", () => {
    // Guards against a stale row written before a catalogue change: comparing two
    // different metrics would produce a movement that means nothing.
    const { outcomes } = run(
      [completion({ metricKey: MetricKey.REVENUE_OUTSTANDING, metricValueAtCompletion: 999 })],
      [],
      { [MetricKey.FOLLOWUPS_OVERDUE]: 3 },
    );
    expect(outcomes[0]?.attribution).toBe(OutcomeAttribution.INSUFFICIENT_EVIDENCE);
  });

  it("still produces an outcome, never silence", () => {
    // Dropping it would make "we could not measure this" indistinguishable from
    // "this never happened".
    const { outcomes } = run([completion({ category: "capacity", metricKey: undefined, metricValueAtCompletion: undefined })]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe(OutcomeStatus.COMPLETED);
  });
});

// ── Entity-level facts, exposed but NOT promoted ─────────────────────────────

describe("entity-level verification", () => {
  it("carries the target findings through untouched", () => {
    const { outcomes } = run([completion()], [verification({ confirmed: 6, resolvable: 8 })], {
      [MetricKey.FOLLOWUPS_OVERDUE]: 3,
    });
    expect(outcomes[0]?.targets).toMatchObject({ targeted: 8, resolvable: 8, confirmed: 6, verifiable: true });
  });

  it("does NOT raise the rung, however convincing the concentration", () => {
    // The most important assertion in this file. 8 of 8 targeted patients
    // confirmed is exactly the evidence `likely_contributed` will rest on — and
    // that rung is not built, so reaching it here would be the engine asserting
    // something nobody implemented or reviewed.
    const { outcomes } = run(
      [completion()],
      [verification({ confirmed: 8, resolvable: 8 })],
      {},
    );
    expect(outcomes[0]?.attribution).toBe(OutcomeAttribution.INSUFFICIENT_EVIDENCE);
    expect(outcomes[0]?.targets?.confirmed).toBe(8);
  });

  it("never emits a rung above observed_after", () => {
    const allowed = new Set<string>([
      OutcomeAttribution.INSUFFICIENT_EVIDENCE,
      OutcomeAttribution.OBSERVED_AFTER,
    ]);
    const { outcomes } = run(
      [completion(), completion({ id: "comp-2", category: "capacity", metricKey: undefined, metricValueAtCompletion: undefined })],
      [verification({ confirmed: 8 })],
      { [MetricKey.FOLLOWUPS_OVERDUE]: 1 },
    );
    for (const outcome of outcomes) expect(allowed).toContain(outcome.attribution);
  });

  it("distinguishes unverifiable from zero confirmed", () => {
    // "0 of 8" and "this cannot be checked" read the same at a glance and mean
    // opposite things. The reasoning has to say which.
    const cannotCheck = run(
      [completion({ category: "capacity", metricKey: undefined, metricValueAtCompletion: undefined })],
      [verification({ verifiable: false, resolvable: 0, confirmed: 0 })],
    ).outcomes[0];
    const checkedNoneWorked = run([completion()], [verification({ confirmed: 0 })]).outcomes[0];

    expect(cannotCheck?.reasoning).toContain("not something the records can confirm");
    expect(checkedNoneWorked?.reasoning).toContain("0 of 8");
  });

  it("says when some targeted records are no longer available to check", () => {
    // A patient deleted since is excluded from the denominator, and the shortfall
    // is stated rather than passed off as a miss.
    const { outcomes } = run([completion()], [verification({ targeted: 8, resolvable: 6, confirmed: 5 })]);
    expect(outcomes[0]?.reasoning).toContain("5 of 6");
    expect(outcomes[0]?.reasoning).toContain("no longer available");
  });

  it("treats a completion with no verification supplied as unverified", () => {
    const { outcomes } = run([completion()], []);
    expect(outcomes[0]?.targets).toBeUndefined();
    expect(outcomes[0]?.reasoning).toContain("not something the records can confirm");
  });
});

// ── Provenance ───────────────────────────────────────────────────────────────

describe("declared vs inferred", () => {
  it("keeps the two apart in the reasoning", () => {
    const declared = run([completion({ source: CompletionSource.DECLARED })]).outcomes[0];
    const inferred = run([completion({ source: CompletionSource.INFERRED })]).outcomes[0];

    expect(declared?.source).toBe(CompletionSource.DECLARED);
    expect(declared?.reasoning).toContain("by a member of staff");
    expect(inferred?.source).toBe(CompletionSource.INFERRED);
    expect(inferred?.reasoning).toContain("rather than by a person");
  });
});

// ── The language rule ────────────────────────────────────────────────────────

describe("no causal claims", () => {
  const CAUSAL =
    /\bbecause\b|\bcaused?\b|\bresulted? in\b|\bthanks to\b|\bled to\b|\bdue to\b|\bproduced\b|\bdrove\b|\bthereby\b/i;

  it("keeps causal language out of every reasoning string", () => {
    const { outcomes } = run(
      [
        completion(),
        completion({ id: "c2", source: CompletionSource.INFERRED }),
        completion({ id: "c3", category: "capacity", metricKey: undefined, metricValueAtCompletion: undefined }),
      ],
      [verification(), verification({ completionId: "c2", verifiable: false }), verification({ completionId: "c3", confirmed: 0 })],
      { [MetricKey.FOLLOWUPS_OVERDUE]: 2 },
    );
    expect(outcomes).toHaveLength(3);
    for (const outcome of outcomes) {
      expect(outcome.reasoning, outcome.id).not.toMatch(CAUSAL);
    }
  });

  it("says plainly that a movement is a sequence", () => {
    const { outcomes } = run([completion()], [], { [MetricKey.FOLLOWUPS_OVERDUE]: 3 });
    expect(outcomes[0]?.reasoning).toContain("no link asserted between them");
  });

  it("gives no advice", () => {
    const ADVISORY = /\byou should\b|\bmust\b|\btry\b|\bconsider\b|\brecommend\b|\bneed to\b/i;
    const { outcomes } = run([completion()], [verification()], { [MetricKey.FOLLOWUPS_OVERDUE]: 3 });
    expect(outcomes[0]?.reasoning).not.toMatch(ADVISORY);
  });
});

// ── Determinism and purity ───────────────────────────────────────────────────

describe("determinism", () => {
  it("produces byte-identical output across runs", () => {
    const input = [completion(), completion({ id: "c2", completedAt: "2026-09-11T09:00:00.000Z" })];
    expect(run(input, [verification()], { [MetricKey.FOLLOWUPS_OVERDUE]: 3 })).toEqual(
      run(input, [verification()], { [MetricKey.FOLLOWUPS_OVERDUE]: 3 }),
    );
  });

  it("orders newest completion first, breaking ties on id", () => {
    const { outcomes } = run([
      completion({ id: "old", completedAt: "2026-09-01T09:00:00.000Z" }),
      completion({ id: "new", completedAt: "2026-09-12T09:00:00.000Z" }),
      completion({ id: "also-new", completedAt: "2026-09-12T09:00:00.000Z" }),
    ]);
    expect(outcomes.map((o) => o.completionId)).toEqual(["also-new", "new", "old"]);
  });

  it("stamps every outcome with the injected time, never the clock", () => {
    const { outcomes } = run([completion()]);
    expect(outcomes[0]?.recordedAt).toBe(NOW);
  });

  it("returns nothing for no completions", () => {
    expect(run([]).outcomes).toEqual([]);
  });
});

// ── Multi-clinic isolation ───────────────────────────────────────────────────

describe("multi-clinic isolation", () => {
  it("reads only the completions and metrics it was handed", () => {
    // The engine is pure and clinic-agnostic — scoping is the adapter's job — so
    // this pins the property that matters: a completion's identity travels on its
    // own id and constraint id, and two clinics cannot collide.
    const a = run([completion({ id: "a1", constraintId: "constraint.retention:clinic_a:2026-09-12" })]);
    const b = run([completion({ id: "b1", constraintId: "constraint.retention:clinic_b:2026-09-12" })]);
    expect(a.outcomes[0]?.id).toBe("outcome.a1");
    expect(b.outcomes[0]?.id).toBe("outcome.b1");
    expect(a.outcomes[0]?.constraintId).toContain("clinic_a");
    expect(b.outcomes[0]?.constraintId).toContain("clinic_b");
  });

  it("never matches a verification to the wrong completion", () => {
    // Keyed by completion id, so a verification for another completion is simply
    // absent rather than silently applied to this one.
    const { outcomes } = run([completion({ id: "mine" })], [verification({ completionId: "theirs" })]);
    expect(outcomes[0]?.targets).toBeUndefined();
  });
});

// ── The catalogue ────────────────────────────────────────────────────────────

describe("the outcome catalogue", () => {
  it("declares every category exactly once", () => {
    const categories = OUTCOME_SPECS.map((s) => s.category);
    expect(new Set(categories).size).toBe(categories.length);
  });

  it("pairs a metric key with a direction, or neither", () => {
    // A metric with no direction cannot be judged as improved, and a direction
    // with no metric has nothing to judge.
    for (const spec of OUTCOME_SPECS) {
      expect(spec.metricKey === null, spec.category).toBe(spec.direction === null);
    }
  });

  it("names only real metric keys", () => {
    const known = new Set<string>(Object.values(MetricKey));
    for (const spec of OUTCOME_SPECS) {
      if (spec.metricKey !== null) expect(known, spec.category).toContain(spec.metricKey);
    }
  });

  it("marks exactly the three categories the briefing builds a population for", () => {
    // Anything else claiming to be verifiable would need a population nothing
    // resolves, which would silently produce "0 of 0" verifications.
    const verifiable = OUTCOME_SPECS.filter((s) => s.verifies !== null).map((s) => s.category);
    expect(verifiable.sort()).toEqual(["retention", "revenue_leakage", "treatment_acceptance"]);
  });

  it("covers every constraint category the briefing can raise", () => {
    // A category missing here still produces an outcome — at insufficient
    // evidence — but the absence would be an accident rather than a decision.
    for (const category of [
      "capacity",
      "forward_schedule",
      "scheduling",
      "revenue_leakage",
      "treatment_acceptance",
      "retention",
      "reactivation",
      "patient_flow",
      "schedule_accuracy",
      "acquisition",
    ]) {
      expect(OUTCOME_SPEC_BY_CATEGORY.get(category), category).toBeDefined();
    }
  });
});
