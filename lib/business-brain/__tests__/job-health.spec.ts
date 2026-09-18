/**
 * Job health: a job nobody can see failing is a job nobody can rely on.
 *
 * The case that matters most is "never run" — the hosted project sat in it for
 * weeks while pg_cron reported success for every queued request.
 */

import { describe, expect, it, vi } from "vitest";

import { describeJobHealth, readJobHealth, recordJobRun } from "../job-health";

const NOW = "2026-09-18T12:00:00.000Z";
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();

type Row = Record<string, unknown>;
const row = (over: Row = {}): Row => ({
  job: "metric_history",
  last_run_at: hoursAgo(1),
  last_success_at: hoursAgo(1),
  last_ok: true,
  last_detail: null,
  runs_24h: 24,
  failures_24h: 0,
  clinics_failed_24h: 0,
  ...over,
});

const dbReturning = (rows: Row[] | null, error: { message: string } | null = null) => ({
  rpc: async () => ({ data: rows, error }),
});

describe("readJobHealth", () => {
  it("reports a job that has never run — the failure that went unseen for weeks", async () => {
    const [health] = (await readJobHealth(dbReturning([row({ last_run_at: null, last_success_at: null, last_ok: null, runs_24h: 0 })]), NOW))!;
    expect(health.status).toBe("never_run");
    expect(describeJobHealth(health)).toMatch(/app_base_url/);
  });

  it("reports a job whose last success is outside its window as stale", async () => {
    const [health] = (await readJobHealth(dbReturning([row({ last_success_at: hoursAgo(9), last_run_at: hoursAgo(9) })]), NOW))!;
    expect(health.status).toBe("stale");
    expect(health.hoursSinceSuccess).toBe(9);
    expect(describeJobHealth(health)).toBe("No successful run in 9 hours.");
  });

  it("reports a run that failed, or clinics failing inside it, as degraded", async () => {
    const [lastFailed] = (await readJobHealth(dbReturning([row({ last_ok: false, failures_24h: 1, last_detail: "clinic settings unreadable" })]), NOW))!;
    expect(lastFailed.status).toBe("degraded");
    expect(lastFailed.detail).toBe("clinic settings unreadable");

    const [clinicFailed] = (await readJobHealth(dbReturning([row({ clinics_failed_24h: 2 })]), NOW))!;
    expect(clinicFailed.status).toBe("degraded");
    expect(describeJobHealth(clinicFailed)).toBe("Running, but 2 clinics failed in the last 24 hours.");
  });

  it("reports a recent clean run as healthy", async () => {
    const [health] = (await readJobHealth(dbReturning([row()]), NOW))!;
    expect(health.status).toBe("healthy");
    expect(describeJobHealth(health)).toBe("24 runs in the last 24 hours, all clean.");
  });

  it("returns null when health cannot be read, so the console says unknown rather than healthy", async () => {
    expect(await readJobHealth(dbReturning(null, { message: "permission denied" }), NOW)).toBeNull();
  });
});

describe("recordJobRun", () => {
  it("writes the run with its counts, trimming any long detail", async () => {
    const inserted: Row[] = [];
    const db = { from: () => ({ insert: async (v: Row) => (inserted.push(v), { error: null }) }) };
    await recordJobRun(db, { job: "no_show_detection", startedAt: hoursAgo(1), ok: false, handled: 3, failed: 1, detail: "x".repeat(900) });
    expect(inserted[0]).toMatchObject({ job: "no_show_detection", ok: false, handled: 3, failed: 1 });
    expect((inserted[0].detail as string).length).toBe(500);
  });

  it("never fails the job it is recording", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = { from: () => ({ insert: async () => { throw new Error("no connection"); } }) };
    await expect(recordJobRun(failing, { job: "metric_history", startedAt: NOW, ok: true, handled: 1, failed: 0 })).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
