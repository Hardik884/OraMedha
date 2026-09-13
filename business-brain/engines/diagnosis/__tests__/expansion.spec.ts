/**
 * Diagnosis Engine — the four patterns added for the expanded outcome set.
 *
 * Half of this file is about when each pattern does NOT fire, and that is the
 * important half. Every new pattern here sits next to an existing one that
 * describes overlapping subject matter — lapsed patients next to overdue recalls,
 * a month of overruns next to today's queue, a month of under-collection next to
 * today's collection gap — and each carries an explicit guard so a clinic is
 * never handed the same story twice under two headings.
 *
 * A guard that is not tested is a comment. These are the tests.
 */

import { describe, expect, it } from "vitest";

import { DiagnosisPattern, SignalType } from "../../../domain";
import { MetricKey } from "../../metrics/metric-ids";
import { diagnoseMetrics, patternsOf, pick } from "./fixtures/diagnose-harness";
import {
  CHRONIC_OVERRUN,
  DORMANT_PATIENT_BASE,
  HEALTHY,
  PRIOR,
  PRODUCTION_COLLECTION_GAP,
  SUSTAINED_IDLE_CAPACITY,
} from "./fixtures/run-fixtures";

// ── dormant_patient_base ─────────────────────────────────────────────────────

describe("dormant_patient_base", () => {
  it("reports a dormant base that no recall list covers", () => {
    const result = diagnoseMetrics(DORMANT_PATIENT_BASE);
    const diagnosis = pick(result, DiagnosisPattern.DORMANT_PATIENT_BASE);
    expect(diagnosis.hypotheses[0]?.status).toBe("supported");
    expect(diagnosis.summary).toContain("recall list");
  });

  it("stands down when the clinic already has an overdue recall backlog", () => {
    // The guard that keeps REACTIVATION and RETENTION from being two cards about
    // the same morning's phone calls. The overdue list is the clinic's own, more
    // specific record of who to ring, so recall_backlog owns it.
    const result = diagnoseMetrics({
      ...DORMANT_PATIENT_BASE,
      [MetricKey.FOLLOWUPS_OVERDUE]: 30,
    });
    expect(patternsOf(result)).not.toContain(DiagnosisPattern.DORMANT_PATIENT_BASE);
    expect(patternsOf(result)).toContain(DiagnosisPattern.RECALL_BACKLOG);
  });

  it("stands down when returning volume is measurably falling", () => {
    // Then the dormant base is one symptom of a contraction that
    // recall_process_failure and patient_base_erosion localise more sharply.
    const result = diagnoseMetrics(
      { ...DORMANT_PATIENT_BASE, [MetricKey.PATIENTS_RETURNING_TODAY]: 2 },
      { previous: { ...PRIOR, [MetricKey.PATIENTS_RETURNING_TODAY]: 12 } },
    );
    expect(patternsOf(result)).not.toContain(DiagnosisPattern.DORMANT_PATIENT_BASE);
  });

  it("says in its trace which pattern took the finding instead", () => {
    // A guard that silently drops a finding is indistinguishable from a bug. The
    // trace has to name the pattern that claimed it.
    const result = diagnoseMetrics({
      ...DORMANT_PATIENT_BASE,
      [MetricKey.FOLLOWUPS_OVERDUE]: 30,
    });
    const trace = result.traces.find((t) => t.step === DiagnosisPattern.DORMANT_PATIENT_BASE);
    expect(trace?.reasoning).toContain(DiagnosisPattern.RECALL_BACKLOG);
  });
});

// ── chronic_appointment_overrun ──────────────────────────────────────────────

