/**
 * lib/__tests__/clinical-columns.spec.ts
 *
 * Keeps the Data API column lists and the database grant in agreement.
 *
 * WHY BOTH HALVES MATTER
 *   20260907000100 withholds the clinical free-text columns from `anon` and
 *   `authenticated`, because Postgres has no per-user column security: RLS is
 *   row-level, and a dentist, a receptionist and a patient all arrive as the
 *   same database role. A column GRANT is the only mechanism that can express
 *   "not through the Data API at all".
 *
 *   A table-level grant subsumes column grants, so the fix had to revoke the
 *   table grant and re-grant column by column. That makes `select *` fail for
 *   every role, which is why lib/appointments/data-api-columns.ts exists.
 *
 *   Those two things can drift apart in both directions, and each direction is
 *   its own bug:
 *
 *     - a withheld column that creeps back into the TS list produces a runtime
 *       "permission denied for table" on a page that used to work;
 *     - a clinical column added later and quietly added to the list is exactly
 *       the leak the migration closed.
 *
 *   This spec needs no database: it reads both files and compares them.
 *   actions/__tests__/view-security-invoker.spec.ts covers the runtime half.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  APPOINTMENT_COLUMNS,
  TREATMENT_COLUMNS,
  APPOINTMENT_SELECT,
  TREATMENT_SELECT,
  WITHHELD_APPOINTMENT_COLUMNS,
  WITHHELD_TREATMENT_COLUMNS,
} from "@/lib/appointments/data-api-columns";
import {
  PATIENT_SAFE_APPOINTMENT_COLUMNS,
  CLINICAL_APPOINTMENT_COLUMNS,
} from "@/lib/appointments/patient-safe-columns";

const MIGRATION = readFileSync(
  path.join(
    process.cwd(),
    "supabase",
    "migrations",
    "20260907000100_restrict_clinical_columns.sql"
  ),
  "utf8"
);

describe("clinical column withholding", () => {
  it("never lists a withheld appointment column as readable", () => {
    for (const col of WITHHELD_APPOINTMENT_COLUMNS) {
      expect(
        (APPOINTMENT_COLUMNS as readonly string[]).includes(col),
        `${col} is withheld from authenticated by 20260907000100 — selecting it ` +
          `would fail at runtime for every role, including the dentist`
      ).toBe(false);
    }
  });

  it("never lists internal_notes as readable", () => {
    for (const col of WITHHELD_TREATMENT_COLUMNS) {
      expect((TREATMENT_COLUMNS as readonly string[]).includes(col)).toBe(false);
    }
  });

  it("withholds exactly the columns the migration names", () => {
    // The migration's DO block is the source of truth for what the database
    // does. If someone edits one side only, this is where it shows up.
    const named = /column_name not in \(([\s\S]*?)\)/.exec(MIGRATION)?.[1] ?? "";
    const inMigration = [...named.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();

    expect(inMigration).toEqual([...WITHHELD_APPOINTMENT_COLUMNS].sort());
    expect(MIGRATION).toContain("column_name <> 'internal_notes'");
  });

  it("agrees with the patient-safe list about what is clinical", () => {
    // patient-safe-columns.ts predates this work and already classified these.
    // The two must not disagree about which columns are clinical, or a reader
    // has to guess which file is authoritative.
    for (const col of WITHHELD_APPOINTMENT_COLUMNS) {
      expect(
        (CLINICAL_APPOINTMENT_COLUMNS as readonly string[]).includes(col),
        `${col} is withheld but not declared clinical in patient-safe-columns.ts`
      ).toBe(true);
    }
  });

  it("keeps every patient-safe column readable", () => {
    // The portal reads these. If the grant ever stopped covering one, the whole
    // portal appointment list would fail rather than degrade.
    for (const col of PATIENT_SAFE_APPOINTMENT_COLUMNS) {
      expect(
        (APPOINTMENT_COLUMNS as readonly string[]).includes(col),
        `${col} is patient-safe but missing from APPOINTMENT_COLUMNS`
      ).toBe(true);
    }
  });

  it("builds select strings with no wildcard", () => {
    // The whole point is that `*` no longer works. A `*` sneaking into either
    // constant would fail at runtime on every read.
    expect(APPOINTMENT_SELECT).not.toContain("*");
    expect(TREATMENT_SELECT).not.toContain("*");
    expect(APPOINTMENT_SELECT.split(", ")).toEqual([...APPOINTMENT_COLUMNS]);
    expect(TREATMENT_SELECT.split(", ")).toEqual([...TREATMENT_COLUMNS]);
  });

  it("keeps the projections read-only", () => {
    // A simple view over one table is auto-updatable, so the DO INSTEAD NOTHING
    // rules are what stop the projections becoming a write path around the base
    // table's UPDATE policies.
    for (const view of ["treatment_clinical_notes", "appointment_clinical_notes"]) {
      for (const op of ["insert", "update", "delete"]) {
        expect(
          MIGRATION,
          `${view} must refuse ${op}`
        ).toContain(`on ${op} to ${view} do instead nothing`);
      }
    }
  });

  it("scopes each projection by clinic AND role", () => {
    // A definer view with no predicate of its own is the 20260902155414 defect.
    // These must carry both halves of their authorisation.
    expect(MIGRATION).toContain("and t.clinic_id = auth_clinic_id()");
    expect(MIGRATION).toContain("and auth_role() = 'dentist'");
    expect(MIGRATION).toContain("and a.clinic_id = auth_clinic_id()");
    expect(MIGRATION).toContain("and auth_role() in ('dentist', 'receptionist')");
  });
});
