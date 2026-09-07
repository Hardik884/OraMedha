/**
 * lib/__tests__/no-select-star-on-restricted-tables.spec.ts
 *
 * Fails when any Data API query asks `treatments` or `appointments` for `*`.
 *
 * WHY THIS FILE EXISTS
 *   20260907000100 revokes table-wide SELECT on both tables and re-grants it
 *   column by column, minus the clinical free-text. A table-level grant is what
 *   makes `select *` resolve at all, so once it is gone:
 *
 *     select * from treatments;  →  permission denied for table treatments
 *
 *   It fails for EVERY role, the dentist included. There is no caller for whom
 *   `*` still works, which is why lib/appointments/data-api-columns.ts exists.
 *
 *   The migration shipped with the call sites converted — but not all of them.
 *   Three survived, and each one broke a page that had worked the day before:
 *
 *     getTreatmentsForPatient      → the patient profile's Treatments tab
 *     getAllTreatments             → the whole /dentist/treatments list
 *     getTreatmentsForAppointment  → "Failed to fetch treatments." on the
 *                                    appointment detail page, reported from
 *                                    production after the migration was pushed
 *
 *   All three were found by hand, one at a time, each after something visibly
 *   broke. lib/__tests__/clinical-columns.spec.ts already pins the column LISTS
 *   against the migration, but it says nothing about what the call sites
 *   actually ask for — which is the half that was wrong.
 *
 * WHY STATIC ANALYSIS AND NOT AN INTEGRATION TEST
 *   A Server Action cannot be invoked outside a real Next.js request (it
 *   resolves its session from request cookies — see vitest.config.ts), so there
 *   is no way to call these functions in a spec and watch them fail. What CAN
 *   be checked without a request is the text of the query itself, and that is
 *   sufficient here: `*` either appears in the select or it does not.
 *
 * WHAT IT UNDERSTANDS
 *   Both forms that have actually occurred in this repo:
 *     .select("*")                              — a literal
 *     .select("*, patients!inner(id, name)")    — a literal with an embed
 *     .select(selectFields)  where  selectFields = role === "dentist" ? "*" : …
 *                                               — a local variable holding it
 *
 *   The `active_*` views are deliberately NOT covered: 20260907000100 re-grants
 *   plain table-level SELECT on them and they no longer project the clinical
 *   columns, so `*` is correct there.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Tables whose column-level grants make `select("*")` fail for every role. */
const RESTRICTED_TABLES = ["treatments", "appointments"] as const;

const ROOTS = ["actions", "lib", "app", "components"];

function sourceFiles(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry) && !/\.spec\.tsx?$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * True when a chunk of source contains a PostgREST select string asking for
 * every column.
 *
 * Works on the CONTENTS of each string literal in `text`, not on the raw text.
 * The distinction matters: the form that actually shipped was
 *
 *   const selectFields = role === "dentist" ? "*" : "id, clinic_id, …";
 *
 * where the `*` is surrounded by quote characters. An earlier version of this
 * helper looked for `*` bounded by whitespace/comma/paren and therefore missed
 * exactly the bug it was written to catch — verified by reintroducing all three
 * known offenders and watching it pass.
 *
 * A literal asks for everything when any of its comma-separated terms is a bare
 * `*`. So `"*"` and `"*, patients!inner(id, name)"` are flagged, while
 * `"id, cost"`, `patient:patients(id, name)` and
 * `` `${TREATMENT_SELECT}, patients!inner(…)` `` are not.
 */
function asksForStar(text: string): boolean {
  const literals = text.match(/"[^"]*"|'[^']*'|`[^`]*`/g) ?? [];

  for (const literal of literals) {
    const body = literal
      .slice(1, -1)
      // `${TREATMENT_SELECT}, x` contributes no `*` of its own, and what the
      // constant holds is pinned by clinical-columns.spec.ts.
      .replace(/\$\{[^}]*\}/g, "");

    if (body.split(",").some((term) => term.trim() === "*")) return true;
  }
  return false;
}

