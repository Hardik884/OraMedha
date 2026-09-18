/**
 * Specs for the metric-history cron endpoint.
 *
 * This endpoint WRITES, and it is reachable over the network, so the auth
 * behaviour matters more than the persistence: an unauthenticated caller could
 * fill a clinic's history with measurements taken at the wrong moment, and a
 * missing environment variable must never be read as "no auth required".
 *
 * The persistence path runs against the local Supabase stack and skips itself
 * when it is not reachable; the auth cases need no database at all and always
 * run, because they are the part that must not regress silently.
 */

import { createClient } from "@supabase/supabase-js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const URL_BASE = process.env.SUPABASE_TEST_URL ?? "http://127.0.0.1:55321";
const SERVICE_KEY =
  process.env.SUPABASE_TEST_SERVICE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

// The route builds its admin client from these at call time.
process.env.NEXT_PUBLIC_SUPABASE_URL = URL_BASE;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;

const SECRET = "test-cron-secret-value";

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${URL_BASE}/rest/v1/`, {
      headers: { apikey: SERVICE_KEY },
      signal: AbortSignal.timeout(2500),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}
const LOCAL_UP = await reachable();

const { POST, GET } = await import("../route");

function post(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/cron/metric-history", { method: "POST", headers });
}

describe("auth", () => {
  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("REFUSES to run when CRON_SECRET is unset, rather than running open", async () => {
    // Fail closed. A missed deployment step must not turn this into an
    // unauthenticated write endpoint.
    delete process.env.CRON_SECRET;
    const res = await POST(post({ authorization: "Bearer anything" }) as never);
    expect(res.status).toBe(503);
  });

  it("rejects a request with no Authorization header", async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await POST(post() as never);
    expect(res.status).toBe(401);
  });

  it("rejects a wrong secret", async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await POST(post({ authorization: "Bearer wrong" }) as never);
    expect(res.status).toBe(401);
  });

  it("rejects a correct secret sent without the Bearer scheme", async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await POST(post({ authorization: SECRET }) as never);
    expect(res.status).toBe(401);
  });

  it("rejects a secret that merely starts with the right characters", async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await POST(post({ authorization: `Bearer ${SECRET.slice(0, -1)}` }) as never);
    expect(res.status).toBe(401);
  });

  it("refuses GET, which has no effects and should not appear to", async () => {
    const res = await GET();
    expect(res.status).toBe(405);
  });
});

describe.skipIf(!LOCAL_UP)("recording", () => {
  beforeAll(() => {
    process.env.CRON_SECRET = SECRET;
  });
  afterAll(() => {
    delete process.env.CRON_SECRET;
  });

  it("accepts the correct secret and reports an outcome per clinic", async () => {
    const res = await POST(post({ authorization: `Bearer ${SECRET}` }) as never);
    expect([200, 207]).toContain(res.status);

    const body = (await res.json()) as {
      ok: boolean;
      results: { clinicId: string; date: string; status: string }[];
    };
    expect(Array.isArray(body.results)).toBe(true);
    // Scoped to the Business Brain's enabled clinics — the same gate as the
    // dashboard. A clinic not running the Business Brain must not be touched.
    const { BUSINESS_BRAIN_CLINIC_IDS } = await import("@/lib/feature-flags");
    expect(body.results.map((r) => r.clinicId).sort()).toEqual(
      [...BUSINESS_BRAIN_CLINIC_IDS].sort(),
    );
  });

  it("records a completed day, never today", async () => {
    const res = await POST(post({ authorization: `Bearer ${SECRET}` }) as never);
    const body = (await res.json()) as { results: { date: string }[] };
    const { getTodayInTimezone } = await import("@/lib/utils");
    for (const r of body.results) {
      // Today's figures are still moving; freezing them would store a
      // half-finished number as if it were the day's result.
      expect(r.date < getTodayInTimezone("Asia/Kolkata")).toBe(true);
    }
  });

  it("is idempotent: a second run skips the day it already recorded", async () => {
    await POST(post({ authorization: `Bearer ${SECRET}` }) as never);
    const res = await POST(post({ authorization: `Bearer ${SECRET}` }) as never);
    const body = (await res.json()) as { results: { status: string }[] };
    // This is what makes an hourly schedule affordable.
    expect(body.results.every((r) => r.status === "already_recorded")).toBe(true);
  });

  it("skips an allow-listed clinic that does not exist here, and does not call it a failure", async () => {
    // A clinic on the allow-list with no clinic_settings row in THIS database —
    // the demo clinic before anyone runs the seeder. Recording history for it
    // violates metric_history's foreign key, and reporting that as a failed run
    // left the job permanently degraded on every such environment.
    const admin = createClient(URL_BASE, SERVICE_KEY, { auth: { persistSession: false } });
    const { BUSINESS_BRAIN_CLINIC_IDS } = await import("@/lib/feature-flags");
    const victim = BUSINESS_BRAIN_CLINIC_IDS[BUSINESS_BRAIN_CLINIC_IDS.length - 1];
    const { data: saved } = await admin.from("clinic_settings").select("*").eq("clinic_id", victim).maybeSingle();
    await admin.from("clinic_settings").delete().eq("clinic_id", victim);

    try {
      const res = await POST(post({ authorization: `Bearer ${SECRET}` }) as never);
      const body = (await res.json()) as { ok: boolean; results: { clinicId: string; status: string }[] };
      const outcome = body.results.find((r) => r.clinicId === victim);
      expect(outcome?.status).toBe("not_configured");
      // The run as a whole is still clean: nothing failed.
      expect(body.results.some((r) => r.status === "failed")).toBe(false);
      expect(body.ok).toBe(true);
    } finally {
      if (saved) await admin.from("clinic_settings").insert(saved);
    }
  });

  it("builds clinic memory for the recorded day once, and skips it on the next run", async () => {
    await POST(post({ authorization: `Bearer ${SECRET}` }) as never);
    const res = await POST(post({ authorization: `Bearer ${SECRET}` }) as never);
    const body = (await res.json()) as { results: { memory?: string }[] };
    expect(body.results.every((r) => r.memory === "already_built")).toBe(true);
  });
});
