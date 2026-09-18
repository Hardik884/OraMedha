import { type NextRequest, NextResponse } from "next/server";

import { secretsMatch } from "@/lib/security/timing-safe";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordJobRun } from "@/lib/business-brain/job-health";
import { DEFAULT_TIMEZONE } from "@/lib/clinic/constants";
import { autoMarkNoShowForClinic } from "@/lib/appointments/auto-no-show";

/**
 * POST /api/cron/no-show-detection
 *
 * Automatically marks appointments as `no_show` once their calendar day has
 * fully ended, per clinic, in that clinic's own timezone — see
 * lib/appointments/auto-no-show.ts for the exact rule and why each other
 * status is left untouched.
 *
 * Called by pg_cron via pg_net (migration 20260803000100). Runs hourly, same
 * cadence and reasoning as the metric-history job (20260731000100): clinics
 * keep their own timezones, so no single UTC moment is "end of day" for all
 * of them, and the work the endpoint does is cheap to repeat because the
 * underlying UPDATE's WHERE clause is itself the idempotency guard.
 *
 * Unlike metric-history, this iterates EVERY clinic in `clinic_settings`, not
 * the Business Brain's dev allow-list. No-show detection is a core production
 * feature for all clinics, not a Business Brain enhancement — gating it behind
 * BUSINESS_BRAIN_CLINIC_IDS would silently stop marking no-shows for every
 * clinic not on that list.
 *
 * Auth: a bearer token compared in constant time, same as metric-history.
 * This endpoint writes appointment status for every clinic, so an
 * unauthenticated caller could mass-mark appointments as no-show.
 */

/** Long enough to sweep every clinic in one run; short enough to not pile up. */
export const maxDuration = 60;

interface ClinicOutcome {
  readonly clinicId: string;
  readonly status: "ok" | "failed";
  readonly boundary?: string;
  readonly transitioned?: number;
  readonly error?: string;
}

export async function POST(request: NextRequest) {
  const startedAt = new Date().toISOString();
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Fail closed — an unset secret must never be read as "no auth required".
    console.error("[cron/no-show-detection] CRON_SECRET is not set; refusing to run.");
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }

  const header = request.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!secretsMatch(token, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const db = createAdminClient();

    const { data: clinics, error: clinicsErr } = await db
      .from("clinic_settings")
      .select("clinic_id, timezone");

    if (clinicsErr) {
      console.error("[cron/no-show-detection] failed to list clinics:", clinicsErr);
      await recordJobRun(db, { job: "no_show_detection", startedAt, ok: false, handled: 0, failed: 0, detail: `failed to list clinics: ${clinicsErr.message}` });
      return NextResponse.json({ error: "Failed to list clinics" }, { status: 500 });
    }

    const results: ClinicOutcome[] = [];

    for (const row of (clinics ?? []) as { clinic_id: string; timezone: string | null }[]) {
      const clinicId = row.clinic_id;
      const timezone = row.timezone ?? DEFAULT_TIMEZONE;

      try {
        // One clinic's failure must not stop the others.
        const outcome = await autoMarkNoShowForClinic(db, { clinicId, timezone });
        results.push({
          clinicId,
          status: "ok",
          boundary: outcome.boundary,
          transitioned: outcome.transitionedIds.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[cron/no-show-detection]", { clinicId, error: message });
        results.push({ clinicId, status: "failed", error: message });
      }
    }

    const failed = results.filter((r) => r.status === "failed").length;
    // See job-health.ts: pg_cron cannot tell anyone whether this ran.
    await recordJobRun(db, {
      job: "no_show_detection",
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
      job: "no_show_detection",
      startedAt,
      ok: false,
      handled: 0,
      failed: 0,
      detail: error instanceof Error ? error.message : String(error),
    });
    console.error("[cron/no-show-detection] unexpected", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/** Only POST is allowed: this endpoint has effects. */
export async function GET() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}
