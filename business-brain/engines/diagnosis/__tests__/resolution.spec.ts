/**
 * Specs for entity-level discriminator resolution.
 *
 * The matchers can say "these two explanations both fit, and THIS measurement
 * would separate them". This layer takes the measurement. What must hold:
 *
 *   - a measurement that was never taken settles nothing, and `null` (cannot
 *     answer) must never behave like `[]` (asked, found nothing)
 *   - a sample too small to separate anything still SAYS so, rather than going
 *     quiet or guessing
 *   - a matcher's own verdict is never overturned by row-level detail
 *   - and none of the new text may advise, which no-advice.spec.ts also enforces
 *     across the corpus
 */

import { describe, expect, it } from "vitest";

import type { Diagnosis, Hypothesis } from "../../../domain";
import { applyEntityResolution, portMethodsFor } from "../resolution/resolve";
import { DEFAULT_ENTITY_RESOLUTION, type EntityContext } from "../resolution/types";
import type { CancellationEvent } from "../ports/diagnosis-context-port";

const DX = "diagnosis.schedule_attrition:c:2026-04-07";
const NOW = "2026-04-07T06:30:00.000Z";

function hypothesis(slug: string, over: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id: `${DX}#h.${slug}`,
    statement: `Statement for ${slug}.`,
    status: "undetermined",
    confidence: 0.4,
    supporting: [],
    contradicting: [],
    requiredData: ["something"],
    ...over,
  };
}

function diagnosis(
  discriminatorSlugs: string[],
  separates: string[],
  hypotheses: Hypothesis[],
): Diagnosis {
  return {
    id: DX,
    pattern: "schedule_attrition",
    title: "Appointments booked and then lost",
    summary: "Cancellations and no-shows above their thresholds.",
    category: "scheduling",
    severity: "medium",
    confidence: 0.5,
    persistence: "transient",
    signalIds: [],
    metricIds: [],
    hypotheses,
    discriminators: discriminatorSlugs.map((slug) => ({
      id: `${DX}#d.${slug}`,
      description: `Would separate: ${separates.join(", ")}.`,
      wouldSeparate: separates.map((s) => `${DX}#h.${s}`),
      availability: "requires_entity_data" as const,
    })),
    relatedEntities: [],
    evidence: [],
    generatedAt: NOW,
  };
}

/** A cancellation with the given notice, on the given hour. */
function cancellation(over: Partial<CancellationEvent> = {}): CancellationEvent {
  const event = {
    appointmentId: `a-${Math.random()}`,
    date: "2026-04-02",
    scheduledStart: "2026-04-02T09:00:00.000Z",
    cancelledAt: "2026-03-31T09:00:00.000Z", // 48h notice
    noticeHours: 48,
    outcome: "cancelled" as const,
    treatmentType: "Cleaning",
    slotRefilled: false,
    ...over,
  };
  // A UTC clinic: the local hour is the instant's own hour.
  return { localHour: `${event.scheduledStart.slice(11, 13)}:00`, ...event };
}

const ADVANCE = "cancellation_dominant";
const OTHER = "no_show_dominant";

function subject(hypotheses = [hypothesis(ADVANCE), hypothesis(OTHER)]): Diagnosis {
  return diagnosis(["cancellation_timing"], [ADVANCE, OTHER], hypotheses);
}

function statusOf(result: readonly Diagnosis[], slug: string): string {
  return result[0].hypotheses.find((h) => h.id.endsWith(`#h.${slug}`))?.status ?? "missing";
}

describe("absence", () => {
  it("changes nothing when no context was fetched", () => {
    const before = subject();
    const after = applyEntityResolution([before], {}, NOW);
    expect(after[0]).toEqual(before);
  });

  it("changes nothing when the deployment CANNOT answer", () => {
    // null is not an empty result. "We do not record this" must never settle a
    // hypothesis, in either direction.
    const before = subject();
    const after = applyEntityResolution([before], { cancellationEvents: null }, NOW);
    expect(after[0]).toEqual(before);
  });

  it("changes nothing when there was genuinely nothing to measure", () => {
    // Distinct from null in meaning, but equally unable to separate anything:
    // zero cancellations cannot tell you what KIND of cancellations they were.
    const after = applyEntityResolution([subject()], { cancellationEvents: [] }, NOW);
    expect(statusOf(after, ADVANCE)).toBe("undetermined");
  });

  it("leaves a diagnosis untouched when no resolver matches its discriminators", () => {
    const before = diagnosis(["reminder_delivery_log"], [ADVANCE, OTHER], [hypothesis(ADVANCE)]);
    const after = applyEntityResolution([before], { cancellationEvents: [cancellation()] }, NOW);
    expect(after[0]).toEqual(before);
  });
});

