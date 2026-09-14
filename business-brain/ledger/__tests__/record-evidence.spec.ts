import { describe, expect, it } from "vitest";

import {
  CLICKED_THROUGH_MAX_SECONDS,
  arrivalRecorded,
  canonicalTreatmentType,
  cancellationSide,
  groupableTreatmentType,
  isClickedThroughVisit,
  isConsultationOnly,
  isUnresolvedVisit,
  noShowBasis,
  treatmentPerformedAt,
  treatmentTypeKey,
} from "../record-evidence";

describe("noShowBasis", () => {
  const mark = (at: string, byPerson: boolean | null) => ({ statusAfter: "no_show", at, byPerson });

  it("tells an inferred no-show from a recorded one by its latest mark", () => {
    expect(noShowBasis([mark("2026-09-10T00:05:00Z", false)])).toBe("inferred");
    expect(noShowBasis([mark("2026-09-10T00:05:00Z", true)])).toBe("recorded");
    expect(noShowBasis([mark("2026-09-10T00:05:00Z", false), mark("2026-09-11T09:00:00Z", true)])).toBe("recorded");
  });

  it("is unknown without evidence — never assumed either way", () => {
    expect(noShowBasis([])).toBe("unknown");
    expect(noShowBasis([{ statusAfter: "cancelled", at: "2026-09-10T00:00:00Z", byPerson: true }])).toBe("unknown");
    expect(noShowBasis([mark("2026-09-10T00:05:00Z", null)])).toBe("unknown");
  });
});

describe("cancellationSide", () => {
  it("is the patient's when made from the patient's account", () => {
    expect(cancellationSide({ actorRole: "patient", onClosedDay: false })).toBe("patient");
    expect(cancellationSide({ actorRole: "patient", onClosedDay: true })).toBe("patient");
  });

  it("is the clinic's when staff cancelled on a day the clinic had closed", () => {
    expect(cancellationSide({ actorRole: "receptionist", onClosedDay: true })).toBe("clinic");
    expect(cancellationSide({ actorRole: "dentist", onClosedDay: true })).toBe("clinic");
  });

  it("is unknown otherwise: staff record both kinds, and no actor says nothing", () => {
    expect(cancellationSide({ actorRole: "receptionist", onClosedDay: false })).toBe("unknown");
    expect(cancellationSide({ actorRole: null, onClosedDay: true })).toBe("unknown");
    expect(cancellationSide({ actorRole: null, onClosedDay: false })).toBe("unknown");
  });
});

describe("clicked-through visits", () => {
  const checkedInAt = "2026-09-14T10:00:00.000Z";
  const plus = (s: number) => new Date(Date.parse(checkedInAt) + s * 1000).toISOString();

  it("fingerprints a completion within a minute of check-in with no call-in", () => {
    expect(isClickedThroughVisit({ checkedInAt, calledAt: null, completedAt: plus(2) })).toBe(true);
    expect(isClickedThroughVisit({ checkedInAt, calledAt: null, completedAt: plus(CLICKED_THROUGH_MAX_SECONDS - 1) })).toBe(true);
    expect(arrivalRecorded({ checkedInAt, calledAt: null, completedAt: plus(2) })).toBe(false);
  });

  it("leaves real visits alone", () => {
    expect(isClickedThroughVisit({ checkedInAt, calledAt: plus(1), completedAt: plus(2) })).toBe(false);
    expect(isClickedThroughVisit({ checkedInAt, calledAt: null, completedAt: plus(CLICKED_THROUGH_MAX_SECONDS) })).toBe(false);
    expect(isClickedThroughVisit({ checkedInAt, calledAt: null, completedAt: null })).toBe(false);
    expect(isClickedThroughVisit({ checkedInAt, calledAt: null, completedAt: plus(-5) })).toBe(false);
    expect(arrivalRecorded({ checkedInAt, calledAt: null, completedAt: null })).toBe(true);
  });
});

describe("isUnresolvedVisit", () => {
  it("is a visit still open after its own day", () => {
    expect(isUnresolvedVisit("checked_in", "2026-09-13", "2026-09-14")).toBe(true);
    expect(isUnresolvedVisit("in_progress", "2026-09-13", "2026-09-14")).toBe(true);
  });

  it("is not today's open visit, nor any closed or unarrived one", () => {
    expect(isUnresolvedVisit("checked_in", "2026-09-14", "2026-09-14")).toBe(false);
    for (const status of ["scheduled", "completed", "cancelled", "no_show"]) {
      expect(isUnresolvedVisit(status, "2026-09-01", "2026-09-14")).toBe(false);
    }
  });
});

describe("treatmentPerformedAt", () => {
  it("prefers performed_at, falls back to the recorded completion and says so, else unknown", () => {
    expect(treatmentPerformedAt({ performedAt: "2026-09-01T05:00:00Z", completionRecordedAt: "2026-09-03T05:00:00Z" })).toEqual({ at: "2026-09-01T05:00:00Z", basis: "performed_at" });
    expect(treatmentPerformedAt({ performedAt: null, completionRecordedAt: "2026-09-03T05:00:00Z" })).toEqual({ at: "2026-09-03T05:00:00Z", basis: "recorded" });
    expect(treatmentPerformedAt({ performedAt: null, completionRecordedAt: null })).toEqual({ at: null, basis: "unknown" });
  });
});

describe("treatment types", () => {
  it("folds spellings of one type together", () => {
    for (const raw of ["Root Canal", "root_canal", " root canal ", "ROOT-CANAL", "RCT", "Root Canal Treatment"]) {
      expect({ raw, key: treatmentTypeKey(raw) }).toEqual({ raw, key: "root_canal" });
    }
    expect(treatmentTypeKey("Crown Placement")).toBe(treatmentTypeKey("crown"));
    expect(canonicalTreatmentType("crown_placement")).toBe("Crown");
  });

  it("does not merge different treatments", () => {
    expect(treatmentTypeKey("Cleaning")).not.toBe(treatmentTypeKey("Scaling"));
    expect(treatmentTypeKey("Filling")).not.toBe(treatmentTypeKey("Extraction"));
  });

  it("excludes a consultation (OPD) record from treatment-type groupings", () => {
    for (const raw of ["Consultation", "consultation", "OPD", "OPD Consultation"]) {
      expect({ raw, only: isConsultationOnly(raw), group: groupableTreatmentType(raw) }).toEqual({ raw, only: true, group: null });
    }
    expect(groupableTreatmentType("  ")).toBeNull();
    expect(groupableTreatmentType(null)).toBeNull();
    expect(groupableTreatmentType("root_canal")).toBe("Root Canal");
  });
});
