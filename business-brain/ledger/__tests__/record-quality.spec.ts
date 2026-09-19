/**
 * How completely a clinic records its day.
 *
 * The rules under test are all about the difference between three answers that
 * an aggregate loves to flatten into one: recorded, not recorded, and never
 * looked at. Getting that wrong here would turn "we could not read your queue"
 * into "your team records nothing", which is a serious thing to tell a clinic
 * about itself.
 */

import { describe, expect, it } from "vitest";

import {
  assessRecordQuality,
  splitNoShowBasis,
  RecordCheck,
  type RecordCheckCount,
} from "../record-quality";

function counts(over: Partial<RecordCheckCount>[] = []): RecordCheckCount[] {
  return over.map((o) => ({
    check: RecordCheck.ARRIVALS,
    recorded: 0,
    total: 0,
    ...o,
  }));
}

describe("assessRecordQuality", () => {
  it("reports the share recorded per check", () => {
    const quality = assessRecordQuality(
      counts([
        { check: RecordCheck.ARRIVALS, recorded: 18, total: 20 },
        { check: RecordCheck.CALL_INS, recorded: 9, total: 18 },
      ]),
    );
    expect(quality.checks[0].sharePercent).toBe(90);
    expect(quality.checks[0].missing).toBe(2);
    expect(quality.checks[1].sharePercent).toBe(50);
    expect(quality.score).toBe(70);
  });

  it("keeps a check that could not be read out of the score entirely", () => {
    // The distinction the whole module turns on. A failed read is not a clinic
    // that records nothing, and averaging it in as 0% would say exactly that.
    const quality = assessRecordQuality(
      counts([
        { check: RecordCheck.ARRIVALS, recorded: 10, total: 10 },
        { check: RecordCheck.CALL_INS, recorded: null, total: 10 },
      ]),
    );
    expect(quality.checks[1].status).toBe("unknown");
    expect(quality.checks[1].sharePercent).toBeNull();
    expect(quality.score).toBe(100);
    expect(quality.measuredChecks).toBe(1);
    expect(quality.totalChecks).toBe(2);
  });

  it("does not score a check with nothing to record as perfect", () => {
    // A month with no no-shows says nothing about how this clinic records them.
    const quality = assessRecordQuality(
      counts([
        { check: RecordCheck.ARRIVALS, recorded: 5, total: 10 },
        { check: RecordCheck.NO_SHOW_MARKS, recorded: 0, total: 0 },
      ]),
    );
    expect(quality.checks[1].status).toBe("nothing_to_record");
    expect(quality.score).toBe(50);
    expect(quality.measuredChecks).toBe(1);
  });

  it("reports every declared check, in the order given", () => {
    // A check that found nothing and a check that was never run must both stay
    // visible: dropping either makes the card describe a different clinic.
    const quality = assessRecordQuality(
      counts([
        { check: RecordCheck.ARRIVALS, recorded: null, total: 0 },
        { check: RecordCheck.CALL_INS, recorded: 0, total: 0 },
        { check: RecordCheck.VISIT_OUTCOMES, recorded: 1, total: 2 },
      ]),
    );
    expect(quality.checks.map((c) => c.check)).toEqual([
      RecordCheck.ARRIVALS,
      RecordCheck.CALL_INS,
      RecordCheck.VISIT_OUTCOMES,
    ]);
  });

  it("has no score at all when nothing could be measured", () => {
    const quality = assessRecordQuality(
      counts([{ check: RecordCheck.ARRIVALS, recorded: null, total: 4 }]),
    );
    expect(quality.score).toBeNull();
  });

  it("never reports more recorded than there were", () => {
    const quality = assessRecordQuality(
      counts([{ check: RecordCheck.ARRIVALS, recorded: 12, total: 10 }]),
    );
    expect(quality.checks[0].sharePercent).toBe(100);
    expect(quality.checks[0].missing).toBe(0);
  });
});

describe("splitNoShowBasis", () => {
  it("separates what a person marked from what the job inferred", () => {
    const split = splitNoShowBasis([
      "recorded",
      "recorded",
      "inferred",
      "inferred",
      "inferred",
      "unknown",
    ]);
    expect(split).toMatchObject({ total: 6, recorded: 2, inferred: 3, unknown: 1 });
    expect(split.recordedSharePercent).toBe(33.3);
  });

  it("reports no share at all when there were no missed appointments", () => {
    // Not 0% and not 100%. There is nothing to take a share of, and either
    // number would be a claim about how this clinic records no-shows.
    const split = splitNoShowBasis([]);
    expect(split.total).toBe(0);
    expect(split.recordedSharePercent).toBeNull();
  });
});
