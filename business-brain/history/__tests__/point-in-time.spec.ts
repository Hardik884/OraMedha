/**
 * Point-in-time state from recorded versions: what OraMedha knew at a moment,
 * and nothing it learned afterwards.
 */

import { describe, expect, it } from "vitest";

import {
  EffectiveTimeBasis,
  firstObservedTransition,
  HistoryIntegrityError,
  HistoryProvenance,
  historyCovers,
  orderVersions,
  stateAsOf,
  statesAsOf,
  type EntityVersion,
} from "..";

const CLINIC = "clinic_a";

interface Appt {
  readonly status: string;
  readonly deleted: boolean;
}

let seq = 0;
function v(
  recordedAt: string,
  state: Partial<Appt> = {},
  over: Partial<EntityVersion<Appt>> = {},
): EntityVersion<Appt> {
  seq += 1;
  return {
    clinicId: CLINIC,
    entityId: "appt_1",
    seq,
    recordedAt,
    effectiveAt: recordedAt,
    effectiveAtBasis: EffectiveTimeBasis.RECORDED,
    provenance: HistoryProvenance.OBSERVED,
    isCreation: false,
    state: { status: "scheduled", deleted: false, ...state },
    ...over,
  };
}

/** Mulberry32, seeded: the same shuffles every run. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe("stateAsOf", () => {
  const created = v("2026-09-01T09:00:00.000Z", {}, { isCreation: true });
  const cancelled = v("2026-09-10T09:00:00.000Z", { status: "cancelled" });
  const history = [created, cancelled];

  it("keeps an earlier observation as it was when the record changes later", () => {
    const before = stateAsOf(history, { clinicId: CLINIC, knownAt: "2026-09-05T00:00:00.000Z" });
    expect(before).toMatchObject({ status: "known", state: { status: "scheduled" } });
    // The cancellation exists, but not as far as 5 September is concerned.
    expect(stateAsOf(history, { clinicId: CLINIC, knownAt: "2026-09-10T08:59:59.999Z" })).toMatchObject({ state: { status: "scheduled" } });
    expect(stateAsOf(history, { clinicId: CLINIC, knownAt: "2026-09-10T09:00:00.000Z" })).toMatchObject({ state: { status: "cancelled" } });
  });

  it("gates on when a change was recorded, never on when it says it took effect", () => {
    // Performed on 1 September, keyed in on 5 September.
    const late = v("2026-09-05T12:00:00.000Z", { status: "completed" }, { effectiveAt: "2026-09-01T10:00:00.000Z", effectiveAtBasis: EffectiveTimeBasis.PERFORMED_AT });
    const versions = [created, late];
    const onThird = stateAsOf(versions, { clinicId: CLINIC, knownAt: "2026-09-03T00:00:00.000Z" });
    expect(onThird).toMatchObject({ status: "known", state: { status: "scheduled" } });
    const onSixth = stateAsOf(versions, { clinicId: CLINIC, knownAt: "2026-09-06T00:00:00.000Z" });
    expect(onSixth).toMatchObject({ state: { status: "completed" }, version: { effectiveAt: "2026-09-01T10:00:00.000Z", effectiveAtBasis: "performed_at" } });
  });

  it("says a record did not exist before its observed creation", () => {
    expect(stateAsOf(history, { clinicId: CLINIC, knownAt: "2026-08-31T00:00:00.000Z" })).toEqual({ status: "absent" });
  });

  it("says UNKNOWN, never absent, before a baseline — the record may well have existed", () => {
    const baseline = v("2026-09-13T17:54:53.000Z", { status: "completed" }, { provenance: HistoryProvenance.BASELINE, effectiveAt: null, effectiveAtBasis: EffectiveTimeBasis.UNKNOWN });
    expect(stateAsOf([baseline], { clinicId: CLINIC, knownAt: "2026-09-01T00:00:00.000Z" })).toEqual({ status: "unknown", reason: "before_capture" });
    expect(stateAsOf([baseline], { clinicId: CLINIC, knownAt: "2026-09-14T00:00:00.000Z" })).toMatchObject({ status: "known", version: { provenance: "baseline", effectiveAt: null } });
    expect(stateAsOf([], { clinicId: CLINIC, knownAt: "2026-09-14T00:00:00.000Z" })).toEqual({ status: "unknown", reason: "no_history" });
  });

  it("gives the same answer for every order the versions arrive in", () => {
    const versions = [
      created,
      v("2026-09-02T09:00:00.000Z", { status: "checked_in" }),
      v("2026-09-02T09:00:00.000Z", { status: "in_progress" }),
      v("2026-09-02T09:30:00.000Z", { status: "completed" }),
      v("2026-09-04T09:00:00.000Z", { deleted: true }),
    ];
    const moments = ["2026-09-01T12:00:00.000Z", "2026-09-02T09:00:00.000Z", "2026-09-03T00:00:00.000Z", "2026-09-05T00:00:00.000Z"];
    const expected = moments.map((knownAt) => stateAsOf(versions, { clinicId: CLINIC, knownAt }));
    // Two versions share a recording instant: the database sequence decides.
    expect(expected[1]).toMatchObject({ state: { status: "in_progress" } });
    for (let seed = 1; seed <= 200; seed += 1) {
      const order = shuffled(versions, seed);
      expect(moments.map((knownAt) => stateAsOf(order, { clinicId: CLINIC, knownAt }))).toEqual(expected);
    }
  });

  it("counts a version delivered twice once", () => {
    const versions = [created, cancelled, cancelled, created];
    expect(orderVersions(versions)).toHaveLength(2);
    expect(stateAsOf(versions, { clinicId: CLINIC, knownAt: "2026-09-11T00:00:00.000Z" })).toMatchObject({ state: { status: "cancelled" } });
  });

  it("refuses another clinic's versions, two records at once, and a forged duplicate sequence", () => {
    expect(() => stateAsOf([created, { ...cancelled, clinicId: "clinic_b" }], { clinicId: CLINIC, knownAt: "2026-09-11T00:00:00.000Z" })).toThrow(HistoryIntegrityError);
    expect(() => stateAsOf([created, { ...cancelled, entityId: "appt_2" }], { clinicId: CLINIC, knownAt: "2026-09-11T00:00:00.000Z" })).toThrow(HistoryIntegrityError);
    expect(() => orderVersions([created, { ...created, recordedAt: "2026-09-02T00:00:00.000Z" }])).toThrow(HistoryIntegrityError);
    expect(() => stateAsOf([created], { clinicId: CLINIC, knownAt: "not a time" })).toThrow(HistoryIntegrityError);
  });

  it("keeps soft deletion as state: deleted after the moment is live at the moment", () => {
    const deleted = v("2026-09-08T09:00:00.000Z", { deleted: true });
    expect(stateAsOf([created, deleted], { clinicId: CLINIC, knownAt: "2026-09-07T00:00:00.000Z" })).toMatchObject({ state: { deleted: false } });
    expect(stateAsOf([created, deleted], { clinicId: CLINIC, knownAt: "2026-09-09T00:00:00.000Z" })).toMatchObject({ state: { deleted: true } });
  });
});

describe("statesAsOf", () => {
  it("answers every record in record-id order, whatever the input order", () => {
    const a = [v("2026-09-01T09:00:00.000Z", {}, { entityId: "b", isCreation: true }), v("2026-09-01T10:00:00.000Z", { status: "no_show" }, { entityId: "a", isCreation: true })];
    const one = statesAsOf(a, { clinicId: CLINIC, knownAt: "2026-09-02T00:00:00.000Z" });
    const two = statesAsOf([...a].reverse(), { clinicId: CLINIC, knownAt: "2026-09-02T00:00:00.000Z" });
    expect([...one.keys()]).toEqual(["a", "b"]);
    expect([...two.entries()]).toEqual([...one.entries()]);
  });
});

describe("firstObservedTransition", () => {
  const completed = (s: Appt) => s.status === "completed";

  it("dates a result by when it was recorded, within the window, and only if it still stands", () => {
    const versions = [v("2026-09-01T09:00:00.000Z", {}, { isCreation: true }), v("2026-09-03T09:00:00.000Z", { status: "completed" })];
    expect(firstObservedTransition(versions, { clinicId: CLINIC, since: "2026-09-02T00:00:00.000Z", knownAt: "2026-09-04T00:00:00.000Z", enters: completed })?.recordedAt).toBe("2026-09-03T09:00:00.000Z");
    // Not yet recorded at the moment asked about.
    expect(firstObservedTransition(versions, { clinicId: CLINIC, since: "2026-09-02T00:00:00.000Z", knownAt: "2026-09-03T00:00:00.000Z", enters: completed })).toBeNull();
    // Recorded before the action it would confirm.
    expect(firstObservedTransition(versions, { clinicId: CLINIC, since: "2026-09-03T10:00:00.000Z", knownAt: "2026-09-04T00:00:00.000Z", enters: completed })).toBeNull();
    // Reversed by the moment asked about.
    const reopened = [...versions, v("2026-09-03T12:00:00.000Z", { status: "scheduled" })];
    expect(firstObservedTransition(reopened, { clinicId: CLINIC, since: "2026-09-02T00:00:00.000Z", knownAt: "2026-09-04T00:00:00.000Z", enters: completed })).toBeNull();
  });

  it("never takes a baseline for a transition: it records a state, not when it was reached", () => {
    const baseline = v("2026-09-05T00:00:00.000Z", { status: "completed" }, { provenance: HistoryProvenance.BASELINE, effectiveAt: null, effectiveAtBasis: EffectiveTimeBasis.UNKNOWN });
    expect(firstObservedTransition([baseline], { clinicId: CLINIC, since: "2026-09-01T00:00:00.000Z", knownAt: "2026-09-06T00:00:00.000Z", enters: completed })).toBeNull();
  });
});

describe("historyCovers", () => {
  const captures = [
    { entity: "appointment" as const, capturedSince: "2026-09-13T17:54:53.000Z" },
    { entity: "payment" as const, capturedSince: "2026-09-13T17:54:53.000Z" },
  ];

  it("covers a moment only once every entity's capture had begun", () => {
    expect(historyCovers(captures, ["appointment", "payment"], "2026-09-14T00:00:00.000Z")).toEqual({ covered: true, uncovered: [] });
    expect(historyCovers(captures, ["appointment", "payment"], "2026-09-13T17:54:52.999Z")).toEqual({ covered: false, uncovered: ["appointment", "payment"] });
    expect(historyCovers(captures, ["follow_up", "appointment"], "2026-09-14T00:00:00.000Z")).toEqual({ covered: false, uncovered: ["follow_up"] });
  });
});
