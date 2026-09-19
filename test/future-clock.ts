/**
 * test/future-clock.ts — run the pure suites as if months had passed.
 *
 * ## The bug this exists to find
 *
 * A spec that pins a fixture to a fixed date and then lets the code under test
 * read the real clock passes for a few weeks and then stops meaning anything.
 * It does not fail loudly at first: the fixture drifts out of a trailing window,
 * the behaviour under test stops being exercised, and the assertion that
 * survives is the one about the empty case. Nine specs in this repository were
 * in that state at once, and what gave them away was a database default nobody
 * had set explicitly — not the dates.
 *
 * Moving the clock forward is the cheapest way to find the rest. Anything that
 * fails here is comparing a fixed fixture against "now", which is exactly the
 * thing to make explicit.
 *
 * ## Only `Date` is faked, and only the PURE suites are run
 *
 * `vitest.clock.config.ts` includes `business-brain/**` alone. The integration
 * specs are deliberately excluded, because moving this process's clock does NOT
 * move Postgres's: every write would then look like it came from the future, and
 * the schema quite rightly refuses those. The failures would all be about the
 * experiment rather than about the specs.
 *
 * Timers are left real (`toFake: ["Date"]` with `shouldAdvanceTime`), so a spec
 * that installs its own fake timers still behaves.
 *
 * Run it with `npm run test:clock`, or with a different jump:
 *   CLOCK_OFFSET_DAYS=400 npm run test:clock
 */

import { afterAll, beforeAll, vi } from "vitest";

/** Three months by default: past every trailing window the module computes. */
const OFFSET_DAYS = Number(process.env.CLOCK_OFFSET_DAYS ?? "90");

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(Date.now() + OFFSET_DAYS * 24 * 60 * 60 * 1000));
});

afterAll(() => {
  vi.useRealTimers();
});
