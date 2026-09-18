import { type NextRequest, NextResponse } from "next/server";

import { secretsMatch } from "@/lib/security/timing-safe";
import { BUSINESS_BRAIN_CLINIC_IDS } from "@/lib/feature-flags";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordJobRun } from "@/lib/business-brain/job-health";
import { getTodayInTimezone } from "@/lib/utils";
import { addDays } from "@/business-brain";
import { SupabaseMetricHistoryStore } from "@/lib/business-brain/metric-history-store";
import { persistMetricDay } from "@/lib/business-brain/persist-metrics";
import { ensureClinicMemoryBuild } from "@/lib/business-brain/clinic-memory";
import { DEFAULT_TIMEZONE } from "@/lib/clinic/constants";

/**
 * POST /api/cron/metric-history
 *
 * Records each clinic's most recently COMPLETED day into `metric_history`.
 *
 * Why this exists when history already self-heals:
 *   The dashboard writes back any history day it had to measure, so gaps close
 *   themselves on first view. That gets the speed, but not the accuracy — a day
 *   measured three weeks late was still RECONSTRUCTED, and reconstruction cannot
 *   recover status changes the schema never versioned (a treatment cancelled
 *   since reads as cancelled in the older day). Measuring a day the morning
 *   after it ends removes that gap permanently.
 *
 * Called by pg_cron via pg_net, so the schedule lives in Supabase — see
 * migration 20260731000100. Nothing external is involved.
 *
 * HOURLY, not daily, and that is deliberate. Clinics keep their own timezones,
 * so there is no single moment at which "yesterday" has ended everywhere; a
 * daily UTC job would leave some clinics permanently a day behind. Running each
 * hour means every clinic is recorded within an hour of its own midnight. The
 * cost of that is near zero because the work is skipped once a day is already
 * stored, and the write is an upsert regardless.
 *
 * Scoped to the Business Brain's enabled clinics, the same gate as the dashboard
 * and the AI actions. A clinic not running the Business Brain has no use for the
 * history and should not be paying for the queries.
 *
 * Auth: a bearer token compared in constant time. This endpoint writes, so an
 * unauthenticated caller could fill a clinic's history with measurements taken
 * at the wrong moment.
 */

/** Long enough to measure a handful of clinics; short enough to not pile up. */
export const maxDuration = 60;

interface ClinicOutcome {
  readonly clinicId: string;
  readonly date: string;
  readonly status: "recorded" | "already_recorded" | "failed";
  readonly error?: string;
  /**
   * Clinic memory for the same completed day, built once the day is on record.
   * Reported separately: a memory failure never marks the metric day failed.
   */
  readonly memory?: "built" | "already_built" | "failed" | "skipped";
}

/**
 * Derive and record clinic memory for a completed day, once. Runs in this job —
 * never at dashboard load — because a build reads up to a year of stored
 * evidence; the dashboard then reads one row. Never throws.
 */
async function buildMemory(
  db: ReturnType<typeof createAdminClient>,
  clinicId: string,
  date: string,
  timezone: string,
): Promise<ClinicOutcome["memory"]> {
  try {
    return await ensureClinicMemoryBuild(db as never, clinicId, date, timezone, new Date().toISOString());
  } catch (error) {
    console.error("[cron/metric-history] memory", { clinicId, date, error: error instanceof Error ? error.message : String(error) });
    return "failed";
  }
}

export async function POST(request: NextRequest) {
  const startedAt = new Date().toISOString();
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Fail closed. An unset secret must never mean "no auth required" — that
    // would turn a missed deployment step into an open write endpoint.
    console.error("[cron/metric-history] CRON_SECRET is not set; refusing to run.");
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }

  const header = request.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!secretsMatch(token, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const db = createAdminClient();
    const store = new SupabaseMetricHistoryStore(db as never);
    const results: ClinicOutcome[] = [];

    for (const clinicId of BUSINESS_BRAIN_CLINIC_IDS) {
      // Each clinic's own timezone decides which day just ended. A job running
      // at 19:00 UTC is already tomorrow in Asia/Kolkata, and using the server's
      // idea of yesterday would record the wrong day.
      const { data } = await db
        .from("clinic_settings")
        .select("timezone")
        .eq("clinic_id", clinicId)
        .maybeSingle();
      const timezone = (data as { timezone?: string | null } | null)?.timezone ?? DEFAULT_TIMEZONE;
      const date = addDays(getTodayInTimezone(timezone), -1);

      try {
        // Skip a day already on record. This is what makes an hourly schedule
        // cheap: after the first success each hour costs one indexed lookup.
        const existing = await store.readMetricDays(clinicId, date, date);
        if (existing.length > 0) {
          results.push({ clinicId, date, status: "already_recorded", memory: await buildMemory(db, clinicId, date, timezone) });
          continue;
        }

        await persistMetricDay(clinicId, date, db as never);
        // The day's readings are now evidence; memory for it is built from them.
        results.push({ clinicId, date, status: "recorded", memory: await buildMemory(db, clinicId, date, timezone) });
      } catch (error) {
        // One clinic's failure must not stop the others. The outcome is reported
        // rather than thrown so a caller reading the response can see exactly
        // which clinic and date to look at.
        const message = error instanceof Error ? error.message : String(error);
        console.error("[cron/metric-history]", { clinicId, date, error: message });
        results.push({ clinicId, date, status: "failed", error: message });
      }
    }

    const failed = results.filter((r) => r.status === "failed").length;
    // The run records itself: pg_cron only knows the request was queued, so this
    // row is the only evidence the work actually happened (job-health.ts).
    await recordJobRun(db, {
      job: "metric_history",
      startedAt,
      ok: failed === 0,
      handled: results.length,
      failed,
      detail: failed === 0 ? null : results.find((r) => r.status === "failed")?.error ?? "one or more clinics failed",
    });
    return NextResponse.json(
      { ok: failed === 0, results },
      // 207 when some clinics succeeded and others did not, so a monitor can
      // tell a partial run from a clean one without parsing the body.
      { status: failed === 0 ? 200 : 207 },
    );
  } catch (error) {
    await recordJobRun(createAdminClient(), {
      job: "metric_history",
      startedAt,
      ok: false,
      handled: 0,
      failed: 0,
      detail: error instanceof Error ? error.message : String(error),
    });
    console.error("[cron/metric-history] unexpected", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/** Only POST is allowed: this endpoint has effects. */
export async function GET() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}
