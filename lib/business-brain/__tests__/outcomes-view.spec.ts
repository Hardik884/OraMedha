/**
 * The outcome copy, and the two claims it must keep apart.
 *
 * Every string this file produces sits next to a number a clinic will act on, so
 * the tests are mostly about what the sentences may not say:
 *
 *   - never that an action caused anything, in either direction;
 *   - never a zero where the truth is "this cannot be checked";
 *   - never a worsening framed as something that followed the work.
 *
 * The last is the asymmetry worth reading carefully. The engine records a metric
 * that moved the wrong way; this layer declines to render it. That is deliberate
 * and one-sided: the data cannot support a causal claim either way, and telling a
 * clinic their work made something worse is a much more damaging thing to get
 * wrong than staying quiet.
 */

import { describe, expect, it } from "vitest";

import {
  CompletionSource,
  OutcomeAttribution,
  OutcomeStatus,
  type Outcome,
} from "@/business-brain";
import { MetricKey } from "@/business-brain/engines/metrics/metric-ids";
import { buildOutcomeViews, outcomeContextFor, whenLabel } from "../outcomes-view";

const NOW = "2026-09-12T14:00:00.000Z";

const CAUSAL =
  /\bbecause\b|\bcaused?\b|\bresulted? in\b|\bthanks to\b|\bled to\b|\bdue to\b|\bproduced\b|\bdrove\b|\bowing to\b/i;

function outcome(over: Partial<Outcome> = {}): Outcome {
  return {
    id: "outcome.c1",
    completionId: "c1",
    category: "retention",
    constraintId: "constraint.retention:clinic_a:2026-09-12",
    status: OutcomeStatus.COMPLETED,
    source: CompletionSource.DECLARED,
    completedAt: "2026-09-12T09:00:00.000Z",
    attribution: OutcomeAttribution.OBSERVED_AFTER,
    targets: {
      completionId: "c1",
      targeted: 8,
      resolvable: 8,
      confirmed: 6,
      verifiable: true,
    },
    metric: {
      key: MetricKey.FOLLOWUPS_OVERDUE,
      before: 12,
      after: 3,
      delta: -9,
      improved: true,
    },
    reasoning: "irrelevant to the view",
    recordedAt: NOW,
    evidenceQuality: { completion: "staff_declared", completionTime: "declaration_time", results: null, pointInTime: false },
    ...over,
  };
}

// ── The history rows ─────────────────────────────────────────────────────────

describe("the history row", () => {
  it("states what was done, when, and what the records confirm", () => {
    const [view] = buildOutcomeViews([outcome()], NOW);
    expect(view.title).toBe("Worked the overdue recall list");
    expect(view.whenLabel).toBe("Today");
    expect(view.verified).toBe("6 of 8 patients contacted have since been seen to");
    expect(view.isVerified).toBe(true);
  });

  it("states the subsequent reading as a sequence", () => {
    const [view] = buildOutcomeViews([outcome()], NOW);
    expect(view.movement).toBe("Since then, the overdue recall list has gone from 12 to 3");
  });

  it("formats money as money", () => {
    const [view] = buildOutcomeViews(
      [
        outcome({
          category: "revenue_leakage",
          metric: {
            key: MetricKey.REVENUE_OUTSTANDING,
            before: 62000,
            after: 41000,
            delta: -21000,
            improved: true,
          },
        }),
      ],
      NOW,
    );
    expect(view.movement).toContain("₹62,000");
    expect(view.movement).toContain("₹41,000");
  });

  it("says nothing about targets when nothing could be checked", () => {
    // Null, not "0 of 8". The two read the same at a glance and mean opposite
    // things, and a clinic shown the zero would conclude its work achieved
    // nothing.
    const [view] = buildOutcomeViews(
      [
        outcome({
          category: "capacity",
          targets: { completionId: "c1", targeted: 0, resolvable: 0, confirmed: 0, verifiable: false },
        }),
      ],
      NOW,
    );
    expect(view.verified).toBeNull();
    expect(view.isVerified).toBe(false);
  });

  it("still reports a genuine zero when the check ran and found none", () => {
    // The other side of the same distinction: this one IS a measurement.
    const [view] = buildOutcomeViews(
      [outcome({ targets: { completionId: "c1", targeted: 8, resolvable: 8, confirmed: 0, verifiable: true } })],
      NOW,
    );
    expect(view.verified).toBe("0 of 8 patients contacted have since been seen to");
  });

  it("uses the singular for one patient", () => {
    const [view] = buildOutcomeViews(
      [outcome({ targets: { completionId: "c1", targeted: 1, resolvable: 1, confirmed: 1, verifiable: true } })],
      NOW,
    );
    expect(view.verified).toContain("1 of 1 patient contacted");
  });
});

