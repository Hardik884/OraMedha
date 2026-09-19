/**
 * lib/__tests__/retention-scope.spec.ts
 *
 * The one thing about retention that must never quietly change: a scheduled
 * job, running unattended, must not be able to delete a clinical or audit
 * record.
 *
 * That property lives in SQL, in the explicit CASE inside run_retention_purge
 * (migration 20260903000500). A unit test cannot execute it without a database,
 * but it can read it — and reading it is enough to catch the change that would
 * actually happen: someone adds a policy row and a matching `delete from
 * treatments` branch because it seemed symmetrical with the others.
 *
 * So this parses the migration and asserts what the function is allowed to
 * delete from. It is a blunt instrument and it is aimed at exactly the right
 * thing.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS = join(process.cwd(), "supabase/migrations");

/**
 * The migration that defines the purge AS IT STANDS — the last one to replace
 * it, not the one that introduced it.
 *
 * This file used to read `*_retention_policies.sql` by name, which was correct
 * exactly until the function was replaced somewhere else. From that moment it
 * would have gone on checking a body Postgres no longer runs, and passed: a test
 * pinned to the wrong file is worse than no test, because it reports safety it
 * did not check.
 */
const DEFINING_MIGRATION = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .reverse()
  .find((f) =>
    readFileSync(join(MIGRATIONS, f), "utf8").includes(
      "create or replace function run_retention_purge",
    ),
  );

const SQL = DEFINING_MIGRATION
  ? readFileSync(join(MIGRATIONS, DEFINING_MIGRATION), "utf8")
  : "";

/** Every migration's SQL, for the claims that are about the whole history. */
const ALL_SQL = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
  .join("\n");

/** The body of run_retention_purge, so policy INSERTs elsewhere do not count. */
function purgeFunctionBody(): string {
  const start = SQL.indexOf("create or replace function run_retention_purge");
  expect(start, "run_retention_purge not found").toBeGreaterThan(-1);
  const end = SQL.indexOf("$$;", start);
  return SQL.slice(start, end);
}

/** Every table the function issues a DELETE against. */
function deletedTables(body: string): string[] {
  return [...body.matchAll(/delete\s+from\s+(\w+)/gi)].map((m) => m[1].toLowerCase());
}

describe("the retention job's reach", () => {
  const body = purgeFunctionBody();
  const tables = deletedTables(body);

  it("deletes from something — otherwise this whole file is vacuous", () => {
    expect(tables.length).toBeGreaterThan(0);
  });

  it("deletes ONLY from operational tables", () => {
    const permitted = new Set([
      "queue_entries",
      "reminder_logs",
      "webhook_logs",
      "metric_history",
      "problem_dismissals",
      "phi_access_log",
      // The Business Brain's own operational tables, added by
      // 20260919100100_business_brain_retention.sql. Each one grows every day
      // and none of them is a record of care.
      "metric_observations",
      "finding_snapshots",
      "clinic_memory_builds",
      "action_completions",
      "finding_feedback",
      "job_runs",
    ]);

    for (const table of tables) {
      expect(
        permitted.has(table),
        `run_retention_purge deletes from "${table}". If that is genuinely ` +
          `intended, it needs a deliberate decision and this list needs updating ` +
          `— it is not a formality.`
      ).toBe(true);
    }
  });

  const CLINICAL_AND_AUDIT = [
    // The state-history tables are here, with the clinical records rather than
    // with the logs, on purpose. They are what "what was known at T" is
    // reconstructed FROM: purging one would not shrink a log, it would quietly
    // change the answer to a question about the past while the answers kept
    // being produced from what survived.
    "appointment_status_history",
    "treatment_status_history",
    "follow_up_status_history",
    "payment_state_history",
    "patient_state_history",
    "patients",
    "appointments",
    "treatments",
    "payments",
    "follow_ups",
    "consents",
    "patient_teeth",
    "tooth_history",
    "appointment_history",
    "consent_audit",
    "treatment_history",
    "data_consent_records",
    "data_consent_notices",
    "patient_portal_links",
    "profiles",
    "clinics",
  ];

  for (const table of CLINICAL_AND_AUDIT) {
    it(`never deletes from ${table}`, () => {
      expect(tables).not.toContain(table);
    });
  }

  it("uses an explicit CASE rather than SQL built from a policy key", () => {
    // The structural reason a new policy row cannot cause a new deletion: the
    // set of reachable tables is fixed at migration time. Dynamic SQL would
    // move that decision into data, where it is not reviewed.
    expect(body).toMatch(/case\s+policy\.key/i);
    expect(body).not.toMatch(/\bexecute\s+format\b/i);
    expect(body).not.toMatch(/\bexecute\s+'/i);
  });
});

describe("the purge defaults to counting", () => {
  it("declares p_dry_run default true", () => {
    expect(SQL).toMatch(/run_retention_purge\s*\(\s*p_dry_run\s+boolean\s+default\s+true\s*\)/i);
  });

  it("is not executable from a browser session", () => {
    expect(SQL).toMatch(
      /revoke\s+all\s+on\s+function\s+run_retention_purge\(boolean\)\s+from\s+anon,\s*authenticated/i
    );
  });
});

describe("the policy table is honest about what its numbers are", () => {
  it("ships every period as legally unconfirmed", () => {
    // The default is false and no INSERT anywhere overrides it. If one ever
    // does, that is a claim about the law being made by a migration.
    expect(ALL_SQL).toMatch(/legally_confirmed\s+boolean\s+not\s+null\s+default\s+false/i);

    for (const block of ALL_SQL.split("insert into retention_policies").slice(1)) {
      expect(block.slice(0, block.indexOf(";"))).not.toMatch(/legally_confirmed/);
    }
  });

  it("defines no policy for any clinical, audit or state-history table", () => {
    // Across EVERY migration, not only the one that happens to define the
    // function: a policy row added later is exactly how a forbidden table would
    // acquire a window, and the row is what a reader would find first.
    const forbidden = [
      "patients",
      "treatments",
      "appointments",
      "consents",
      "appointment_history",
      "consent_audit",
      "treatment_history",
      "data_consent_records",
      "appointment_status_history",
      "treatment_status_history",
      "follow_up_status_history",
      "payment_state_history",
      "patient_state_history",
    ];
    for (const block of ALL_SQL.split("insert into retention_policies").slice(1)) {
      const policies = block.slice(0, block.indexOf("on conflict") + 1 || block.length);
      for (const table of forbidden) {
        expect(
          policies,
          `a retention policy is declared for "${table}", which must never have one`,
        ).not.toContain(`('${table}'`);
      }
    }
  });
});
