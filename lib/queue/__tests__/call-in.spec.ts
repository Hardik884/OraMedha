import { describe, expect, it } from "vitest";

import { recordCallIn } from "../call-in";

type Row = Record<string, unknown>;

/** A minimal in-memory PostgREST builder: enough filters for recordCallIn. */
function fakeDb(queue: Row[]) {
  const updates: Array<{ id: unknown; patch: Row }> = [];
  function builder() {
    const filters: Array<(r: Row) => boolean> = [];
    let patch: Row | null = null;
    const run = () => queue.filter((r) => filters.every((f) => f(r)));
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), api),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), api),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), api),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), api),
      limit: () => api,
      update: (p: Row) => ((patch = p), api),
      maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => {
        const rows = run();
        if (patch) {
          for (const r of rows) {
            Object.assign(r, patch);
            updates.push({ id: r.id, patch });
          }
        }
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
    };
    return api;
  }
  return { db: { from: () => builder() }, updates };
}

const NOW = "2026-09-14T10:30:00.000Z";
const entry = (over: Row = {}): Row => ({
  id: "q1",
  clinic_id: "c1",
  appointment_id: "a1",
  queue_date: "2026-09-14",
  status: "waiting",
  called_at: null,
  removed_at: null,
  ...over,
});

describe("recordCallIn", () => {
  it("promotes the patient's waiting entry and stamps the call-in", async () => {
    const queue = [entry()];
    const { db } = fakeDb(queue);
    const result = await recordCallIn(db, "c1", "a1", NOW);
    expect(result).toEqual({ found: true, promoted: true, calledAt: NOW, error: null });
    expect(queue[0]).toMatchObject({ status: "in_progress", called_at: NOW });
  });

  it("never invents a queue row for a patient nobody checked in", async () => {
    const queue: Row[] = [];
    const { db, updates } = fakeDb(queue);
    const result = await recordCallIn(db, "c1", "a1", NOW);
    expect(result.found).toBe(false);
    expect(queue).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("keeps a call-in already recorded", async () => {
    const queue = [entry({ status: "in_progress", called_at: "2026-09-14T09:00:00.000Z" })];
    const { db, updates } = fakeDb(queue);
    const result = await recordCallIn(db, "c1", "a1", NOW);
    expect(result.calledAt).toBe("2026-09-14T09:00:00.000Z");
    expect(queue[0].called_at).toBe("2026-09-14T09:00:00.000Z");
    expect(updates.every((u) => u.patch.called_at !== NOW)).toBe(true);
  });

  it("records the call-in without promoting when another patient holds the chair", async () => {
    const queue = [entry(), entry({ id: "q2", appointment_id: "a2", status: "in_progress", called_at: "2026-09-14T10:00:00.000Z" })];
    const { db } = fakeDb(queue);
    const result = await recordCallIn(db, "c1", "a1", NOW);
    expect(result).toEqual({ found: true, promoted: false, calledAt: NOW, error: null });
    expect(queue[0]).toMatchObject({ status: "waiting", called_at: NOW });
    expect(queue[1]).toMatchObject({ status: "in_progress", called_at: "2026-09-14T10:00:00.000Z" });
  });

  it("ignores a removed entry, and a removed in-progress entry does not block promotion", async () => {
    const removedOwn = [entry({ removed_at: NOW })];
    expect((await recordCallIn(fakeDb(removedOwn).db, "c1", "a1", NOW)).found).toBe(false);

    const queue = [entry(), entry({ id: "q2", appointment_id: "a2", status: "in_progress", removed_at: NOW })];
    const result = await recordCallIn(fakeDb(queue).db, "c1", "a1", NOW);
    expect(result.promoted).toBe(true);
  });

  it("never touches another clinic's entry", async () => {
    const queue = [entry({ clinic_id: "c2" })];
    const { db, updates } = fakeDb(queue);
    expect((await recordCallIn(db, "c1", "a1", NOW)).found).toBe(false);
    expect(updates).toHaveLength(0);
  });
});
