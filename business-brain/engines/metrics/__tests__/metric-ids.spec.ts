import { describe, expect, it } from "vitest";

import { MetricCategory, MetricUnit } from "../../../domain";
import { METRIC_CALCULATORS } from "../calculators";
import { METRIC_DESCRIPTORS, MetricKey, buildMetric } from "../metric-ids";
import { AS_OF, CLINIC, DATE, measurableSnapshot, snapshot } from "./fixtures/snapshot-fixtures";

const ALL_KEYS = Object.values(MetricKey);

describe("metric manifest", () => {
  it("has a descriptor for every key, keyed by itself", () => {
    for (const key of ALL_KEYS) {
      const d = METRIC_DESCRIPTORS[key];
      expect(d, `missing descriptor for ${key}`).toBeDefined();
      expect(d.key).toBe(key);
      expect(d.name.length).toBeGreaterThan(0);
      expect(Object.values(MetricCategory)).toContain(d.category);
      expect(Object.values(MetricUnit)).toContain(d.unit);
    }
  });

  it("registers exactly one calculator per metric key", () => {
    // Guards the most likely mistake: adding a key without a calculator, or a
    // calculator without a key. Both leave a metric silently missing at runtime.
    expect(METRIC_CALCULATORS.length).toBe(ALL_KEYS.length);
  });

  it("produces every declared key exactly once for a measurable snapshot", () => {
    const s = measurableSnapshot();
    const produced = METRIC_CALCULATORS.map((c) => c(s)?.id.split(":")[0]);
    expect(produced.every((key) => key !== undefined)).toBe(true);
    expect(produced.length).toBe(new Set(produced).size);
    expect([...produced].sort()).toEqual([...ALL_KEYS].sort());
  });

  it("withholds exactly the undefined metrics on an empty clinic day", () => {
    // Every one of these is undefined rather than zero: a rate with no
    // denominator, a mean of no cases, or a metric whose input the snapshot
    // never carried. Reporting 0 for any of them would be a claim the data does
    // not support.
    //
    // Each calculator is identified by running it against a measurable snapshot
    // first, so a failure names the metric instead of an array index.
    const empty = snapshot();
    const withheld = METRIC_CALCULATORS.map((c) => ({
      key: c(measurableSnapshot())?.id.split(":")[0],
      absent: c(empty) === null,
    }))
      .filter((r) => r.absent)
      .map((r) => r.key)
      .sort();

    expect(withheld).toEqual(
      [
        MetricKey.CAPACITY_BOOKED_NEXT_7D,
        MetricKey.CAPACITY_CHAIR_UTILIZATION, // closed day: no open minutes to measure against
        MetricKey.CAPACITY_CHAIR_UTILIZATION_30D,
        MetricKey.PATIENTS_REACTIVATION_CANDIDATES,
        MetricKey.QUEUE_AVERAGE_WAITING_TIME, // no measured wait: not "nobody waits"
        MetricKey.REVENUE_COLLECTION_RATE_30D,
        // The empty-clinic-day fixture supplies no patientsOnPaymentPlan set at
        // all, so this is correctly withheld — absent means no repository
        // support for payment plans, never "nobody has one".
        MetricKey.REVENUE_OUTSTANDING_ON_PAYMENT_PLAN,
        MetricKey.SCHEDULING_BOOKING_LEAD_TIME_DAYS,
        // No trailing window was supplied, so the denominator behind both rates
        // was never looked at. An empty window would read 0 here — the clinic
        // booked nothing, which is a measurement — and that is the distinction.
        MetricKey.SCHEDULING_APPOINTMENTS_30D,
        MetricKey.SCHEDULING_CANCELLATION_RATE_30D,
        // No trailing window means no appointments to have been missed. Zero
        // would claim nobody misses appointments here, which is a different
        // statement from never having looked.
        MetricKey.SCHEDULING_REPEAT_NON_ATTENDERS_30D,
        MetricKey.SCHEDULING_NO_SHOW_RATE_30D,
        // No visit durations supplied at all, so neither can be measured. Zero
        // overrun would be the claim "this clinic books accurately" and a zero
        // sample would be indistinguishable from a measured zero — the precise
        // distinction the withholding rule exists to keep.
        MetricKey.SCHEDULING_APPOINTMENT_OVERRUN_30D,
        MetricKey.SCHEDULING_MEASURED_VISITS_30D,
        MetricKey.TREATMENT_AVERAGE_CASE_VALUE_30D,
      ].sort(),
    );
  });

  it("keys are unique and namespaced", () => {
    expect(new Set(ALL_KEYS).size).toBe(ALL_KEYS.length);
    for (const key of ALL_KEYS) {
      expect(key, `${key} should be namespaced as <group>.<name>`).toMatch(
        /^[a-z]+\.[a-z0-9_]+$/,
      );
    }
  });
});

describe("buildMetric", () => {
  it("builds a deterministic id from key, clinic and date", () => {
    const m = buildMetric(MetricKey.REVENUE_OUTSTANDING, 500, CLINIC, DATE, AS_OF);
    expect(m.id).toBe(`revenue.outstanding:${CLINIC}:${DATE}`);
  });

  it("is byte-identical across repeated calls", () => {
    const a = buildMetric(MetricKey.PATIENTS_NEW_TODAY, 3, CLINIC, DATE, AS_OF);
    const b = buildMetric(MetricKey.PATIENTS_NEW_TODAY, 3, CLINIC, DATE, AS_OF);
    expect(a).toEqual(b);
  });

  it("carries name, unit and category from the descriptor", () => {
    const m = buildMetric(MetricKey.CAPACITY_CHAIR_UTILIZATION, 40, CLINIC, DATE, AS_OF);
    expect(m.name).toBe("Chair Utilization");
    expect(m.unit).toBe(MetricUnit.PERCENTAGE);
    expect(m.category).toBe(MetricCategory.UTILIZATION);
  });

  it("scopes the id per clinic and per day so re-runs overwrite, never duplicate", () => {
    const a = buildMetric(MetricKey.REVENUE_OUTSTANDING, 1, "clinic_a", DATE, AS_OF);
    const b = buildMetric(MetricKey.REVENUE_OUTSTANDING, 1, "clinic_b", DATE, AS_OF);
    const c = buildMetric(MetricKey.REVENUE_OUTSTANDING, 1, "clinic_a", "2026-07-29", AS_OF);
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  it("stamps the metric with the supplied capture time, not the clock", () => {
    const m = buildMetric(MetricKey.QUEUE_PATIENTS_WAITING, 0, CLINIC, DATE, AS_OF);
    expect(m.timestamp).toBe(AS_OF);
  });
});