describe("chronic_appointment_overrun", () => {
  it("reports a booking template that runs short, on a day nobody queued", () => {
    const result = diagnoseMetrics(CHRONIC_OVERRUN);
    const diagnosis = pick(result, DiagnosisPattern.CHRONIC_APPOINTMENT_OVERRUN);
    expect(diagnosis.hypotheses[0]?.status).toBe("supported");
    expect(diagnosis.summary).toContain("no patient queued");
  });

  it("stands down when patients actually queued today", () => {
    // throughput_congestion carries the same finding WITH its consequence
    // attached, as service_time_variance. Two cards would tell one story twice,
    // and the second telling would be the weaker one.
    const result = diagnoseMetrics({
      ...CHRONIC_OVERRUN,
      [MetricKey.QUEUE_PATIENTS_WAITING]: 9,
      [MetricKey.QUEUE_AVERAGE_WAITING_TIME]: 55,
    });
    expect(patternsOf(result)).not.toContain(DiagnosisPattern.CHRONIC_APPOINTMENT_OVERRUN);
    expect(patternsOf(result)).toContain(DiagnosisPattern.THROUGHPUT_CONGESTION);
  });

  it("settles schedule_overbooking on capacity_ceiling from the window metric", () => {
    // The other half of the same wiring, and a real capability gain: this
    // hypothesis could previously only ever be undetermined without an entity
    // context port, so a deployment with none could never reach it.
    const result = diagnoseMetrics({
      ...CHRONIC_OVERRUN,
      [MetricKey.APPOINTMENTS_TOTAL_TODAY]: 20,
      [MetricKey.QUEUE_PATIENTS_WAITING]: 9,
      [MetricKey.QUEUE_AVERAGE_WAITING_TIME]: 55,
      [MetricKey.CAPACITY_CHAIR_UTILIZATION]: 96,
      [MetricKey.CAPACITY_AVAILABLE_SLOTS_TODAY]: 0,
    });
    const ceiling = pick(result, DiagnosisPattern.CAPACITY_CEILING);
    const overbooking = ceiling.hypotheses.find((h) => h.id.endsWith("#h.schedule_overbooking"));
    expect(overbooking?.status).toBe("supported");
  });
});

// ── production_collection_gap ────────────────────────────────────────────────

describe("production_collection_gap", () => {
  it("reports a month of under-collection that no single day revealed", () => {
    const result = diagnoseMetrics(PRODUCTION_COLLECTION_GAP);
    const diagnosis = pick(result, DiagnosisPattern.PRODUCTION_COLLECTION_GAP);
    const settled = diagnosis.hypotheses.find((h) =>
      h.id.endsWith("#h.sustained_under_collection"),
    );
    expect(settled?.status).toBe("supported");
  });

  it("leaves both explanations open, naming a measurement OraMedha does not hold", () => {
    // The honest limit. Work that was never charged produces no balance row, so
    // invoice ageing — the measurement that looks right — cannot see it.
    const diagnosis = pick(
      diagnoseMetrics(PRODUCTION_COLLECTION_GAP),
      DiagnosisPattern.PRODUCTION_COLLECTION_GAP,
    );
    for (const slug of ["unbilled_delivery", "awaiting_payment"]) {
      const h = diagnosis.hypotheses.find((x) => x.id.endsWith(`#h.${slug}`));
      expect(h?.status).toBe("undetermined");
      // requiredData carries the discriminator's DESCRIPTION, which is what a
      // reader needs; asserted on its distinctive clause rather than the slug.
      expect(h?.requiredData[0]).toContain("the treatment row IS the charge");
    }
  });

  it("stands down when the same-day collection rule fired", () => {
    // collection_gap classifies its own persistence, which is a sharper reading
    // than a window average. One revenue finding, not two.
    const result = diagnoseMetrics({
      ...PRODUCTION_COLLECTION_GAP,
      [MetricKey.REVENUE_COLLECTED_TODAY]: 900,
      [MetricKey.TREATMENT_COMPLETED_TODAY]: 6,
    });
    expect(patternsOf(result)).not.toContain(DiagnosisPattern.PRODUCTION_COLLECTION_GAP);
    expect(patternsOf(result)).toContain(DiagnosisPattern.COLLECTION_GAP);
  });
});

