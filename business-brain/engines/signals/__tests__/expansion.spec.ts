/**
 * Signal Engine — the six rules added for the expanded outcome set.
 *
 * Grouped in one file because they share a single theme, and it is the theme the
 * expansion was for: every one of them reads a WINDOW rather than a date, and
 * four of them activate a metric that had been computed correctly and consumed
 * by nothing.
 *
 * Each rule gets the same three questions:
 *
 *   1. does it fire on the finding it exists for,
 *   2. does it stay silent inside its limit, and
 *   3. does it SKIP — not report a zero — when the measurement is absent.
 *
 * The third is the one worth having. Every rule here is about a level or a rate
 * over a month, and every one of them has a plausible reading where "we could not
 * measure it" would be indistinguishable from "it is fine" if the skip were ever
 * to become a `no_signal`.
 */

import { describe, expect, it } from "vitest";

import { MetricUnit, SignalType } from "../../../domain";
import { signalTypeOf } from "../../diagnosis/support/signal-index";
import { MetricKey } from "../../metrics/metric-ids";
import { collectionRateLowEvaluator } from "../evaluators/financial/collection-rate-low";
import { sustainedLowUtilizationEvaluator } from "../evaluators/operational/sustained-low-utilization";
import { lapsedPatientBaseEvaluator } from "../evaluators/retention/lapsed-patient-base";
import { appointmentsOverrunningEvaluator } from "../evaluators/scheduling/appointments-overrunning";
import { longBookingLeadTimeEvaluator } from "../evaluators/scheduling/long-booking-lead-time";
import { sustainedAttritionEvaluator } from "../evaluators/scheduling/sustained-attrition";
import { HEALTHY_CLINIC } from "./fixtures/metric-fixtures";
import { context, expectSignal } from "./fixtures/evaluator-harness";

// ── retention.lapsed_patient_base ────────────────────────────────────────────

describe("retention.lapsed_patient_base", () => {
  it("fires on a dormant base above the limit and names the population", () => {
    const signal = expectSignal(
      lapsedPatientBaseEvaluator,
      context({ ...HEALTHY_CLINIC, [MetricKey.PATIENTS_REACTIVATION_CANDIDATES]: 140 }),
    );
    expect(signalTypeOf(signal)).toBe(SignalType.RETENTION_LAPSED_PATIENT_BASE);
    expect(signal.description).toContain("140");
    // The number is a count of PEOPLE, not a rate. Asserted because the whole
    // reason this is not calibrated is that it is a call list.
    const observed = (signal.evidence ?? []).find((e) => e.id.endsWith("#observed"));
    expect(observed?.data).toMatchObject({ unit: MetricUnit.COUNT });
  });

  it("stays silent at the limit rather than one patient below it", () => {
    // Boundary asserted explicitly: the rule reads `<=`, so a clinic sitting
    // exactly on its configured limit is not yet a finding.
    const outcome = lapsedPatientBaseEvaluator.evaluate(
      context({ ...HEALTHY_CLINIC, [MetricKey.PATIENTS_REACTIVATION_CANDIDATES]: 25 }),
    );
    expect(outcome.kind).toBe("no_signal");
  });

  it("skips rather than reporting zero when the roster was never loaded", () => {
    // The metric is withheld by the calculator when no roster is supplied. A
    // `no_signal` here would mean "this clinic has no lapsed patients", which is a
    // claim about the clinic; a skip means "we did not look", which is the truth.
    const values = { ...HEALTHY_CLINIC };
    delete values[MetricKey.PATIENTS_REACTIVATION_CANDIDATES];
    const outcome = lapsedPatientBaseEvaluator.evaluate(context(values));
    expect(outcome.kind).toBe("skipped");
  });

  it("still fires when the recall list is clean, which is the case it exists for", () => {
    // The clinic with no overdue follow-ups at all is the one nothing could
    // previously see: no backlog can grow from a list nobody was put on.
    const signal = expectSignal(
      lapsedPatientBaseEvaluator,
      context({
        ...HEALTHY_CLINIC,
        [MetricKey.PATIENTS_REACTIVATION_CANDIDATES]: 90,
        [MetricKey.FOLLOWUPS_OVERDUE]: 0,
      }),
    );
    expect(signal.description).toContain("0");
  });
});

// ── scheduling.appointments_overrunning ──────────────────────────────────────

