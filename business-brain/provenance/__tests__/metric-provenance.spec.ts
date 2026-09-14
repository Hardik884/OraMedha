/**
 * How a stored reading is classified, and the declared map of what each metric
 * reads that nothing versions — checked against what the calculators actually read.
 */

import { describe, expect, it } from "vitest";

import { METRIC_CALCULATORS } from "../../engines/metrics/calculators";
import { MetricKey } from "../../engines/metrics/metric-ids";
import { measurableSnapshot } from "../../engines/metrics/__tests__/fixtures/snapshot-fixtures";
import { endOfLocalDay, startOfLocalDay } from "../../utils/dates";
import {
  classifyMetricReading,
  isPointInTimeSafe,
  MetricProvenance,
  OBSERVATION_GRACE_HOURS,
  ProvenanceError,
  UNVERSIONED_INPUTS_BY_METRIC,
  UnversionedInput,
  type SnapshotKnowledge,
} from "..";

const pit = (knownAt: string): SnapshotKnowledge => ({ mode: "point_in_time", knownAt });
const current = (knownAt: string): SnapshotKnowledge => ({ mode: "current_state", knownAt, reason: "before_history_capture" });
const plus = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

describe("clinic-local day boundaries", () => {
  it("places midnight in the clinic's own timezone, across DST and month and year ends", () => {
    expect(startOfLocalDay("2026-09-14", "Asia/Kolkata")).toBe("2026-09-13T18:30:00.000Z");
    expect(endOfLocalDay("2026-09-14", "Asia/Kolkata")).toBe("2026-09-14T18:30:00.000Z");
    expect(endOfLocalDay("2026-12-31", "Asia/Kolkata")).toBe("2026-12-31T18:30:00.000Z");
    expect(startOfLocalDay("2026-09-14", "America/Los_Angeles")).toBe("2026-09-14T07:00:00.000Z");
    expect(endOfLocalDay("2026-08-31", "America/New_York")).toBe("2026-09-01T04:00:00.000Z");
    // US DST: 8 March 2026 is 23 hours long, 1 November 25.
    expect(startOfLocalDay("2026-03-08", "America/New_York")).toBe("2026-03-08T05:00:00.000Z");
    expect(endOfLocalDay("2026-03-08", "America/New_York")).toBe("2026-03-09T04:00:00.000Z");
    expect(startOfLocalDay("2026-11-01", "America/Los_Angeles")).toBe("2026-11-01T07:00:00.000Z");
    expect(endOfLocalDay("2026-11-01", "America/Los_Angeles")).toBe("2026-11-02T08:00:00.000Z");
    expect(endOfLocalDay("2026-12-31", "UTC")).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("classifyMetricReading", () => {
  const key = MetricKey.FOLLOWUPS_OVERDUE;
  const dayEnd = endOfLocalDay("2026-09-14", "Asia/Kolkata");

  it("is observed at the time when measured within the grace window from state as known at the day's end", () => {
    const r = classifyMetricReading({ metricKey: key, date: "2026-09-14", timezone: "Asia/Kolkata", producedAt: plus(dayEnd, 30), knowledge: pit(plus(dayEnd, -0.001)) });
    expect(r).toMatchObject({ provenance: MetricProvenance.OBSERVED_AT_TIME, unversionedInputs: [] });
    expect(Date.parse(r.knowledgeAsOf)).toBeLessThanOrEqual(Date.parse(dayEnd));
  });

  it("is a point-in-time reconstruction when measured later from that same state, and nothing unversioned", () => {
    const producedAt = plus(dayEnd, OBSERVATION_GRACE_HOURS * 60 + 1);
    expect(classifyMetricReading({ metricKey: key, date: "2026-09-14", timezone: "Asia/Kolkata", producedAt, knowledge: pit(dayEnd) }).provenance).toBe(MetricProvenance.POINT_IN_TIME_RECONSTRUCTION);
  });

  it("is recomputed later when it read current state, or an unversioned input long after the day", () => {
    const late = plus(dayEnd, 60 * 24 * 6);
    expect(classifyMetricReading({ metricKey: key, date: "2026-09-14", timezone: "Asia/Kolkata", producedAt: plus(dayEnd, 10), knowledge: current(plus(dayEnd, 10)) })).toMatchObject({
      provenance: MetricProvenance.RECOMPUTED_LATER,
      knowledgeAsOf: plus(dayEnd, 10),
    });
    expect(classifyMetricReading({ metricKey: MetricKey.CAPACITY_CHAIR_UTILIZATION, date: "2026-09-14", timezone: "Asia/Kolkata", producedAt: late, knowledge: pit(dayEnd) })).toMatchObject({
      provenance: MetricProvenance.RECOMPUTED_LATER,
      unversionedInputs: [UnversionedInput.SCHEDULE_CONFIGURATION],
    });
    expect(classifyMetricReading({ metricKey: key, date: "2026-09-14", timezone: "Asia/Kolkata", producedAt: late, knowledge: undefined }).provenance).toBe(MetricProvenance.RECOMPUTED_LATER);
    // Knowledge reaching past the day is not point in time, however it was read.
    expect(classifyMetricReading({ metricKey: key, date: "2026-09-14", timezone: "Asia/Kolkata", producedAt: plus(dayEnd, 30), knowledge: pit(plus(dayEnd, 1)) }).provenance).toBe(MetricProvenance.RECOMPUTED_LATER);
  });

  it("uses the clinic's day, not the server's: the same instant is a finished day in Kolkata and an unfinished one in Los Angeles", () => {
    const producedAt = "2026-09-14T19:00:00.000Z";
    expect(classifyMetricReading({ metricKey: key, date: "2026-09-14", timezone: "Asia/Kolkata", producedAt, knowledge: pit("2026-09-14T18:29:59.999Z") }).provenance).toBe(MetricProvenance.OBSERVED_AT_TIME);
    expect(() => classifyMetricReading({ metricKey: key, date: "2026-09-14", timezone: "America/Los_Angeles", producedAt, knowledge: pit(producedAt) })).toThrow(ProvenanceError);
  });

  it("refuses an unknown metric rather than guessing its inputs", () => {
    expect(() => classifyMetricReading({ metricKey: "made.up", date: "2026-09-14", timezone: "UTC", producedAt: "2026-09-15T01:00:00.000Z", knowledge: pit("2026-09-15T00:00:00.000Z") })).toThrow(ProvenanceError);
  });

  it("treats only measured-then and point-in-time reconstructions as safe for the past", () => {
    expect(["observed_at_time", "point_in_time_reconstruction", "recomputed_later", "unknown", undefined].map(isPointInTimeSafe)).toEqual([true, true, false, false, false]);
  });
});

describe("UNVERSIONED_INPUTS_BY_METRIC", () => {
  it("decides every metric key", () => {
    expect(Object.keys(UNVERSIONED_INPUTS_BY_METRIC).sort()).toEqual(Object.values(MetricKey).sort());
  });

  it("declares every unversioned snapshot field a calculator actually reads", () => {
    // What each field of the snapshot rests on. Anything not listed is read from
    // versioned state history.
    const unversionedField: Record<string, UnversionedInput> = {
      capacity: UnversionedInput.SCHEDULE_CONFIGURATION,
      "trailingWindow.openChairMinutes": UnversionedInput.SCHEDULE_CONFIGURATION,
      "forwardWindow.openChairMinutes": UnversionedInput.SCHEDULE_CONFIGURATION,
      recallIntervalDays: UnversionedInput.CLINIC_SETTINGS,
      queueToday: UnversionedInput.QUEUE_ENTRIES,
      trailingVisitDurations: UnversionedInput.QUEUE_ENTRIES,
    };
    for (const calculate of METRIC_CALCULATORS) {
      const read = new Set<string>();
      const wrap = (obj: object, path: string): object =>
        new Proxy(obj, {
          get(target, prop, receiver) {
            const at = path === "" ? String(prop) : `${path}.${String(prop)}`;
            read.add(at);
            const value = Reflect.get(target, prop, receiver);
            return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Set) ? wrap(value, at) : value;
          },
        });
      const metric = calculate(wrap(measurableSnapshot() as object, "") as never);
      if (metric === null) continue;
      const key = metric.id.slice(0, metric.id.indexOf(":")) as MetricKey;
      const needed = [...new Set([...read].flatMap((field) => (unversionedField[field] === undefined ? [] : [unversionedField[field]])))].sort();
      expect({ key, inputs: [...UNVERSIONED_INPUTS_BY_METRIC[key]].sort() }).toEqual({ key, inputs: needed });
    }
  });
});