describe("small samples", () => {
  const few = Array.from({ length: DEFAULT_ENTITY_RESOLUTION.minimumSample - 1 }, () =>
    cancellation(),
  );

  it("reports what it saw but settles nothing", () => {
    const after = applyEntityResolution([subject()], { cancellationEvents: few }, NOW);
    expect(statusOf(after, ADVANCE)).toBe("undetermined");
    expect(after[0].evidence.length).toBeGreaterThan(0);
  });

  it("says WHY it concluded nothing, rather than going quiet", () => {
    const after = applyEntityResolution([subject()], { cancellationEvents: few }, NOW);
    expect(after[0].evidence[0].description).toContain("below the configured minimum");
  });
});

describe("settling a hypothesis", () => {
  const ample = Array.from({ length: 8 }, () => cancellation());

  it("supports the advance-cancellation explanation when notice was ample", () => {
    const after = applyEntityResolution([subject()], { cancellationEvents: ample }, NOW);
    expect(statusOf(after, ADVANCE)).toBe("supported");
  });

  it("contradicts it when the notice was consistently too short to refill", () => {
    const lastMinute = Array.from({ length: 8 }, () =>
      cancellation({ noticeHours: 1, cancelledAt: "2026-04-02T08:00:00.000Z" }),
    );
    const after = applyEntityResolution([subject()], { cancellationEvents: lastMinute }, NOW);
    expect(statusOf(after, ADVANCE)).toBe("contradicted");
    expect(after[0].hypotheses.find((h) => h.id.endsWith(ADVANCE))?.contradicting.length)
      .toBeGreaterThan(0);
  });

  it("clears requiredData once a hypothesis is settled", () => {
    // The domain type requires this: a hypothesis the engine settled needs
    // nothing further.
    const after = applyEntityResolution([subject()], { cancellationEvents: ample }, NOW);
    const settled = after[0].hypotheses.find((h) => h.id.endsWith(ADVANCE));
    expect(settled?.status).toBe("supported");
    expect(settled?.requiredData).toEqual([]);
  });

  it("marks a resolved discriminator available, since the data arrived", () => {
    const after = applyEntityResolution([subject()], { cancellationEvents: ample }, NOW);
    expect(after[0].discriminators[0].availability).toBe("available");
  });

  it("leaves an unresolved discriminator still waiting", () => {
    const after = applyEntityResolution([subject()], { cancellationEvents: null }, NOW);
    expect(after[0].discriminators[0].availability).toBe("requires_entity_data");
  });

  it("NEVER overturns a verdict the matcher already reached", () => {
    // The matcher read the day's own metrics. Row-level detail adds texture; it
    // does not get to reverse a conclusion already drawn from the aggregates.
    const settled = subject([
      hypothesis(ADVANCE, { status: "contradicted", requiredData: [] }),
      hypothesis(OTHER),
    ]);
    const after = applyEntityResolution([settled], { cancellationEvents: [] }, NOW);
    expect(statusOf(after, ADVANCE)).toBe("contradicted");
  });
});

describe("conflicting resolvers", () => {
  it("lets contradiction win over support, rather than whichever ran last", () => {
    // slot_refill_outcome contradicts both hypotheses when capacity was
    // recovered; cancellation_timing would support the advance one. Evidence
    // AGAINST an explanation is the stronger claim, and order must not decide.
    const dx = diagnosis(
      ["cancellation_timing", "slot_refill_outcome"],
      [ADVANCE, OTHER],
      [hypothesis(ADVANCE), hypothesis(OTHER)],
    );
    const refilled = Array.from({ length: 8 }, () => cancellation({ slotRefilled: true }));
    const after = applyEntityResolution([dx], { cancellationEvents: refilled }, NOW);
    expect(statusOf(after, ADVANCE)).toBe("contradicted");
  });

  it("produces the same result whichever order the discriminators appear in", () => {
    const forward = diagnosis(
      ["cancellation_timing", "slot_refill_outcome"],
      [ADVANCE, OTHER],
      [hypothesis(ADVANCE), hypothesis(OTHER)],
    );
    const reverse = diagnosis(
      ["slot_refill_outcome", "cancellation_timing"],
      [ADVANCE, OTHER],
      [hypothesis(ADVANCE), hypothesis(OTHER)],
    );
    const rows = Array.from({ length: 8 }, () => cancellation({ slotRefilled: true }));
    const a = applyEntityResolution([forward], { cancellationEvents: rows }, NOW);
    const b = applyEntityResolution([reverse], { cancellationEvents: rows }, NOW);
    expect(a[0].hypotheses.map((h) => h.status)).toEqual(b[0].hypotheses.map((h) => h.status));
  });
});

