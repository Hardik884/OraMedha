import { defineConfig, mergeConfig } from "vitest/config";

import base from "./vitest.config";

/**
 * The calendar-rot check: the pure suites, run as if three months had passed.
 *
 * See `test/future-clock.ts` for what it catches and why the integration specs
 * are not in it. `npm run test:clock`.
 *
 * A failure here is not a flake. It means a spec is comparing a fixed fixture
 * against the real clock, and the fix is to make the moment explicit — pass the
 * date the code should treat as today — rather than to move the fixture forward
 * and wait for it to rot again.
 */
const config = mergeConfig(
  base,
  defineConfig({
    test: {
      setupFiles: ["./test/guard-remote-database.ts", "./test/future-clock.ts"],
      // Faking Date slows the Monte-Carlo suites enough to pass the default.
      testTimeout: 120_000,
    },
  }),
);

// Assigned rather than merged: mergeConfig CONCATENATES arrays, so declaring
// `include` above would have added the pure suites to the base globs instead of
// replacing them — and the integration specs would have run under a clock their
// database does not share.
config.test = { ...config.test, include: ["business-brain/**/*.spec.ts"] };

export default config;
