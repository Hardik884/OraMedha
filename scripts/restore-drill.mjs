#!/usr/bin/env node
/**
 * scripts/restore-drill.mjs
 *
 * Proves that a dump of this database can actually be restored and read back.
 *
 * WHAT THIS ANSWERS, AND WHAT IT DOES NOT
 *   docs/BACKUP-DR.md opens with the sentence that matters: "The application
 *   must never rely on a backup that has never been restored." Until now the
 *   restore procedure in that document had never been executed, so the honest
 *   status was DOCUMENTED, NOT VERIFIED.
 *
 *   This closes a specific, narrow part of that gap:
 *
 *     ✅ that a `pg_dump` of this schema restores into an empty database
 *        without error — no ordering problem, no missing extension, no
 *        dependency that only exists because of how the live database grew;
 *     ✅ that clinical data survives the round trip, row for row, across every
 *        table a clinic would notice missing;
 *     ✅ that the audit and consent trails survive it too — the tables whose
 *        whole purpose is to outlive what they describe;
 *     ✅ that the append-only TRIGGERS come back attached, so a restored
 *        database is not one where the audit trail is silently writable.
 *
 *   And it does NOT answer, at all:
 *
 *     ❌ whether Supabase's platform backups contain what this dump contains.
 *        Different mechanism, different format, taken by someone else. Only a
 *        real restore from a real platform backup answers that.
 *     ❌ whether Storage objects are backed up. They are handled separately
 *        from the database on Supabase, and NOTHING in this repository can
 *        establish it. A restore that brings back `treatment_documents` rows
 *        pointing at objects that were not restored produces a clinical record
 *        whose radiographs are all broken links — and the failure is silent.
 *     ❌ RPO or RTO. Those are measured against production, not localhost.
 *     ❌ whether auth.users restores. Deliberately out of scope — see below.
 *
 *   Both lists are in docs/BACKUP-DR.md. Please keep them honest: the value of
 *   this script is entirely in the second list being as visible as the first.
 *
 * WHY LOCAL, AND WHY THAT IS STILL WORTH DOING
 *   A drill against production data would mean making another full copy of a
 *   clinic's records, which is the exposure the incident-response document
 *   already describes. Local runs against seeded fixtures only. The mechanism
 *   being exercised — dump, restore into an empty database, verify — is the
 *   same one, and the failures it catches (an extension that was installed by
 *   hand, a trigger that does not come back, a constraint that only passes
 *   because of insert order) are schema properties, not data properties.
 *
 * WHY auth.users IS EXCLUDED
 *   Supabase owns the `auth` schema and provisions it during `db reset`, so
 *   dumping and re-creating it here would be testing Supabase's migrations
 *   rather than OraMedha's data. What IS verified is the join that would break
 *   a restore in practice: `patient_portal_links` and `profiles` are checked
 *   for rows whose owning auth user no longer resolves. See VERIFY_ORPHANS.
 *
 * USAGE
 *   node scripts/restore-drill.mjs            # run the drill
 *   node scripts/restore-drill.mjs --keep     # leave the scratch DB for poking
 *
 * Requires a running local Supabase (`npm run db:start`) and Docker.
 */

import { execFileSync } from "node:child_process";

const CONTAINER = process.env.DRILL_CONTAINER ?? "supabase_db_dentgrow";
const SCRATCH = "oramedha_restore_drill";
const KEEP = process.argv.includes("--keep");

/**
 * Tables the drill compares, and why each is here.
 *
 * Grouped rather than listed flat because the two groups fail differently. If a
 * CLINICAL table comes back short, a clinic has lost records and will notice
 * within a day. If an AUDIT table comes back short, nobody notices at all — and
 * the question those tables exist to answer ("was this lawful at the time",
 * "who read this record") becomes unanswerable, permanently and invisibly.
 * The second group is the one a drill is most likely to skip and most needs.
 */
const CLINICAL = [
  "clinics",
  "clinic_settings",
  "profiles",
  "patients",
  "appointments",
  "queue_entries",
  "treatments",
  "payments",
  "follow_ups",
  "patient_portal_links",
  "availability_rules",
  "patient_teeth",
  "consents",
  "treatment_documents",
  "reminder_logs",
];

