/**
 * actions/__tests__/patient-cascade-completeness.spec.ts
 *
 * The patient deletion cascade must cover every table that holds the patient's
 * data — and the way that stops being true is not a bug in the cascade, it is a
 * NEW TABLE added six months later by someone who never read softDeletePatient.
 *
 * So this does not test the cascade's behaviour (the integration specs and the
 * database do that). It reads the migrations, finds every table with a foreign
 * key to `patients`, and asserts that softDeletePatient either handles it or
 * that this file says in writing why it does not. Adding a patient-scoped table
 * fails this test until someone makes that decision on purpose.
 *
 * The same trick lib/__tests__/business-brain-gate.spec.ts uses, for the same
 * reason: it is the only way to assert a property about code not yet written.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const MIGRATIONS = join(ROOT, "supabase/migrations");

/**
 * Tables that reference `patients` but are deliberately NOT touched by the
 * cascade. Each entry is a decision, and the reason is the entry's whole value.
 */
const EXEMPT: Record<string, string> = {
  patients:
    "The patient row itself — soft-deleted last, after everything that points at it.",
  tooth_history:
    "Audit trail for the dental chart, reached through patient_teeth rather than " +
    "directly. It is append-only evidence of who changed a chart and when; " +
    "erasing it on deletion would destroy the record of the edits, not the chart. " +
    "Cleared by the retention purge under a policy instead.",
  appointment_history:
    "Append-only audit of appointment changes. Same reasoning as tooth_history.",
  consent_audit:
    "Append-only audit of consent actions. Deleting it would destroy the proof " +
    "that a consent was given and later withdrawn, which is the only thing it is for.",
  treatment_history:
    "Append-only audit of treatment edits. Same reasoning.",
  patient_state_history:
    "Append-only, trigger-written versions of the record's existence, deletion and " +
    "payment plan (migration 20260917100000) — no name, contact or clinical field. " +
    "The soft delete itself is captured as a new version by trigger; erasing the " +
    "versions would let a deletion rewrite what the clinic's records said before it.",
  phi_access_log:
    "The record of who READ this patient's data. Removing it on deletion would " +
    "mean a deletion could erase the evidence of prior access — precisely " +
    "backwards. Its own trigger blocks deletion outside a retention purge.",
  data_consent_records:
    "The consent ledger. Destroying it would destroy the answer to 'was this " +
    "lawful at the time', which outlives the operational record.",
  patient_portal_links:
    "Hard-deleted by the cascade so the auth account is cleanly unlinked — " +
    "handled, but by removal rather than by a deleted_at column.",
};

function migrationSource(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
    .join("\n");
}

/**
 * Every table with a column declared `references patients (id)`.
 *
 * Found by walking each `create table <name> ( ... )` block and looking for the
 * reference inside it. Crude, and adequate: this schema declares its foreign
 * keys inline, and a table that declared one differently would simply not be
 * found — which surfaces as this test's own list looking wrong, not as a silent
 * pass, because the known tables below are asserted to be present.
 */
function tablesReferencingPatients(sql: string): Set<string> {
  const found = new Set<string>();
  const createTable = /create\s+table\s+(?:if\s+not\s+exists\s+)?(\w+)\s*\(/gi;

  let match: RegExpExecArray | null;
  while ((match = createTable.exec(sql)) !== null) {
    const table = match[1];
    // Take the body up to the next `create ` statement — good enough to stay
    // inside one table's column list.
    const rest = sql.slice(match.index + match[0].length);
    const end = rest.search(/\n\s*(create|alter|comment)\s/i);
    const body = end === -1 ? rest : rest.slice(0, end);

    if (/references\s+patients\s*\(\s*id\s*\)/i.test(body)) found.add(table);
  }

  // Columns added later by ALTER also create the relationship.
  const alterAdd =
    /alter\s+table\s+(\w+)[\s\S]{0,400}?references\s+patients\s*\(\s*id\s*\)/gi;
  while ((match = alterAdd.exec(sql)) !== null) found.add(match[1]);

  return found;
}

const SQL = migrationSource();
const REFERENCING = tablesReferencingPatients(SQL);
const CASCADE_SOURCE = readFileSync(join(ROOT, "actions/patients.ts"), "utf8");

/** The body of softDeletePatient, so an unrelated mention elsewhere doesn't count. */
function cascadeBody(): string {
  const start = CASCADE_SOURCE.indexOf("export async function softDeletePatient");
  expect(start).toBeGreaterThan(-1);
  const end = CASCADE_SOURCE.indexOf("export async function", start + 10);
  return CASCADE_SOURCE.slice(start, end === -1 ? undefined : end);
}

describe("patient deletion cascade", () => {
  const body = cascadeBody();

  it("finds the patient-scoped tables it is meant to be checking", () => {
    // Guards the parser: if this ever returns an empty or tiny set, every
    // assertion below would pass vacuously.
    expect(REFERENCING.size).toBeGreaterThanOrEqual(8);
    for (const known of ["appointments", "treatments", "payments", "follow_ups"]) {
      expect(REFERENCING).toContain(known);
    }
  });

  it("handles every table that holds this patient's data, or says why not", () => {
    const unhandled = [...REFERENCING].filter((table) => {
      if (table in EXEMPT) return false;
      return !new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)`).test(body);
    });

    expect(
      unhandled,
      `softDeletePatient does not touch these patient-scoped tables. Either ` +
        `handle them in the cascade, or add them to EXEMPT in this file with ` +
        `the reason.`
    ).toEqual([]);
  });

  it("covers the four that were missing before this was written", () => {
    // A named regression: a "deleted" patient used to keep a live dental chart,
    // live radiographs, live signed consents carrying their signature, and
    // reminder records whose `kind` leaks clinical context.
    for (const table of [
      "patient_teeth",
      "treatment_documents",
      "consents",
      "reminder_logs",
    ]) {
      expect(body).toMatch(new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)`));
    }
  });

  it("never hard-deletes a clinical record", () => {
    // Soft delete is the rule; the two hard deletes are queue entries (live
    // operational state, no soft-delete column) and reminder/portal-link rows.
    const hardDeleted = [...body.matchAll(/\.from\(\s*["'`](\w+)["'`]\s*\)[\s\S]{0,200}?\.delete\(/g)]
      .map((m) => m[1]);

    expect(hardDeleted.sort()).toEqual(
      ["patient_portal_links", "queue_entries", "reminder_logs"].sort()
    );
  });

  it("scopes every cascade write to the caller's own clinic", () => {
    // A cascade that matched on patient_id alone would be a cross-tenant write
    // primitive, because it runs on the service role and bypasses RLS.
    const writes = [...body.matchAll(/\.from\(\s*["'`](\w+)["'`]\s*\)([\s\S]{0,400}?);/g)];
    expect(writes.length).toBeGreaterThan(5);

    for (const [, table, chain] of writes) {
      // patient_portal_links has no clinic_id column — it is scoped through
      // patients.clinic_id by design (CLAUDE.md §10).
      if (table === "patient_portal_links") continue;
      expect(chain, `${table} cascade write is not clinic-scoped`).toContain(
        '.eq("clinic_id", cid)'
      );
    }
  });
});