// ── The asymmetry ────────────────────────────────────────────────────────────

describe("a worsening is never rendered", () => {
  it("drops the movement line when the metric moved the wrong way", () => {
    const [view] = buildOutcomeViews(
      [
        outcome({
          metric: { key: MetricKey.FOLLOWUPS_OVERDUE, before: 12, after: 19, delta: 7, improved: false },
        }),
      ],
      NOW,
    );
    expect(view.movement).toBeNull();
    // The completion itself is still reported — the work happened.
    expect(view.title).toBe("Worked the overdue recall list");
    expect(view.verified).not.toBeNull();
  });

  it("drops it for a flat reading too", () => {
    const [view] = buildOutcomeViews(
      [outcome({ metric: { key: MetricKey.FOLLOWUPS_OVERDUE, before: 12, after: 12, delta: 0, improved: false } })],
      NOW,
    );
    expect(view.movement).toBeNull();
  });

  it("drops it at insufficient_evidence, whatever the metric says", () => {
    const [view] = buildOutcomeViews(
      [outcome({ attribution: OutcomeAttribution.INSUFFICIENT_EVIDENCE })],
      NOW,
    );
    expect(view.movement).toBeNull();
  });
});

// ── When ─────────────────────────────────────────────────────────────────────

describe("whenLabel", () => {
  it("reads the way a clinic would say it", () => {
    expect(whenLabel("2026-09-12T09:00:00.000Z", NOW)).toBe("Today");
    expect(whenLabel("2026-09-11T09:00:00.000Z", NOW)).toBe("Yesterday");
    expect(whenLabel("2026-09-09T09:00:00.000Z", NOW)).toBe("3 days ago");
  });

  it("falls back to a date beyond a week", () => {
    expect(whenLabel("2026-08-30T09:00:00.000Z", NOW)).toMatch(/Aug/);
  });

  it("never reports a future completion as days ago", () => {
    expect(whenLabel("2026-09-13T09:00:00.000Z", NOW)).toBe("Today");
  });
});

// ── Positive-outcome integration ─────────────────────────────────────────────

