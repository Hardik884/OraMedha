import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    // Mirrors the `@/*` path alias from tsconfig.json so specs can import
    // application modules the same way the app does.
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      // See test/server-only-stub.ts — the real package cannot resolve outside
      // a Next build, and the modules that import it are worth testing.
      "server-only": fileURLToPath(new URL("./test/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    include: [
      "business-brain/**/*.spec.ts",
      // The Business Brain's Supabase adapter lives in lib/ (the port stays in
      // business-brain/, the adapter belongs to the app). Its integration specs
      // run against the local Supabase stack and skip themselves when it is not
      // running — see lib/business-brain/__tests__.
      "lib/**/*.spec.ts",
      // Route handlers are tested by importing and calling them directly, so no
      // dev server is involved. The auth cases here must run everywhere.
      "app/**/*.spec.ts",
      // Server Actions ("use server") can't be invoked directly outside a real
      // Next.js request (they resolve the session from request cookies), so
      // specs here integration-test the Postgres state they read/write instead
      // — same local-stack skip contract as lib/**/*.spec.ts.
      "actions/**/*.spec.ts",
    ],
    environment: "node",
    /*
     * Runs before every spec file. Refuses to start the suite when the ambient
     * Supabase URL points at a hosted project — application code under test
     * (createAdminClient) reads that variable directly and writes with the
     * service-role key. See test/guard-remote-database.ts.
     */
    setupFiles: ["./test/guard-remote-database.ts"],
    /*
     * Run spec FILES one at a time.
     *
     * A large share of this suite is integration specs that seed and tear down
     * fixtures in ONE shared local Postgres. Run in parallel they interfere:
     * two suites seed overlapping rows, one suite's cleanup lands mid-run of
     * another, and a `delete from clinics` cascades under a neighbour's feet.
     *
     * The damage was not loud. These specs guard their setup and SKIP when it
     * does not come up, so a race showed up as "10 skipped" rather than as a
     * failure — the analytics metric-definitions suite passes 10/10 on its own
     * and silently skipped all ten alongside the others. Business Brain's
     * suites failed outright on a duplicate key instead. Both are the same
     * cause, and both are the failure mode this suite exists to prevent:
     * a green run that quietly did not check the thing.
     *
     * Serial execution costs roughly 40s on the whole run and buys a result
     * that means what it says. Per-file isolation is not achievable here
     * because the database, not the worker, is the shared resource.
     */
    fileParallelism: false,
    // Integration specs talk to Postgres over HTTP; the default 5s is tight for
    // the seeding step on a cold container.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
