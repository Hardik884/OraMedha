/**
 * Source-level guards for two finalized-UI fixes that have no server surface to
 * test through:
 *
 *   - the treatment field shown in the patient portal says so, and the staff-only
 *     patient notes keep their own label;
 *   - "Mark as Complete" is ONE transition to completed. It used to walk the
 *     lifecycle (check-in → in progress → completed), inventing an arrival and a
 *     call-in at the moment of the click.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
const source = (p: string) => readFileSync(join(root, p), "utf8");

describe("patient-visible notes label", () => {
  const PORTAL_LABEL = "Notes for patient (shown in portal)";

  it("labels the portal-visible treatment notes as shown to the patient", () => {
    for (const file of [
      "components/dentist/TreatmentForm.tsx",
      "components/dentist/TreatmentDetailModal.tsx",
      "app/(dashboard)/dentist/treatments/[id]/page.tsx",
    ]) {
      const s = source(file);
      expect({ file, labelled: s.includes(PORTAL_LABEL) }).toEqual({ file, labelled: true });
      expect({ file, stale: />\s*Clinical Notes\s*</.test(s) }).toEqual({ file, stale: false });
    }
  });

  it("leaves the staff-only patient notes label alone", () => {
    const patientForm = source("components/shared/PatientForm.tsx");
    expect(patientForm).toContain("Clinical Notes");
    expect(patientForm).not.toContain(PORTAL_LABEL);
  });
});

describe("Mark as Complete", () => {
  const control = source("components/dentist/AppointmentCompleteControl.tsx");

  it("makes a single transition straight to completed", () => {
    const calls = control.match(/updateAppointmentStatus\(/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(control).toMatch(/new_status:\s*"completed"/);
    expect(control).not.toMatch(/new_status:\s*"(checked_in|in_progress)"/);
    expect(control).not.toMatch(/COMPLETION_PATH/);
  });
});
