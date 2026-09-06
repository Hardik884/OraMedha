/**
 * Specs for the no-show-detection cron endpoint.
 *
 * This endpoint WRITES appointment status for every clinic, and it is
 * reachable over the network, so — same reasoning as
 * app/api/cron/metric-history/__tests__/route.spec.ts, which this mirrors —
 * the auth behaviour matters more than the persistence and always runs
 * without a database; the sweep behaviour runs against local Supabase and
 * skips itself when that is not reachable.
 *
 * The one thing specific to this endpoint worth a dedicated test: unlike
 * metric-history, it must NOT be scoped to the Business Brain's dev clinic
 * allow-list. No-show detection is a core production feature for every
 * clinic, so a clinic absent from BUSINESS_BRAIN_CLINIC_IDS must still be
 * swept.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

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
  return new Request("http://localhost/api/cron/no-show-detection", { method: "POST", headers });
}

describe("auth", () => {
  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("REFUSES to run when CRON_SECRET is unset, rather than running open", async () => {
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

  it("refuses GET, which has no effects and should not appear to", async () => {
    const res = await GET();
    expect(res.status).toBe(405);
  });
});

describe.skipIf(!LOCAL_UP)("sweep", () => {
  const raw = createClient(URL_BASE, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  const CLINIC = "9fd00000-0000-4000-8000-000000000005";

  beforeAll(async () => {
    process.env.CRON_SECRET = SECRET;
    await raw.from("clinics").delete().eq("id", CLINIC);
    await raw.from("clinics").insert({ id: CLINIC, name: "Route Sweep Test Clinic" });
    await raw.from("clinic_settings").insert({
      clinic_id: CLINIC,
      clinic_name: "Route Sweep Test Clinic",
      timezone: "Asia/Kolkata",
    });
  });
  afterAll(async () => {
    delete process.env.CRON_SECRET;
    await raw.from("clinics").delete().eq("id", CLINIC);
  });

  it("sweeps every clinic in clinic_settings, not just the Business Brain allow-list", async () => {
    const { BUSINESS_BRAIN_CLINIC_IDS } = await import("@/lib/feature-flags");
    // The seeded clinic must not accidentally be on the allow-list, or this
    // test would not distinguish "all clinics" from "allow-listed clinics".
    expect(BUSINESS_BRAIN_CLINIC_IDS as readonly string[]).not.toContain(CLINIC);

    const res = await POST(post({ authorization: `Bearer ${SECRET}` }) as never);
    expect([200, 207]).toContain(res.status);

    const body = (await res.json()) as { results: { clinicId: string }[] };
    expect(body.results.map((r) => r.clinicId)).toContain(CLINIC);
  });

  it("is idempotent: a second run transitions nothing new for a clean clinic", async () => {
    const res = await POST(post({ authorization: `Bearer ${SECRET}` }) as never);
    const body = (await res.json()) as { results: { clinicId: string; transitioned?: number }[] };
    const mine = body.results.find((r) => r.clinicId === CLINIC);
    expect(mine?.transitioned ?? 0).toBe(0);
  });
});