describe("scheduling.appointments_overrunning", () => {
  const overrunning = (over: Partial<Record<string, number>> = {}) =>
    context({
      ...HEALTHY_CLINIC,
      [MetricKey.SCHEDULING_APPOINTMENT_OVERRUN_30D]: 34,
      [MetricKey.SCHEDULING_MEASURED_VISITS_30D]: 71,
      ...over,
    } as never);

  it("fires on a sustained overrun and states the sample it rests on", () => {
    const signal = expectSignal(appointmentsOverrunningEvaluator, overrunning());
    expect(signalTypeOf(signal)).toBe(SignalType.SCHEDULING_APPOINTMENTS_OVERRUNNING);
    expect(signal.description).toContain("34");
    expect(signal.description).toContain("71");
  });

  it("stands down below the minimum sample, however large the overrun", () => {
    // A 90% overrun across four visits is one difficult morning. Telling a clinic
    // its booking policy is broken on that evidence is exactly the false alarm
    // that teaches people to stop reading the dashboard.
    const outcome = appointmentsOverrunningEvaluator.evaluate(
      overrunning({
        [MetricKey.SCHEDULING_APPOINTMENT_OVERRUN_30D]: 90,
        [MetricKey.SCHEDULING_MEASURED_VISITS_30D]: 4,
      }),
    );
    expect(outcome.kind).toBe("no_signal");
    expect(outcome.kind === "no_signal" && outcome.reason).toContain("4 visit(s)");
  });

  it("is silent for a clinic that finishes early, not just for one that is on time", () => {
    // One-sided on purpose. Finishing early may mean generous booking or prompt
    // queue-closing, and it warrants the opposite action from overrunning — so it
    // must not arrive under a heading that says "book longer".
    const outcome = appointmentsOverrunningEvaluator.evaluate(
      overrunning({ [MetricKey.SCHEDULING_APPOINTMENT_OVERRUN_30D]: -18 }),
    );
    expect(outcome.kind).toBe("no_signal");
  });

  it("skips when the durations were never read", () => {
    const values = { ...HEALTHY_CLINIC };
    delete values[MetricKey.SCHEDULING_APPOINTMENT_OVERRUN_30D];
    delete values[MetricKey.SCHEDULING_MEASURED_VISITS_30D];
    const outcome = appointmentsOverrunningEvaluator.evaluate(context(values));
    expect(outcome.kind).toBe("skipped");
  });
});

// ── revenue.collection_rate_low ──────────────────────────────────────────────

describe("revenue.collection_rate_low", () => {
  it("fires when a month's collection falls short of its production", () => {
    const signal = expectSignal(
      collectionRateLowEvaluator,
      context({
        ...HEALTHY_CLINIC,
        [MetricKey.REVENUE_PRODUCTION_PAID_RATE_30D]: 61,
        [MetricKey.REVENUE_PRODUCTION_30D]: 520_000,
      }),
    );
    expect(signalTypeOf(signal)).toBe(SignalType.REVENUE_COLLECTION_RATE_LOW);
    expect(signal.description).toContain("61");
  });

  it("stands down when production was too small for a rate to mean anything", () => {
    // One unpaid consultation in a nearly-idle month produces a catastrophic
    // rate. The guard is a money floor rather than a treatment count, because
    // money is the unit the rate is in.
    const outcome = collectionRateLowEvaluator.evaluate(
      context({
        ...HEALTHY_CLINIC,
        [MetricKey.REVENUE_PRODUCTION_PAID_RATE_30D]: 30,
        [MetricKey.REVENUE_PRODUCTION_30D]: 4_000,
      }),
    );
    expect(outcome.kind).toBe("no_signal");
    expect(outcome.kind === "no_signal" && outcome.reason).toContain("below");
  });

  it("skips when the rate could not be computed", () => {
    // The calculator withholds it against zero production — a share of nothing.
    // Reporting 0% would read as "none of our work gets paid for".
    const values = { ...HEALTHY_CLINIC };
    delete values[MetricKey.REVENUE_PRODUCTION_PAID_RATE_30D];
    const outcome = collectionRateLowEvaluator.evaluate(context(values));
    expect(outcome.kind).toBe("skipped");
  });
});

// ── operational.sustained_low_utilization ────────────────────────────────────

