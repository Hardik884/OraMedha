/**
 * lib/business-brain/job-health.ts
 *
 * Whether the scheduled jobs are actually running.
 *
 * pg_cron calls them through pg_net, and it records a run as "succeeded" as soon
 * as the request is queued — whatever the app answers, or whether it answers at
 * all. Between the Vercel project rename and 18 September 2026 every hourly call
 * returned 404 and pg_cron reported success throughout, so the Business Brain sat
 * with no reading recorded at the time and no clinic memory for weeks.
 *
 * Only the job itself knows whether the work happened, so each run records
 * itself here when it finishes (migration 20260918110000). A job that never ran
 * leaves no row, which is precisely the signal that was missing. Nothing in the
 * row identifies a clinic beyond counts.
 */

import "server-only";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = any;

export type ScheduledJob = "metric_history" | "no_show_detection";

/** How long a job may go without a successful run before it is called stale. */
export const JOB_STALE_AFTER_HOURS: Readonly<Record<ScheduledJob, number>> = {
  // Hourly, and a day is recorded once: three misses is a real outage, not a blip.
  metric_history: 3,
  no_show_detection: 3,
};

export interface JobRun {
  readonly job: ScheduledJob;
  readonly startedAt: string;
  readonly ok: boolean;
  /** Units of work attempted — clinics, for both of today's jobs. */
  readonly handled: number;
  /** How many of those failed. A run can finish with some clinics failing. */
  readonly failed: number;
  /** Short, non-sensitive reason when the run failed. Never a response body. */
  readonly detail?: string | null;
}

/**
 * Record that a job finished. Never throws and never fails the job: a run that
 * did its work and could not write its own receipt is still a run that worked.
 */
export async function recordJobRun(db: DbClient, run: JobRun): Promise<void> {
  try {
    const { error } = await db.from("job_runs").insert({
      job: run.job,
      started_at: run.startedAt,
      ok: run.ok,
      handled: run.handled,
      failed: run.failed,
      detail: run.detail ? run.detail.slice(0, 500) : null,
    });
    if (error) console.error("[recordJobRun]", { job: run.job, error: error.message });
  } catch (error) {
    console.error("[recordJobRun] unexpected", { job: run.job, error });
  }
}

export type JobStatus = "healthy" | "degraded" | "stale" | "never_run";

export interface JobHealth {
  readonly job: ScheduledJob;
  readonly status: JobStatus;
  readonly lastRunAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly hoursSinceSuccess: number | null;
  readonly runs24h: number;
  readonly failures24h: number;
  /** Clinics that failed inside otherwise-successful runs, over 24 hours. */
  readonly clinicsFailed24h: number;
  readonly detail: string | null;
}

interface JobHealthRow {
  job: string;
  last_run_at: string | null;
  last_success_at: string | null;
  last_ok: boolean | null;
  last_detail: string | null;
  runs_24h: number;
  failures_24h: number;
  clinics_failed_24h: number;
}

/**
 * Health per job.
 *
 *   never_run  nothing has ever recorded a run — the job cannot be reached, or
 *              was never scheduled. This is what a wrong URL looks like.
 *   stale      no success inside the job's own window.
 *   degraded   running, but its last run failed or clinics failed inside it.
 *   healthy    a recent success, and nothing failing.
 *
 * Returns null when the health itself could not be read, which the caller shows
 * as unknown — never as healthy.
 */
export async function readJobHealth(db: DbClient, now: string): Promise<readonly JobHealth[] | null> {
  const { data, error } = await db.rpc("job_health");
  if (error) {
    console.error("[readJobHealth]", error.message);
    return null;
  }
  return ((data ?? []) as JobHealthRow[]).map((row) => {
    const job = row.job as ScheduledJob;
    const hoursSinceSuccess =
      row.last_success_at === null
        ? null
        : (Date.parse(now) - Date.parse(row.last_success_at)) / 3_600_000;
    return {
      job,
      status: statusOf(job, row, hoursSinceSuccess),
      lastRunAt: row.last_run_at,
      lastSuccessAt: row.last_success_at,
      hoursSinceSuccess,
      runs24h: row.runs_24h ?? 0,
      failures24h: row.failures_24h ?? 0,
      clinicsFailed24h: row.clinics_failed_24h ?? 0,
      detail: row.last_detail,
    };
  });
}

function statusOf(job: ScheduledJob, row: JobHealthRow, hoursSinceSuccess: number | null): JobStatus {
  if (row.last_run_at === null) return "never_run";
  if (hoursSinceSuccess === null || hoursSinceSuccess > JOB_STALE_AFTER_HOURS[job]) return "stale";
  if (row.last_ok === false || row.failures_24h > 0 || row.clinics_failed_24h > 0) return "degraded";
  return "healthy";
}

/** What the admin console says about a job, in plain words. */
export function describeJobHealth(health: JobHealth): string {
  switch (health.status) {
    case "never_run":
      return "Never run. The schedule cannot reach the app — check app_base_url in Vault.";
    case "stale":
      return health.lastSuccessAt === null
        ? "Has never finished successfully."
        : `No successful run in ${Math.floor(health.hoursSinceSuccess ?? 0)} hours.`;
    case "degraded":
      return health.clinicsFailed24h > 0
        ? `Running, but ${health.clinicsFailed24h} clinic${health.clinicsFailed24h === 1 ? "" : "s"} failed in the last 24 hours.`
        : "Running, but the last run failed.";
    case "healthy":
      return `${health.runs24h} run${health.runs24h === 1 ? "" : "s"} in the last 24 hours, all clean.`;
  }
}