/**
 * Every `.select(...)` argument applied to `table` in `src`.
 *
 * Walks forward from each `.from("<table>")` through the chained calls that
 * follow it, stopping at the end of the statement, and collects the select
 * argument. Identifiers are resolved against `const x = …` assignments in the
 * same file, which is how the ternary form was written.
 */
function selectArgumentsFor(
  src: string,
  table: string
): Array<{ line: number; text: string }> {
  const found: Array<{ line: number; text: string }> = [];
  const fromPattern = new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)`, "g");

  let match: RegExpExecArray | null;
  while ((match = fromPattern.exec(src)) !== null) {
    const line = src.slice(0, match.index).split("\n").length;
    // The chain runs until the statement ends. `;` is a reliable terminator in
    // this codebase; cap the window so a missing one cannot run away.
    const rest = src.slice(match.index, match.index + 2000);
    const statement = rest.split(";")[0];

    const selectAt = statement.indexOf(".select(");
    if (selectAt === -1) continue;

    /*
     * Everything from `.select(` to the end of the statement.
     *
     * NOT a balanced-paren parse, deliberately. The select argument itself
     * contains parentheses — `"*, patients!inner(id, name, phone)"` — so a
     * lazy `\.select\((.*?)\)` stops INSIDE the string literal and truncates
     * it past the point where the quotes still pair up. That is precisely how
     * an earlier version of this file failed to flag getAllTreatments while
     * flagging its two neighbours, which is why the window now runs to the end
     * of the statement instead.
     *
     * The cost is that filter arguments further down the chain are scanned
     * too. That is safe here: a bare `*` TERM only ever appears in a select
     * list, never in `.eq("clinic_id", …)`, `.is("deleted_at", null)` or
     * `.order("created_at", …)`.
     */
    const selectOnwards = statement.slice(selectAt);
    found.push({ line, text: selectOnwards });

    // An identifier argument (`\.select(selectFields)`) carries no literal of
    // its own, so resolve it to its assignment(s) in the same file.
    const identifierMatch = selectOnwards.match(/^\.select\(\s*([A-Za-z_$][\w$]*)\s*[,)]/);
    if (identifierMatch) {
      const assignment = new RegExp(
        `(?:const|let|var)\\s+${identifierMatch[1]}\\s*[:=][\\s\\S]{0,600}?;`,
        "g"
      );
      let assigned: RegExpExecArray | null;
      while ((assigned = assignment.exec(src)) !== null) {
        found.push({ line, text: assigned[0] });
      }
    }
  }
  return found;
}

const FILES = ROOTS.flatMap((r) => sourceFiles(path.join(process.cwd(), r)));

describe("no select(*) against column-restricted tables", () => {
  it("finds source files to scan", () => {
    // Guards the guard: a broken walk would make every assertion below vacuous.
    expect(FILES.length).toBeGreaterThan(50);
  });

  it.each(RESTRICTED_TABLES)(
    "no query asks %s for every column",
    (table) => {
      // A Set: one assignment can be reached from several `.from()` chains in
      // the same file, and reporting it three times only obscures the count.
      const offenders = new Set<string>();

      for (const file of FILES) {
        const src = readFileSync(file, "utf8");
        if (!src.includes(`.from("${table}")`) && !src.includes(`.from('${table}')`)) {
          continue;
        }
        for (const arg of selectArgumentsFor(src, table)) {
          if (asksForStar(arg.text)) {
            offenders.add(
              `  ${path.relative(process.cwd(), file)}:${arg.line}\n      ${arg.text
                .replace(/\s+/g, " ")
                .slice(0, 140)}`
            );
          }
        }
      }

      expect(
        [...offenders].sort(),
        offenders.size
          ? `These queries ask \`${table}\` for every column, which 20260907000100 ` +
              `made impossible for every role — the dentist included:\n\n` +
              [...offenders].sort().join("\n") +
              `\n\nUse ${table === "treatments" ? "TREATMENT_SELECT" : "APPOINTMENT_SELECT"} ` +
              `from lib/appointments/data-api-columns.ts instead. The clinical columns ` +
              `are read through the ${table === "treatments" ? "treatment" : "appointment"}_clinical_notes ` +
              `projection, or with the service-role client where the audit trail needs them.`
          : undefined
      ).toEqual([]);
    }
  );
});