describe("operational.sustained_low_utilization", () => {
  it("fires on a month of idle chairs even when today was busy", () => {
    // Today being fine is not evidence against a month of empty chairs, and the
    // rule must not read it as such.
    const signal = expectSignal(
      sustainedLowUtilizationEvaluator,
      context({
        ...HEALTHY_CLINIC,
        [MetricKey.CAPACITY_CHAIR_UTILIZATION_30D]: 28,
        [MetricKey.CAPACITY_CHAIR_UTILIZATION]: 91,
      }),
    );
    expect(signalTypeOf(signal)).toBe(SignalType.OPERATIONAL_SUSTAINED_LOW_UTILIZATION);
    expect(signal.description).toContain("28");
  });

  it("sits below the daily threshold, so it means something worse than a quiet day", () => {
    // 45% is under the daily minimum of 50 and over the sustained minimum of 40.
    // A month at 45% must NOT fire here, or this rule becomes a second copy of
    // the daily one and fires for every clinic the daily one over-fires for.
    const outcome = sustainedLowUtilizationEvaluator.evaluate(
      context({ ...HEALTHY_CLINIC, [MetricKey.CAPACITY_CHAIR_UTILIZATION_30D]: 45 }),
    );
    expect(outcome.kind).toBe("no_signal");
  });

  it("skips when the window utilization was not measured", () => {
    const values = { ...HEALTHY_CLINIC };
    delete values[MetricKey.CAPACITY_CHAIR_UTILIZATION_30D];
    const outcome = sustainedLowUtilizationEvaluator.evaluate(context(values));
    expect(outcome.kind).toBe("skipped");
  });
});

// ── scheduling.sustained_attrition ───────────────────────────────────────────

describe("scheduling.sustained_attrition", () => {
  it("fires on the combined share even where each half clears its own daily limit", () => {
    // The gap this closes. 9% cancellations is under the 10% daily threshold and
    // 8% no-shows is at the 8% one, so neither daily rule fires — while the clinic
    // loses 17% of everything it books.
    const signal = expectSignal(
      sustainedAttritionEvaluator,
      context({
        ...HEALTHY_CLINIC,
        [MetricKey.SCHEDULING_CANCELLATION_RATE_30D]: 9,
        [MetricKey.SCHEDULING_NO_SHOW_RATE_30D]: 8,
      }),
    );
    expect(signalTypeOf(signal)).toBe(SignalType.SCHEDULING_SUSTAINED_ATTRITION);
    expect(signal.description).toContain("17");
    // The composition survives into the evidence, so the diagnosis downstream can
    // still say which half dominates without this rule pre-judging it.
    expect(signal.description).toContain("9%");
    expect(signal.description).toContain("8%");
  });

  it("stays silent inside the combined limit", () => {
    const outcome = sustainedAttritionEvaluator.evaluate(
      context({
        ...HEALTHY_CLINIC,
        [MetricKey.SCHEDULING_CANCELLATION_RATE_30D]: 6,
        [MetricKey.SCHEDULING_NO_SHOW_RATE_30D]: 5,
      }),
    );
    expect(outcome.kind).toBe("no_signal");
  });

  it("skips when either rate is missing rather than treating it as zero", () => {
    // Half a denominator is worse than none: summing a real 12% cancellation rate
    // with an assumed 0% no-show rate would report the clinic as inside its limit.
    const values = { ...HEALTHY_CLINIC };
    delete values[MetricKey.SCHEDULING_NO_SHOW_RATE_30D];
    const outcome = sustainedAttritionEvaluator.evaluate(
      context({ ...values, [MetricKey.SCHEDULING_CANCELLATION_RATE_30D]: 12 }),
    );
    expect(outcome.kind).toBe("skipped");
  });
});

// ── scheduling.long_booking_lead_time ────────────────────────────────────────

describe("scheduling.long_booking_lead_time", () => {
  it("fires on a long median wait and says plainly that it is ambiguous alone", () => {
    const signal = expectSignal(
      longBookingLeadTimeEvaluator,
      context({ ...HEALTHY_CLINIC, [MetricKey.SCHEDULING_BOOKING_LEAD_TIME_DAYS]: 24 }),
    );
    expect(signalTypeOf(signal)).toBe(SignalType.SCHEDULING_LONG_BOOKING_LEAD_TIME);
    expect(signal.description).toContain("24");
    // The caveat is part of the rule, not a footnote: alone, a long lead time is
    // equally consistent with patients choosing later dates.
    expect(signal.description).toContain("choosing later dates");
  });

  it("stays silent inside the limit", () => {
    const outcome = longBookingLeadTimeEvaluator.evaluate(
      context({ ...HEALTHY_CLINIC, [MetricKey.SCHEDULING_BOOKING_LEAD_TIME_DAYS]: 5 }),
    );
    expect(outcome.kind).toBe("no_signal");
  });

  it("skips when no appointment in the window had a usable lead time", () => {
    const values = { ...HEALTHY_CLINIC };
    delete values[MetricKey.SCHEDULING_BOOKING_LEAD_TIME_DAYS];
    const outcome = longBookingLeadTimeEvaluator.evaluate(context(values));
    expect(outcome.kind).toBe("skipped");
  });
});
