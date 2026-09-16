import { describe, expect, it } from "vitest";

import { followUpStatusChangeError } from "../status-rules";

describe("followUpStatusChangeError", () => {
  it("lets the dentist complete or cancel a pending follow-up", () => {
    expect(followUpStatusChangeError("dentist", "pending", "completed")).toBeNull();
    expect(followUpStatusChangeError("dentist", "pending", "cancelled")).toBeNull();
  });

  it("refuses a receptionist or patient closing a follow-up by editing it", () => {
    for (const role of ["receptionist", "patient"]) {
      expect(followUpStatusChangeError(role, "pending", "completed")).toMatch(/only the dentist/i);
      expect(followUpStatusChangeError(role, "pending", "cancelled")).toMatch(/only the dentist/i);
    }
  });

  it("never reopens or changes a closed follow-up, even for the dentist", () => {
    for (const role of ["dentist", "receptionist"]) {
      expect(followUpStatusChangeError(role, "completed", "pending")).toMatch(/cannot be reopened/);
      expect(followUpStatusChangeError(role, "cancelled", "pending")).toMatch(/cannot be reopened/);
      expect(followUpStatusChangeError(role, "completed", "cancelled")).toMatch(/cannot be reopened/);
      expect(followUpStatusChangeError(role, "cancelled", "completed")).toMatch(/cannot be reopened/);
    }
  });

  it("treats an unchanged status as no change at all", () => {
    expect(followUpStatusChangeError("receptionist", "completed", "completed")).toBeNull();
  });
});
