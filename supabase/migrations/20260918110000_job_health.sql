-- =============================================================================
-- Scheduled jobs record their own runs
-- Migration: 20260918110000_job_health.sql
--
-- WHY
--   pg_cron records a run as "succeeded" the moment pg_net accepts the request;
--   the HTTP response lands in a schema no app role can read, and pg_net keeps it
--   for a few hours. So between the Vercel project rename and 18 Sep 2026 every
--   hourly call to /api/cron/metric-history and /api/cron/no-show-detection came
--   back 404 "deployment not found", pg_cron reported success throughout, and the
--   failure was invisible: the hosted project had no reading recorded at the
--   time, no clinic memory build at all, and no no-show ever detected.
--
--   Asking pg_cron whether the work happened is the wrong question. Only the job
--   itself knows. So each job writes a row when it finishes, and health is read
--   from those rows: a job that never ran leaves no row, which is exactly the
--   signal that was missing.
--
-- WHAT
--   `job_runs` — one row per completed run: which job, when it started and
--   finished, whether it succeeded, how many clinics it handled and how many
--   failed, and a short detail string for a failure. No URL, no token, no
--   patient data, no clinic data beyond counts.
--
--   Written by the service role only (the cron route handlers). Read by the
--   platform admin, for every clinic — this is platform health, not clinic data.
--   `job_health` summarises the latest run and the last 24 hours per job.
-- =============================================================================

create table if not exists job_runs (
  id            uuid        primary key default gen_random_uuid(),
  job           text        not null,
  started_at    timestamptz not null,
  finished_at   timestamptz not null default now(),
  ok            boolean     not null,
  /** Units of work the run handled — clinics, for both of today's jobs. */
  handled       integer     not null default 0,
  /** How many of those failed. A run can succeed overall with some failures. */
  failed        integer     not null default 0,
  /** Short, non-sensitive reason when the run failed. Never a response body. */
  detail        text,

  constraint chk_job_runs_job check (job in ('metric_history', 'no_show_detection')),
  constraint chk_job_runs_counts check (handled >= 0 and failed >= 0 and failed <= handled),
  constraint chk_job_runs_order check (finished_at >= started_at),
  constraint chk_job_runs_detail check (detail is null or length(detail) <= 500)
);

create index if not exists idx_job_runs_job_finished on job_runs (job, finished_at desc);

comment on table job_runs is
  'One row per completed run of a scheduled job, written by the route handler itself. '
  'Platform health only: counts and timings, never clinic or patient data. See 20260918110000.';

alter table job_runs enable row level security;

-- No client write policy at all: the service role writes these, and RLS does not
-- bind it. The same shape every audit table in this schema uses.
drop policy if exists "job_runs: admin read" on job_runs;
create policy "job_runs: admin read"
  on job_runs for select
  using (coalesce(auth_is_admin(), false));

/**
 * Health per job: its latest run, and the last 24 hours.
 *
 * A job with no row has never completed a run — reported as nulls and zero
 * counts, which reads as unknown rather than healthy.
 */
create or replace function job_health()
returns table (
  job                text,
  last_run_at        timestamptz,
  last_success_at    timestamptz,
  last_ok            boolean,
  last_detail        text,
  runs_24h           integer,
  failures_24h       integer,
  clinics_failed_24h integer
)
language sql
stable
security invoker
set search_path = public
as $$
  select j.job,
         (select max(r.finished_at) from job_runs r where r.job = j.job),
         (select max(r.finished_at) from job_runs r where r.job = j.job and r.ok),
         (select r.ok from job_runs r where r.job = j.job order by r.finished_at desc limit 1),
         (select r.detail from job_runs r where r.job = j.job order by r.finished_at desc limit 1),
         (select count(*)::int from job_runs r where r.job = j.job and r.finished_at > now() - interval '24 hours'),
         (select count(*)::int from job_runs r where r.job = j.job and not r.ok and r.finished_at > now() - interval '24 hours'),
         (select coalesce(sum(r.failed), 0)::int from job_runs r where r.job = j.job and r.finished_at > now() - interval '24 hours')
    from (values ('metric_history'), ('no_show_detection')) as j(job)
   order by j.job
$$;

comment on function job_health() is
  'Latest run and 24-hour summary per scheduled job. security invoker: the reader '
  'sees only what job_runs RLS allows them, which is the platform admin.';
