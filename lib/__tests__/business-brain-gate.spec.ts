/**
 * The Business Brain must not be reachable by the live pilot clinic.
 *
 * Everything else in this codebase can be fixed forward. This cannot: a dentist
 * seeing an unfinished analysis of their own practice is a trust failure, not a
 * bug report, and no later correction unsees it.
 *
 * The allow-list itself is asserted in dashboard-view.spec.ts. This file guards
 * the thing a unit test on the list cannot: that every ROUTE INTO the feature
 * actually consults it. A perfectly correct allow-list protects nothing if a new
 * page, action or endpoint forgets to ask.
 *
 * So this reads the source. It is unusual for a test, and it is the only way to
 * assert a property about code that has not been written yet.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  BUSINESS_BRAIN_CLINIC_IDS,
  DEMO_CLINIC_IDS,
  isBusinessBrainEnabled,
  isDemoClinic,
} from "@/lib/feature-flags";

const DEV_CLINIC = "00000000-0000-0000-0000-000000000001";
const SAMPLE_DATA_CLINIC = "d0000000-0000-4000-8000-0000000000d0";
const PILOT_CLINIC = "11111111-1111-1111-1111-111111111111";
const CLINIC_B = "22222222-2222-2222-2222-222222222222";

/** Files that reach the Business Brain and therefore must gate on the clinic. */
const GATED_ENTRY_POINTS = [
  "app/(dashboard)/dentist/business-brain/page.tsx",
  "app/(dashboard)/layout.tsx",
  "actions/business-brain.ts",
  "app/api/cron/metric-history/route.ts",
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("the pilot clinic can never reach the Business Brain", () => {
  it("refuses the pilot clinic and every other clinic", () => {
    expect(isBusinessBrainEnabled(PILOT_CLINIC)).toBe(false);
    expect(isBusinessBrainEnabled(CLINIC_B)).toBe(false);
    expect(isBusinessBrainEnabled(DEV_CLINIC)).toBe(true);
    expect(isBusinessBrainEnabled(SAMPLE_DATA_CLINIC)).toBe(true);
  });

  it("fails CLOSED for a missing or empty clinic", () => {
    // A session that lost its clinic must see nothing, not everything.
    expect(isBusinessBrainEnabled(null)).toBe(false);
    expect(isBusinessBrainEnabled(undefined)).toBe(false);
    expect(isBusinessBrainEnabled("")).toBe(false);
  });

  it("lists only clinics that are not a real practice", () => {
    // The guarantee is not the LENGTH of the list — it is that no clinic on it
    // sees an unfinished analysis of its own real practice. The development
    // clinic and the generated sample-data clinic both qualify; a pilot clinic
    // never can.
    expect(BUSINESS_BRAIN_CLINIC_IDS).toEqual([DEV_CLINIC, SAMPLE_DATA_CLINIC]);
    expect(BUSINESS_BRAIN_CLINIC_IDS).not.toContain(PILOT_CLINIC);
    expect(BUSINESS_BRAIN_CLINIC_IDS).not.toContain(CLINIC_B);
  });

  it("labels the generated clinic as sample data, and no real clinic as demo", () => {
    // The briefing renders a "sample data" notice from this, so a generated
    // figure can never be read as a clinic's own.
    expect(isDemoClinic(SAMPLE_DATA_CLINIC)).toBe(true);
    expect(DEMO_CLINIC_IDS).toEqual([SAMPLE_DATA_CLINIC]);
    for (const real of [PILOT_CLINIC, CLINIC_B, DEV_CLINIC]) {
      expect(isDemoClinic(real)).toBe(false);
    }
    expect(isDemoClinic(null)).toBe(false);
  });

  it("gates every known entry point on the clinic", () => {
    // A route that renders the Brain without asking is the whole failure mode.
    const ungated = GATED_ENTRY_POINTS.filter((path) => {
      const source = readFileSync(path, "utf8");
      return (
        !source.includes("isBusinessBrainEnabled") &&
        !source.includes("BUSINESS_BRAIN_CLINIC_IDS")
      );
    });
    expect(ungated, "entry point does not consult the clinic allow-list").toEqual([]);
  });

  it("has no OTHER route reaching the Brain without gating", () => {
    // Catches a page or action added later that imports the pipeline and forgets
    // the gate — the failure a fixed list of entry points cannot see coming.
    const offenders: string[] = [];
    for (const root of ["app", "actions"]) {
      for (const file of sourceFiles(root)) {
        const source = readFileSync(file, "utf8");
        const reachesBrain =
          source.includes("runDashboardBrain") ||
          source.includes("runBusinessBrain") ||
          source.includes("persistMetricRange") ||
          source.includes("persistMetricDay") ||
          // The briefing projection is Business Brain output too. A page that
          // renders it has rendered the Brain, whether or not it ran the
          // pipeline itself, so it needs the same gate.
          source.includes("buildBriefing") ||
          source.includes("buildActionPlanViews");
        if (!reachesBrain) continue;
        if (
          !source.includes("isBusinessBrainEnabled") &&
          !source.includes("BUSINESS_BRAIN_CLINIC_IDS")
        ) {
          offenders.push(file);
        }
      }
    }
    expect(offenders, "reaches the Business Brain without checking the clinic").toEqual([]);
  });

  it("finds the entry points it is supposed to be checking", () => {
    // Without this the scan above could pass by matching nothing at all — the
    // failure mode of every codebase-scanning test.
    let reaching = 0;
    for (const root of ["app", "actions"]) {
      for (const file of sourceFiles(root)) {
        const source = readFileSync(file, "utf8");
        if (source.includes("runDashboardBrain") || source.includes("runBusinessBrain")) {
          reaching += 1;
        }
      }
    }
    expect(reaching).toBeGreaterThan(0);
  });

  it("renders prepared actions from exactly one gated page", () => {
    // Named explicitly, so surfacing the briefing on a second page has to be a
    // deliberate edit here rather than a quiet copy-paste.
    //
    // Keyed on buildBriefing, the projection the redesigned Morning Briefing is
    // built from — the load-bearing marker that a page renders the Brain's
    // problems and prepared actions. A component-name scan would pass vacuously
    // the moment the component was renamed, which is how the previous version of
    // this test went blind.
    const rendering: string[] = [];
    for (const root of ["app"]) {
      for (const file of sourceFiles(root)) {
        if (readFileSync(file, "utf8").includes("buildBriefing")) rendering.push(file);
      }
    }
    expect(rendering.map((f) => f.replace(/\\/g, "/"))).toEqual([
      "app/(dashboard)/dentist/business-brain/page.tsx",
    ]);
  });
});
