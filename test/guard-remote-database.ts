/**
 * test/guard-remote-database.ts
 *
 * Runs before every spec file (vitest.config.ts → test.setupFiles).
 *
 * WHY THIS EXISTS
 *   The integration specs are careful: each one reads its target from
 *   SUPABASE_TEST_URL and defaults to http://127.0.0.1:55321, so they cannot be
 *   pointed at a hosted project by accident.
 *
 *   Application code under test is NOT careful, and cannot be — that is its job.
 *   `createAdminClient()` (lib/supabase/admin.ts) reads
 *   NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY straight from the
 *   environment, because in production that is exactly right. So any spec that
 *   exercises a code path reaching it — `recordPhiAccess` inside an otherwise
 *   fully-mocked unit test is the real example — writes to whatever those two
 *   variables happen to point at.
 *
 *   In a shell with production credentials loaded (a developer who ran the app
 *   that session, a CI job with the deploy environment attached), `npm test`
 *   therefore writes to production with the SERVICE ROLE key, which bypasses
 *   RLS. This was observed: a test run issued phi_access_log INSERTs against the
 *   hosted project and was saved only by a mock using "dentist-1" where a uuid
 *   was required.
 *
 * WHAT IT DOES
 *   Refuses to start the suite when the ambient Supabase URL is not a loopback
 *   address. It fails LOUDLY and immediately rather than skipping, because a
 *   suite that quietly declines to run is the failure mode this repository has
 *   already been bitten by once (see the 248-skip finding).
 *
 *   The check is on the HOST only. Any port is fine — the CLI's default differs
 *   between projects — and SUPABASE_TEST_URL is checked too, so pointing the
 *   integration specs at a remote host is refused by the same rule.
 */

/** Loopback hosts, and the docker-compose service name the CLI uses internally. */
const LOCAL_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "0.0.0.0",
  "::1",
  "[::1]",
  "host.docker.internal",
  "kong",
  "supabase_kong_dentgrow",
]);

function isLocal(raw: string | undefined): boolean {
  if (!raw) return true; // unset is fine — createAdminClient throws on its own
  try {
    return LOCAL_HOSTS.has(new URL(raw).hostname);
  } catch {
    // Not a URL at all. Placeholder values ("x", "local-test-only") are used to
    // neutralise the environment deliberately; they reach no network.
    return true;
  }
}

for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_TEST_URL"] as const) {
  const value = process.env[name];
  if (!isLocal(value)) {
    throw new Error(
      [
        "",
        "  ┌─ REFUSING TO RUN THE TEST SUITE ─────────────────────────────────┐",
        `  │ ${name} points at a non-local host:`,
        `  │   ${value}`,
        "  │",
        "  │ Specs write with the SERVICE ROLE key, which bypasses RLS. Run",
        "  │ against a hosted project and they will seed, update and delete",
        "  │ real clinic data.",
        "  │",
        "  │ Start the local stack and run again:",
        "  │   npm run db:start && npm run db:reset && npm test",
        "  │",
        "  │ If your shell has production credentials loaded, clear them for",
        "  │ this command:",
        "  │   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:55321 npm test",
        "  └──────────────────────────────────────────────────────────────────┘",
        "",
      ].join("\n")
    );
  }
}
