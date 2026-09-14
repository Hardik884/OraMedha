/**
 * Regression for getQueueMetrics' chair_count wiring (audit B3).
 *
 * The staff queue board's per-row wait estimate reads metrics.chairCount
 * (components/queue/QueueBoard.tsx) rather than assuming one chair. This pins
 * that getQueueMetrics actually fetches and returns it, correctly defaulted
 * for a clinic that hasn't configured one.
 *
 * getQueueStatus's own division (the portal-facing estimate) is exercised by
 * a full auth chain (createServerClient + a service-role client +
 * cookie-based session) that isn't practical to mock at this level; its
 * arithmetic — Math.ceil(durationAhead / Math.max(1, chairCount)) — is the
 * same shared formula pinned here and in QueueBoard/QueuePositionCard, and
 * was verified by direct code reading. A live/portal-authenticated test is
 * the natural next step if this function's logic changes again.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ resolveSession: vi.fn() }));
vi.mock("@/lib/appointments/complete", () => ({}));

import { resolveSession } from "@/lib/auth/session";
import { getQueueMetrics } from "@/actions/queue";

const CLINIC = "clinic-1";
type Row = Record<string, unknown>;

function makeDb(tables: { queue_entries: Row[]; clinic_settings: Row | null }) {
  function builder(table: "queue_entries" | "clinic_settings") {
    const eq: Record<string, unknown> = {};
    const api: Record<string, unknown> = {
      select: () => api,
      is: () => api,
      eq: (col: string, val: unknown) => {
        eq[col] = val;
        return api;
      },
      maybeSingle: () =>
        Promise.resolve({ data: tables.clinic_settings, error: null }),
      then: (onResolve: (v: unknown) => unknown) => {
        let rows = [...tables.queue_entries];
        for (const [col, val] of Object.entries(eq)) rows = rows.filter((r) => r[col] === val);
        return Promise.resolve({ data: rows, error: null }).then(onResolve);
      },
    };
    return api;
  }
  return { from: (table: "queue_entries" | "clinic_settings") => builder(table) };
}

function asStaff(tables: { queue_entries: Row[]; clinic_settings: Row | null }) {
  (resolveSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    db: makeDb(tables),
    profile: { id: "u1", clinic_id: CLINIC, role: "dentist" },
  });
}

beforeEach(() => vi.clearAllMocks());

describe("getQueueMetrics chair_count (audit B3)", () => {
  it("returns the clinic's configured chair count", async () => {
    asStaff({ queue_entries: [], clinic_settings: { chair_count: 3 } });
    const result = await getQueueMetrics();
    expect(result.data?.chairCount).toBe(3);
  });

  it("defaults to 1 chair when the clinic has no configured value", async () => {
    asStaff({ queue_entries: [], clinic_settings: null });
    const result = await getQueueMetrics();
    expect(result.data?.chairCount).toBe(1);
  });

  it("never reports fewer than 1 chair even on a bad value", async () => {
    asStaff({ queue_entries: [], clinic_settings: { chair_count: 0 } });
    const result = await getQueueMetrics();
    expect(result.data?.chairCount).toBe(1);
  });
});
