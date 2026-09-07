#!/usr/bin/env node
/**
 * scripts/assert-no-skipped-tests.mjs
 *
 * Fails when a Vitest run skipped anything.
 *
 * WHY THIS IS A CI STEP AND NOT A LINT RULE
 *   Every integration spec in this repository guards itself:
 *
 *     const LOCAL_UP = await reachable();
 *     describe.skipIf(!LOCAL_UP)(...)
 *
 *   That is the right behaviour on a laptop without Docker — a developer
 *   changing a chart component should not be blocked by a database they do not
 *   have running. It is the wrong behaviour in CI, and the difference was
 *   invisible: a run in which every RLS, tenant-isolation and audit-immutability
 *   spec skipped reported
 *
 *     Test Files  105 passed | 21 skipped (126)
 *          Tests  1249 passed | 248 skipped (1497)
 *
 *   and exited 0. 248 of 1497 tests — the entire security suite — were not
 *   evidence of anything, and nothing said so.
 *
 *   So CI starts the stack, and then asserts the skips are gone. A non-zero
 *   count here means either the stack did not come up, or a spec has started
 *   skipping for a reason nobody declared. Both must fail the build.
 *
 * USAGE
 *   vitest --run --reporter=json --outputFile=<file>
 *   node scripts/assert-no-skipped-tests.mjs <file>
 */

import { readFile } from "node:fs/promises";

const reportPath = process.argv[2];

if (!reportPath) {
  console.error("usage: node scripts/assert-no-skipped-tests.mjs <vitest-json-report>");
  process.exit(2);
}

let report;
try {
  report = JSON.parse(await readFile(reportPath, "utf8"));
} catch (err) {
  console.error(`Could not read the Vitest JSON report at ${reportPath}: ${err.message}`);
  console.error("The test run itself probably failed before it could write one.");
  process.exit(2);
}

// Vitest's JSON reporter mirrors Jest's shape.
const passed = report.numPassedTests ?? 0;
const failed = report.numFailedTests ?? 0;
const skipped = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0);
const total = report.numTotalTests ?? passed + failed + skipped;

console.log(`Vitest: ${passed} passed · ${failed} failed · ${skipped} skipped · ${total} total`);

if (failed > 0) {
  // The runner has already exited non-zero and printed the failures; this is
  // only here so the summary line above is not mistaken for a pass.
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}

if (skipped === 0) {
  console.log("No skipped tests. The security suite actually ran.");
  process.exit(0);
}

// Name the files, so the failure says which guard tripped rather than only that
// one did.
const culprits = [];
for (const suite of report.testResults ?? []) {
  const n = (suite.assertionResults ?? []).filter(
    (t) => t.status === "pending" || t.status === "todo" || t.status === "skipped"
  ).length;
  if (n > 0) {
    culprits.push(`  ${n.toString().padStart(4)}  ${suite.name ?? suite.testFilePath ?? "(unknown file)"}`);
  }
}

console.error(
  [
    "",
    `${skipped} test(s) were SKIPPED. In CI that is a failure.`,
    "",
    "These specs skip themselves when the local Supabase stack is unreachable,",
    "so this almost always means `supabase start` / `supabase db reset` did not",
    "finish, or the API is not answering on the port the specs expect.",
    "",
    "Skipped by file:",
    ...culprits,
    "",
  ].join("\n")
);
process.exit(1);