// ── sustained_idle_capacity ──────────────────────────────────────────────────

describe("sustained_idle_capacity", () => {
  it("reports a month of idle chairs on a day that looked ordinary", () => {
    const result = diagnoseMetrics(SUSTAINED_IDLE_CAPACITY);
    const diagnosis = pick(result, DiagnosisPattern.SUSTAINED_IDLE_CAPACITY);
    expect(diagnosis.hypotheses[0]?.status).toBe("supported");
    // Today's utilization is healthy in this fixture, so the daily rule finds
    // nothing — the whole point being that the month is the only timescale on
    // which this clinic's problem exists.
    expect(patternsOf(result)).not.toContain(DiagnosisPattern.DEMAND_SUPPLY_MISMATCH);
  });

  it("co-exists with the today-level reading rather than guarding against it", () => {
    // The one new pattern with NO exclusion guard, because it does not need one:
    // both map to the capacity bottleneck, and the Constraint Engine collapses
    // them. Asserted here as two diagnoses; the single card is asserted in
    // outcome-uniqueness.spec.ts.
    const result = diagnoseMetrics({
      ...SUSTAINED_IDLE_CAPACITY,
      [MetricKey.APPOINTMENTS_TOTAL_TODAY]: 3,
      [MetricKey.CAPACITY_CHAIR_UTILIZATION]: 18,
      [MetricKey.CAPACITY_AVAILABLE_SLOTS_TODAY]: 9,
    });
    expect(patternsOf(result)).toContain(DiagnosisPattern.SUSTAINED_IDLE_CAPACITY);
    expect(patternsOf(result)).toContain(DiagnosisPattern.DEMAND_SUPPLY_MISMATCH);
  });
});

// ── supporting-only signals ──────────────────────────────────────────────────

describe("supporting-only signals", () => {
  it("never carries a long booking lead time forward as a standalone finding", () => {
    // Its own evaluator says a long lead time is ambiguous alone. Promoting it
    // through the unclustered safety net would state as an observation exactly
    // the claim the rule refuses to make.
    const result = diagnoseMetrics({
      ...HEALTHY,
      [MetricKey.SCHEDULING_BOOKING_LEAD_TIME_DAYS]: 30,
    });
    const unclustered = result.diagnoses.filter(
      (d) => d.pattern === DiagnosisPattern.UNCLUSTERED_SIGNAL,
    );
    expect(
      unclustered.some((d) =>
        d.id.includes(SignalType.SCHEDULING_LONG_BOOKING_LEAD_TIME),
      ),
    ).toBe(false);
  });

  it("still lets it strengthen the capacity-ceiling reading", () => {
    // Suppressed as a headline, not discarded: alongside a full chair and a queue
    // it stops being ambiguous, which is the whole argument for correlating
    // signals rather than judging them one at a time.
    const result = diagnoseMetrics({
      ...HEALTHY,
      [MetricKey.SCHEDULING_BOOKING_LEAD_TIME_DAYS]: 30,
      [MetricKey.APPOINTMENTS_TOTAL_TODAY]: 20,
      [MetricKey.QUEUE_PATIENTS_WAITING]: 9,
      [MetricKey.QUEUE_AVERAGE_WAITING_TIME]: 55,
      [MetricKey.CAPACITY_CHAIR_UTILIZATION]: 96,
      [MetricKey.CAPACITY_AVAILABLE_SLOTS_TODAY]: 0,
    });
    const ceiling = pick(result, DiagnosisPattern.CAPACITY_CEILING);
    const demand = ceiling.hypotheses.find((h) => h.id.endsWith("#h.demand_exceeds_capacity"));
    expect(demand?.status).toBe("supported");
    expect(JSON.stringify(demand?.supporting ?? [])).toContain("sustained-lead-time");
  });
});