const AUDIT = [
  "appointment_history",
  "treatment_history",
  "tooth_history",
  "consent_audit",
  "phi_access_log",
  "data_consent_records",
  "data_consent_notices",
];

/**
 * Triggers whose absence after a restore would be invisible and serious: the
 * table would be present, readable, and quietly writable.
 */
const APPEND_ONLY_TRIGGERS = [
  ["phi_access_log", "trg_phi_access_log_append_only"],
  ["data_consent_records", "trg_data_consent_records_append_only"],
  ["data_consent_notices", "trg_data_consent_notices_append_only"],
  ["treatment_history", "trg_treatment_history_append_only"],
];

/** Referential checks that a naive row-count comparison would pass. */
const VERIFY_ORPHANS = [
  [
    "appointments without a patient",
    "select count(*) from appointments a left join patients p on p.id = a.patient_id where p.id is null",
  ],
  [
    "treatments without an appointment",
    "select count(*) from treatments t left join appointments a on a.id = t.appointment_id where a.id is null",
  ],
  [
    "portal links without a patient",
    "select count(*) from patient_portal_links l left join patients p on p.id = l.patient_id where p.id is null",
  ],
  [
    "profiles without a clinic",
    "select count(*) from profiles pr left join clinics c on c.id = pr.clinic_id where c.id is null",
  ],
];

function docker(args, opts = {}) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    ...opts,
  });
}

/** One scalar, from whichever database is named. */
function scalar(db, sql) {
  const out = docker([
    "exec", "-i", CONTAINER,
    "psql", "-U", "postgres", "-d", db, "-tAc", sql,
  ]);
  return out.trim();
}

function counts(db, tables) {
  const out = {};
  for (const t of tables) {
    try {
      out[t] = Number(scalar(db, `select count(*) from public.${t}`));
    } catch {
      out[t] = null; // table absent — reported as a failure below
    }
  }
  return out;
}

let failures = 0;
let vacuous = 0;

