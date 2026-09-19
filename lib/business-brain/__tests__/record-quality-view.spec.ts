/**
 * The "How your day is recorded" card's copy.
 *
 * Two things this file must never do, and both are about tone as much as truth:
 * it must not tell a clinic it is doing something wrong, and it must not turn a
 * failed read into a claim about the clinic's habits. Every line states what a
 * gap COSTS — which measurement goes quiet — and where it is closed.
 */

import { describe, expect, it } from "vitest";

import { RecordCheck, assessRecordQuality, splitNoShowBasis } from "@/business-brain";
import type { ClinicRecordQuality } from "../record-quality";
import { buildRecordQualityView } from "../record-quality-view";

function quality(
  counts: { check: RecordCheck; recorded: number | null; total: number }[],
  bases: ("recorded" | "inferred" | "unknown")[] = [],
): ClinicRecordQuality {
  return {
    ...assessRecordQuality(counts),
    from: "2026-08-21",
    to: "2026-09-19",
    noShows: splitNoShowBasis(bases),
  };
}

describe("buildRecordQualityView", () => {
  it("states the share recorded, not a grade", () => {
    const view = buildRecordQualityView(
      quality([{ check: RecordCheck.ARRIVALS, recorded: 9, total: 10 }]),
    );
    expect(view?.headline).toBe("90% of what could be recorded in the last 30 days was.");
    expect(view?.score).toBe(90);
  });

  it("names what each gap costs and where it is closed", () => {
    const view = buildRecordQualityView(
      quality([{ check: RecordCheck.CALL_INS, recorded: 4, total: 20 }]),
    );
    const [line] = view?.lines ?? [];
    expect(line?.detail).toContain("4 of 20");
    // The measurement lost, never an instruction about how to run the clinic.
    expect(line?.cost).toContain("unmeasured, not zero");
    expect(line?.fix).toEqual({
      href: "/dentist/queue",
      label: "Use Call Next when you start a visit",
    });
  });

  it("puts the gaps first", () => {
    const view = buildRecordQualityView(
      quality([
        { check: RecordCheck.ARRIVALS, recorded: 10, total: 10 },
        { check: RecordCheck.CALL_INS, recorded: 1, total: 10 },
      ]),
    );
    expect(view?.lines[0]?.label).toBe("Call-ins");
    // And a complete check offers nothing to fix: there is nothing to do.
    expect(view?.lines[1]?.cost).toBeNull();
    expect(view?.lines[1]?.fix).toBeNull();
  });

  it("says a read failed rather than reporting nobody recorded anything", () => {
    const view = buildRecordQualityView(
      quality([{ check: RecordCheck.ARRIVALS, recorded: null, total: 12 }]),
    );
    expect(view?.lines[0]?.detail).toBe("Could not be read.");
    expect(view?.lines[0]?.detail).not.toContain("0 of 12");
    expect(view?.score).toBeNull();
    expect(view?.headline).toBe("Nothing to measure in the last 30 days.");
  });

  it("distinguishes nothing to record from nothing recorded", () => {
    const view = buildRecordQualityView(
      quality([{ check: RecordCheck.NO_SHOW_MARKS, recorded: 0, total: 0 }]),
    );
    expect(view?.lines[0]?.detail).toBe("Nothing to record in the last 30 days.");
    expect(view?.lines[0]?.cost).toBeNull();
  });

  it("splits the window's no-shows into what was seen and what was inferred", () => {
    // The point of the split: a rate that mixes them implies somebody watched a
    // patient not arrive, and on a clinic that clicks through its day most of
    // those "no-shows" are the nightly job's reading.
    const view = buildRecordQualityView(
      quality(
        [{ check: RecordCheck.NO_SHOW_MARKS, recorded: 2, total: 9 }],
        ["recorded", "recorded", ...Array<"inferred">(6).fill("inferred"), "unknown"],
      ),
    );
    expect(view?.noShowBasis).toContain("9 missed appointments");
    expect(view?.noShowBasis).toContain("2 marked by your team");
    expect(view?.noShowBasis).toContain("6 inferred overnight");
    expect(view?.noShowBasis).toContain("1 with no record of who marked them");
  });

  it("says so when every missed appointment was marked by a person", () => {
    // Worth stating rather than leaving to be assumed: it is what makes the
    // no-show rate trustworthy.
    const view = buildRecordQualityView(
      quality([{ check: RecordCheck.NO_SHOW_MARKS, recorded: 3, total: 3 }], [
        "recorded",
        "recorded",
        "recorded",
      ]),
    );
    expect(view?.noShowBasis).toBe(
      "All 3 missed appointments in the last 30 days were marked by your team.",
    );
  });

  it("says nothing about no-shows when there were none", () => {
    // Not 0% inferred. There is nothing to take a share of.
    const view = buildRecordQualityView(
      quality([{ check: RecordCheck.ARRIVALS, recorded: 5, total: 5 }]),
    );
    expect(view?.noShowBasis).toBeNull();
  });

  it("renders nothing at all when the read failed outright", () => {
    expect(buildRecordQualityView(null)).toBeNull();
  });
});