describe("what happened after, on a win", () => {
  it("places the completed action beside the win, without joining them", () => {
    const line = outcomeContextFor(MetricKey.FOLLOWUPS_OVERDUE, 3, [outcome()], NOW);
    expect(line).not.toBeNull();
    expect(line).toContain("worked the overdue recall list");
    expect(line).toContain("6 have since been seen to");
    // The disclaimer is part of the sentence, not a footnote somewhere else.
    expect(line).toContain("nothing here shows a link between them");
  });

  it("stays silent when no completion tracked this win's metric", () => {
    expect(outcomeContextFor(MetricKey.REVENUE_OUTSTANDING, 3, [outcome()], NOW)).toBeNull();
  });

  it("stays silent when the completion is older than the improvement", () => {
    // An action from three weeks ago must not be placed beside a win that
    // started yesterday — the adjacency would imply a relationship the timing
    // does not support.
    const old = outcome({ completedAt: "2026-08-20T09:00:00.000Z" });
    expect(outcomeContextFor(MetricKey.FOLLOWUPS_OVERDUE, 2, [old], NOW)).toBeNull();
  });

  it("stays silent when the targets could not be confirmed", () => {
    const unverifiable = outcome({
      targets: { completionId: "c1", targeted: 8, resolvable: 0, confirmed: 0, verifiable: false },
    });
    expect(outcomeContextFor(MetricKey.FOLLOWUPS_OVERDUE, 3, [unverifiable], NOW)).toBeNull();
  });

  it("picks the most recent qualifying completion", () => {
    const older = outcome({ id: "o1", completedAt: "2026-09-10T09:00:00.000Z" });
    const newer = outcome({
      id: "o2",
      completedAt: "2026-09-12T09:00:00.000Z",
      targets: { completionId: "c2", targeted: 4, resolvable: 4, confirmed: 4, verifiable: true },
    });
    const line = outcomeContextFor(MetricKey.FOLLOWUPS_OVERDUE, 7, [older, newer], NOW);
    expect(line).toContain("4 have since been seen to");
  });
});

// ── The language rule ────────────────────────────────────────────────────────

describe("no causal claims anywhere", () => {
  it("keeps causal language out of every rendered string", () => {
    const views = buildOutcomeViews(
      [
        outcome(),
        outcome({ id: "o2", category: "revenue_leakage" }),
        outcome({ id: "o3", category: "capacity", targets: undefined, metric: undefined }),
        outcome({ id: "o4", source: CompletionSource.INFERRED }),
      ],
      NOW,
    );
    for (const view of views) {
      const rendered = [view.title, view.whenLabel, view.verified, view.movement]
        .filter(Boolean)
        .join(" | ");
      expect(rendered, view.id).not.toMatch(CAUSAL);
    }
  });

  it("keeps causal language out of the win's context line", () => {
    const line = outcomeContextFor(MetricKey.FOLLOWUPS_OVERDUE, 3, [outcome()], NOW) ?? "";
    expect(line).not.toMatch(CAUSAL);
  });

  it("gives no advice", () => {
    const advisory = /\byou should\b|\bmust\b|\btry\b|\bconsider\b|\brecommend\b/i;
    const [view] = buildOutcomeViews([outcome()], NOW);
    const line = outcomeContextFor(MetricKey.FOLLOWUPS_OVERDUE, 3, [outcome()], NOW) ?? "";
    expect(`${view.verified} ${view.movement} ${line}`).not.toMatch(advisory);
  });

  it("exposes no metric keys or engine vocabulary", () => {
    const technical = /_30d|attribution|observed_after|insufficient_evidence|constraint|verifiable/i;
    const [view] = buildOutcomeViews([outcome()], NOW);
    expect(`${view.title} ${view.verified} ${view.movement}`).not.toMatch(technical);
  });
});

// ── Hygiene ──────────────────────────────────────────────────────────────────

describe("hygiene", () => {
  it("renders nothing for no outcomes", () => {
    expect(buildOutcomeViews([], NOW)).toEqual([]);
    expect(outcomeContextFor(MetricKey.FOLLOWUPS_OVERDUE, 3, [], NOW)).toBeNull();
  });

  it("is a pure function of what it was given", () => {
    const input = [outcome()];
    expect(buildOutcomeViews(input, NOW)).toEqual(buildOutcomeViews(input, NOW));
  });

  it("carries each clinic's own ids through untouched", () => {
    const a = buildOutcomeViews([outcome({ id: "outcome.a", constraintId: "constraint.retention:clinic_a:2026-09-12" })], NOW);
    const b = buildOutcomeViews([outcome({ id: "outcome.b", constraintId: "constraint.retention:clinic_b:2026-09-12" })], NOW);
    expect(a[0].id).toBe("outcome.a");
    expect(b[0].id).toBe("outcome.b");
  });
});