describe("determinism", () => {
  const rows = [
    cancellation({ scheduledStart: "2026-04-02T09:00:00.000Z", treatmentType: "Crown" }),
    cancellation({ scheduledStart: "2026-04-02T10:00:00.000Z", treatmentType: "Cleaning" }),
    cancellation({ scheduledStart: "2026-04-02T09:00:00.000Z", treatmentType: "Cleaning" }),
    cancellation({ scheduledStart: "2026-04-03T09:00:00.000Z", treatmentType: "Crown" }),
    cancellation({ scheduledStart: "2026-04-03T11:00:00.000Z", treatmentType: "Crown" }),
    cancellation({ scheduledStart: "2026-04-04T09:00:00.000Z", treatmentType: "Crown" }),
  ];
  const dx = diagnosis(["cancellation_slot_clustering"], [ADVANCE, OTHER], [
    hypothesis(ADVANCE),
    hypothesis(OTHER),
  ]);

  it("produces byte-identical output across repeated runs", () => {
    const a = applyEntityResolution([dx], { cancellationEvents: rows }, NOW);
    const b = applyEntityResolution([dx], { cancellationEvents: rows }, NOW);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("breaks bucket ties by label, so row order cannot change the answer", () => {
    const a = applyEntityResolution([dx], { cancellationEvents: rows }, NOW);
    const b = applyEntityResolution([dx], { cancellationEvents: [...rows].reverse() }, NOW);
    expect(a[0].evidence.map((e) => e.description)).toEqual(
      b[0].evidence.map((e) => e.description),
    );
  });

  it("stamps evidence with the supplied moment, never the clock", () => {
    const after = applyEntityResolution([dx], { cancellationEvents: rows }, NOW);
    expect(after[0].evidence.every((e) => e.capturedAt === NOW)).toBe(true);
  });
});

describe("fetch planning", () => {
  it("asks only for what this run's discriminators need", () => {
    const dx = diagnosis(["cancellation_timing"], [ADVANCE, OTHER], [hypothesis(ADVANCE)]);
    expect(portMethodsFor([dx])).toEqual(["listCancellationEvents"]);
  });

  it("deduplicates methods shared by several discriminators", () => {
    const dx = diagnosis(
      ["cancellation_timing", "slot_refill_outcome", "cancellation_slot_clustering"],
      [ADVANCE, OTHER],
      [hypothesis(ADVANCE)],
    );
    expect(portMethodsFor([dx])).toEqual(["listCancellationEvents"]);
  });

  it("asks for nothing when there are no diagnoses", () => {
    // A quiet day must not touch the database at all.
    expect(portMethodsFor([])).toEqual([]);
  });

  it("does not ask for data no resolver could use", () => {
    // recall_contact_attempts has a port method catalogued but no resolver,
    // because DentGrow records no contact attempts. Fetching it would be work
    // whose result is discarded.
    const dx = diagnosis(["recall_contact_attempts"], [ADVANCE], [hypothesis(ADVANCE)]);
    expect(portMethodsFor([dx])).toEqual([]);
  });
});

describe("no advice", () => {
  it("never tells the clinic what to do", () => {
    // The engine-wide guard in no-advice.spec.ts covers the matcher corpus; this
    // pins the strings THIS layer adds.
    const advisory =
      /\b(should|consider|recommend|try|need to|must|ought to|suggest|advis)/i;
    const contexts: EntityContext[] = [
      { cancellationEvents: Array.from({ length: 8 }, () => cancellation()) },
      { cancellationEvents: [cancellation({ noticeHours: null, cancelledAt: null })] },
      { cancellationEvents: Array.from({ length: 8 }, () => cancellation({ slotRefilled: true })) },
    ];
    for (const ctx of contexts) {
      const after = applyEntityResolution(
        [
          diagnosis(
            ["cancellation_timing", "slot_refill_outcome", "cancellation_slot_clustering"],
            [ADVANCE, OTHER],
            [hypothesis(ADVANCE), hypothesis(OTHER)],
          ),
        ],
        ctx,
        NOW,
      );
      const strings = [
        ...after[0].evidence.map((e) => e.description),
        ...after[0].hypotheses.flatMap((h) => [
          ...h.supporting.map((e) => e.description),
          ...h.contradicting.map((e) => e.description),
        ]),
      ];
      expect(strings.length).toBeGreaterThan(0);
      for (const s of strings) expect(advisory.test(s)).toBe(false);
    }
  });
});