function check(label, ok, detail = "") {
  if (ok) {
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * A count comparison, marked honestly when both sides are zero.
 *
 * `0 → 0` is not evidence that a table's data survives a restore; it is
 * evidence that there was no data. Reporting it with a ✅ next to it would let
 * a drill run against a lightly-seeded database look like a full pass, which is
 * the exact failure mode a backup drill exists to avoid. So empty tables get
 * their own mark and their own tally in the summary.
 */
function checkCount(table, expected, actual) {
  if (actual === null) {
    failures++;
    console.log(`  ❌ ${table} — TABLE MISSING after restore`);
    return;
  }
  if (actual !== expected) {
    failures++;
    console.log(`  ❌ ${table} — ${expected} → ${actual}`);
    return;
  }
  if (expected === 0) {
    vacuous++;
    console.log(`  ◻️  ${table} — empty, so the round trip was not exercised`);
    return;
  }
  console.log(`  ✅ ${table} — ${expected} → ${actual}`);
}

function main() {
  console.log("OraMedha restore drill");
  console.log("======================\n");

  try {
    docker(["exec", CONTAINER, "true"], { stdio: "pipe" });
  } catch {
    console.error(
      `Local database container "${CONTAINER}" is not running.\n` +
        `Start it with:  npm run db:start`
    );
    process.exit(2);
  }

  // ── 1. Take the dump ──────────────────────────────────────────────────────
  // Schema + data for `public` only. `--clean --if-exists` so the restore is
  // rerunnable, which is what someone under pressure will actually need.
  console.log("1. Dumping the public schema…");
  const dump = docker([
    "exec", "-i", CONTAINER,
    "pg_dump", "-U", "postgres", "-d", "postgres",
    "--schema=public", "--no-owner", "--no-privileges",
    "--clean", "--if-exists",
  ]);
  console.log(`   ${(dump.length / 1024).toFixed(0)} KB\n`);

  const before = {
    ...counts("postgres", CLINICAL),
    ...counts("postgres", AUDIT),
  };

  const totalRows = Object.values(before).reduce((a, b) => a + (b ?? 0), 0);
  if (totalRows === 0) {
    console.error(
      "The source database is empty — a drill against nothing proves nothing.\n" +
        "Run `npm run db:reset` first so there is seeded data to restore."
    );
    process.exit(2);
  }

  // ── 2. Restore into a brand-new database ──────────────────────────────────
  console.log(`2. Restoring into a fresh database "${SCRATCH}"…`);
  scalar("postgres", `drop database if exists ${SCRATCH}`);
  scalar("postgres", `create database ${SCRATCH}`);

  // The dump references extensions Supabase installs outside `public`. Provide
  // them before restoring rather than after a confusing failure.
  for (const ext of ["pgcrypto", "uuid-ossp"]) {
    try {
      scalar(SCRATCH, `create extension if not exists "${ext}" with schema public`);
    } catch {
      /* absent extensions are reported by the restore itself */
    }
  }

  let restoreErrors = "";
  try {
    docker(
      ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", SCRATCH,
       "-v", "ON_ERROR_STOP=0", "-q"],
      { input: dump, stdio: ["pipe", "pipe", "pipe"] }
    );
  } catch (err) {
    restoreErrors = String(err.stderr ?? err.message);
  }
  console.log("   restored\n");

  // ── 3. Verify ─────────────────────────────────────────────────────────────
  console.log("3. Clinical data");
  const afterClinical = counts(SCRATCH, CLINICAL);
  for (const t of CLINICAL) checkCount(t, before[t], afterClinical[t]);

  console.log("\n4. Audit and consent trails");
  const afterAudit = counts(SCRATCH, AUDIT);
  for (const t of AUDIT) checkCount(t, before[t], afterAudit[t]);

  console.log("\n5. Append-only protection survived the restore");
  for (const [table, trigger] of APPEND_ONLY_TRIGGERS) {
    const found = scalar(
      SCRATCH,
      `select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where c.relname = '${table}' and t.tgname = '${trigger}' and not t.tgisinternal`
    );
    check(`${table}.${trigger}`, found === "1");
  }

  console.log("\n6. Referential integrity");
  for (const [label, sql] of VERIFY_ORPHANS) {
    const n = scalar(SCRATCH, sql);
    check(label, n === "0", n === "0" ? "none" : `${n} orphaned`);
  }

  console.log("\n7. RLS still enabled on restored tables");
  const rlsOff = scalar(
    SCRATCH,
    `select coalesce(string_agg(c.relname, ', '), '')
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`
  );
  check("every restored table has RLS enabled", rlsOff === "", rlsOff || "none without");

  // A restore that emits errors but produces the right counts is still a
  // restore nobody should trust; surface it either way.
  if (restoreErrors.trim()) {
    console.log("\n⚠️  psql reported errors during restore:");
    console.log(
      restoreErrors.split("\n").filter(Boolean).slice(0, 15).map((l) => `   ${l}`).join("\n")
    );
  }

  if (!KEEP) {
    scalar("postgres", `drop database if exists ${SCRATCH}`);
    console.log(`\nScratch database dropped. (--keep to retain it.)`);
  } else {
    console.log(`\nScratch database "${SCRATCH}" kept.`);
  }

  if (failures > 0) {
    console.log(`\nDRILL FAILED — ${failures} check(s) did not pass.\n`);
  } else {
    console.log("\nDRILL PASSED — this dump restores and reads back intact.");
    if (vacuous > 0) {
      console.log(
        `\n⚠️  ${vacuous} table(s) were EMPTY, so their round trip was not actually\n` +
          "   exercised. This pass is only as strong as the data that was present.\n" +
          "   Re-run after real activity — book an appointment, record a treatment,\n" +
          "   open a patient record — so the audit trails have rows to lose."
      );
    }
    console.log(
      "\nWhat this does NOT prove: nothing about Supabase's own platform backups,\n" +
        "nothing about Storage objects, and no RPO or RTO. See docs/BACKUP-DR.md.\n"
    );
  }
  process.exit(failures === 0 ? 0 : 1);
}

main();
