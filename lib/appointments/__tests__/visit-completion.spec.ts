import { describe, expect, it } from "vitest";

import {
  DIRECT_COMPLETION_FROM,
  INFERRED_NO_SHOW_CORRECTION_DAYS,
  isCorrectableNoShow,
  noShowEvidence,
  type HistoryRowLike,
} from "../visit-completion";

const DAY = 86_400_000;
const MARKED = "2026-09-10T00:05:00.000Z";
const after = (ms: number) => new Date(Date.parse(MARKED) + ms).toISOString();

const inferred: HistoryRowLike = { action: "status_changed", new_value: { status: "no_show" }, performed_by: null, timestamp: MARKED };
const byPerson: HistoryRowLike = { ...inferred, performed_by: "profile-1" };

describe("direct completion", () => {
  it("is allowed from scheduled and checked_in only", () => {
    expect([...DIRECT_COMPLETION_FROM].sort()).toEqual(["checked_in", "scheduled"]);
  });
});

describe("noShowEvidence", () => {
  it("is null when no history row records the no-show — missing evidence is not inference", () => {
    expect(noShowEvidence([])).toBeNull();
    expect(noShowEvidence([{ ...inferred, new_value: { status: "cancelled" } }])).toBeNull();
  });

  it("reads the latest no-show mark", () => {
    const older = { ...byPerson, timestamp: "2026-09-01T00:00:00.000Z" };
    expect(noShowEvidence([older, inferred])).toEqual({ at: MARKED, inferred: true });
    expect(noShowEvidence([inferred, { ...byPerson, timestamp: after(1000) }])?.inferred).toBe(false);
  });
});

describe("isCorrectableNoShow", () => {
  it("allows correcting a system-inferred no-show within the window", () => {
    expect(isCorrectableNoShow("no_show", [inferred], after(DAY))).toBe(true);
    expect(isCorrectableNoShow("no_show", [inferred], after(INFERRED_NO_SHOW_CORRECTION_DAYS * DAY))).toBe(true);
  });

  it("refuses once the window has passed", () => {
    expect(isCorrectableNoShow("no_show", [inferred], after(INFERRED_NO_SHOW_CORRECTION_DAYS * DAY + 1))).toBe(false);
  });

  it("refuses a no-show a person recorded — that is an observation, and final", () => {
    expect(isCorrectableNoShow("no_show", [byPerson], after(DAY))).toBe(false);
  });

  it("refuses when the history is missing, and for any other status", () => {
    expect(isCorrectableNoShow("no_show", [], after(DAY))).toBe(false);
    expect(isCorrectableNoShow("cancelled", [inferred], after(DAY))).toBe(false);
  });

  it("refuses a mark dated in the future of `now`", () => {
    expect(isCorrectableNoShow("no_show", [inferred], after(-1000))).toBe(false);
  });
});
