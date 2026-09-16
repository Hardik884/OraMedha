/**
 * The claims audit of the ledger tranche, pinned.
 *
 * Each case is a statement the catalogue or a resolver used to make that the
 * schema did not support. The fix in every case was to say less, precisely —
 * never to invent the missing data — and these specs keep the stronger claim
 * from creeping back.
 */

import { describe, expect, it } from "vitest";

import type { Diagnosis } from "../../../domain";
import { applyEntityResolution } from "../resolution/resolve";
import { DEFAULT_ENTITY_RESOLUTION } from "../resolution/types";
import type { CancellationEvent } from "../ports/diagnosis-context-port";
import {
  ALL_DISCRIMINATORS,
  Availability,
  DISCRIMINATORS,
  requiredPortMethods,
} from "../support/discriminators";

const NOW = "2026-05-12T06:30:00.000Z";
const CLUSTER = "slot_clustering";
const SPREAD = "reminder_process";

function attritionDiagnosis(): Diagnosis {
  const id = "diagnosis.schedule_attrition:c1:2026-05-12";
  const h = (slug: string) => ({
    id: `${id}#h.${slug}`,
    statement: `Statement for ${slug}.`,
    status: "undetermined" as const,
    confidence: 0.4,
    supporting: [],
    contradicting: [],
    requiredData: ["entity rows"],
  });
  return {
    id,
    pattern: "schedule_attrition",
    title: "Appointments booked and then lost",
    summary: "Seeded losses.",
    category: "scheduling",
    severity: "medium",
    confidence: 0.5,
    persistence: "transient",
    signalIds: [],
    metricIds: [],
    hypotheses: [h(CLUSTER), h(SPREAD)],
    discriminators: [
      {
        id: `${id}#d.cancellation_slot_clustering`,
        description: "Would separate the two.",
        wouldSeparate: [`${id}#h.${CLUSTER}`, `${id}#h.${SPREAD}`],
        availability: "requires_entity_data" as const,
      },
    ],
    relatedEntities: [],
    evidence: [],
    generatedAt: NOW,
  } as unknown as Diagnosis;
}

/** Eight losses spread across eight different hours. */
function spreadLosses(typed: number): CancellationEvent[] {
  return Array.from({ length: 8 }, (_, i) => ({
    appointmentId: `a${i}`,
    date: "2026-05-12",
    scheduledStart: `2026-05-12T${String(3 + i).padStart(2, "0")}:00:00.000Z`,
    localHour: `${String(3 + i).padStart(2, "0")}:00`,
    cancelledAt: null,
    noticeHours: null,
    outcome: "no_show" as const,
    treatmentType: i < typed ? "Crown" : null,
    slotRefilled: false,
  }));
}

function statusOf(diagnosis: Diagnosis, slug: string) {
  return diagnosis.hypotheses.find((h) => h.id.endsWith(`#h.${slug}`))?.status;
}

describe("cancellation clustering by treatment type", () => {
  it("does not call a concentration from one typed row among eight losses", () => {
    // The old resolver computed the type share over TYPED rows only, so a single
    // lost appointment with a recorded treatment was "100% Crown" and settled the
    // clustering hypothesis. Appointments record no booked treatment type; one
    // typed row is an accident of what was written down, not a pattern.
    const [resolved] = applyEntityResolution(
      [attritionDiagnosis()],
      { cancellationEvents: spreadLosses(1) },
      NOW,
      DEFAULT_ENTITY_RESOLUTION,
    );
    expect(statusOf(resolved, CLUSTER)).not.toBe("supported");
  });

  it("still calls a type concentration once enough lost appointments carry a type", () => {
    const [resolved] = applyEntityResolution(
      [attritionDiagnosis()],
      { cancellationEvents: spreadLosses(DEFAULT_ENTITY_RESOLUTION.minimumSample) },
      NOW,
      DEFAULT_ENTITY_RESOLUTION,
    );
    expect(statusOf(resolved, CLUSTER)).toBe("supported");
  });
});

describe("discriminator catalogue claims", () => {
  it("catalogues recall contact attempts as data capture, served by no port method", () => {
    expect(DISCRIMINATORS.RECALL_CONTACT_ATTEMPTS.availability).toBe(Availability.REQUIRES_DATA_CAPTURE);
    expect(DISCRIMINATORS.RECALL_CONTACT_ATTEMPTS.portMethod).toBeNull();
    expect(requiredPortMethods()).not.toContain("listRecallContactAttempts");
    // It still says what IS recorded, rather than claiming nothing exists.
    expect(DISCRIMINATORS.RECALL_CONTACT_ATTEMPTS.description).toContain("reminder_logs");
  });

  it("no longer claims things the schema contradicts", () => {
    const text = ALL_DISCRIMINATORS.map((d) => d.description).join("\n");
    // reminder_logs exists (20260808000000).
    expect(text).not.toMatch(/sends no reminders and keeps no dispatch log/);
    // patients.payment_plan_until exists.
    expect(text).not.toMatch(/no concept of a payment plan/);
    // Appointments carry no booked treatment type.
    expect(text).not.toMatch(/Treatment type booked into the slot/);
    // The refill check matches an exact start time, not "the same day".
    expect(DISCRIMINATORS.SLOT_REFILL_OUTCOME.description).toContain("UNDER-reports");
  });

  it("marks every partially recorded data-capture entry as such", () => {
    for (const spec of ALL_DISCRIMINATORS) {
      if (spec.availability !== Availability.REQUIRES_DATA_CAPTURE) continue;
      expect(spec.description, spec.slug).toMatch(/NOT RECORDED|PARTIALLY RECORDED|NOT HELD/);
    }
  });
});
