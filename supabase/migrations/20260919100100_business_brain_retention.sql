-- =============================================================================
-- RETENTION FOR THE BUSINESS BRAIN'S OWN TABLES
-- Migration: 20260919100100_business_brain_retention.sql
--
-- WHAT WAS MISSING
--   The retention purge (20260903000500) covers the operational tables that
--   existed when it was written. Six tables have been added since, every one of
--   them growing every day, and none was registered:
--
--     metric_observations    ~35 rows per clinic per day, plus one per rewrite
--     metric_history         registered already, but its version log was not
--     finding_snapshots      one row per clinic-day the briefing was opened
--     clinic_memory_builds   one row per clinic per day, each carrying a jsonb
--     action_completions     one row per action a clinic completes
--     finding_feedback       one row per verdict
--     job_runs               one row per job run, hourly, forever
--
--   "Nothing is ever deleted" was the honest answer for all of them, which is
--   the exact state the original migration was written to end.
--
-- WHAT IS DELIBERATELY NOT HERE
--   The state-history tables — appointment_status_history,
--   treatment_status_history, follow_up_status_history, payment_state_history,
--   patient_state_history — are ABSENT on purpose, and their absence is a
--   decision rather than an oversight.
--
--   They are what "what was known at T" is reconstructed from. Purging them
--   would not shrink a log; it would silently change the answer to questions
--   about the past, and the answers would keep being produced — confidently,
--   from what survived. That is the same reasoning that keeps appointment_history
--   and phi_access_log out of the purge, and it is stated here so the next person
--   to read this file finds the decision instead of the gap.
--
-- PRODUCT DEFAULTS, NOT LEGAL POSITIONS
--   Every number below is an engineering judgement about how long the data stays
--   useful, recorded as such in `legally_confirmed = false`. See
--   docs/RETENTION.md.
-- =============================================================================

insert into retention_policies (key, description, retain_days) values
  ('metric_observations',
   'Every VERSION of every metric reading, including recomputations that never '
   'replaced the current row. The fastest-growing table in the schema: about '
   'thirty-five rows per clinic per day before rewrites. Point-in-time reads '
   'reach back weeks, not years, and metric_history keeps the standing value — '
   'so a year of version history is generous for what reads it.',
   365),

  ('finding_snapshots',
   'What the briefing showed a clinic, one row per clinic-day. The Learning '
   'Engine reads recent weeks to tell "recommended and left" from "never '
   'recommended"; beyond a year the rules themselves will have changed enough '
   'that the comparison stops meaning anything.',
   365),

  ('clinic_memory_builds',
   'Derived memory, rebuilt daily from evidence that is still there. Purging it '
   'loses nothing that cannot be recomputed, which is why it has the shortest '
   'window here.',
   180),

  ('action_completions',
   'What a clinic did about a finding. Read by the Outcome Engine within three '
   'weeks of each completion, and by the Learning Engine over a longer span to '
   'say whether a kind of action has ever worked here. Two years, because that '
   'history is the only thing distinguishing a clinic that acts from one that '
   'does not.',
   730),

  ('finding_feedback',
   'Verdicts on findings. Two years, for the same reason as the completions: a '
   'rule''s precision is measured across clinics and across releases, and a '
   'short window would keep resetting the count.',
   730),

  ('job_runs',
   'One row per scheduled-job run, hourly. Only the most recent run of each job '
   'is read — the rest is a trail for looking back at an incident, which is a '
   'question measured in weeks.',
   90)
on conflict (key) do nothing;

-- =============================================================================
-- THE PURGE, WITH THE NEW BRANCHES
--
-- Replaced whole rather than patched, because the CASE is the security boundary:
-- it is what makes the set of purgeable tables fixed at migration time and
-- visible in one place. Every existing branch is reproduced exactly.
-- =============================================================================

create or replace function run_retention_purge(p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  policy   record;
  affected integer;
  cutoff   timestamptz;
  report   jsonb := '[]'::jsonb;
begin
  -- Transaction-local, so it cannot leak into an unrelated statement on a
  -- pooled connection.
  perform set_config('app.purge_context', 'retention', true);

  for policy in
    select key, retain_days
      from retention_policies
     where enabled = true
       and retain_days is not null
     order by key
  loop
    cutoff   := now() - make_interval(days => policy.retain_days);
    affected := 0;

    -- An explicit CASE rather than dynamic SQL built from the key. The set of
    -- purgeable tables is then fixed at migration time and visible here: a new
    -- row in retention_policies cannot, by itself, cause a table to be deleted
    -- from. That is the property that keeps a clinical table unreachable.
    case policy.key

      when 'queue_entries_completed' then
        if p_dry_run then
          select count(*) into affected
            from queue_entries
           where status = 'completed' and checked_in_at < cutoff;
        else
          delete from queue_entries
           where status = 'completed' and checked_in_at < cutoff;
          get diagnostics affected = row_count;
        end if;

      when 'reminder_logs' then
        if p_dry_run then
          select count(*) into affected from reminder_logs where sent_at < cutoff;
        else
          delete from reminder_logs where sent_at < cutoff;
          get diagnostics affected = row_count;
        end if;

      when 'webhook_logs' then
        if p_dry_run then
          select count(*) into affected from webhook_logs where received_at < cutoff;
        else
          delete from webhook_logs where received_at < cutoff;
          get diagnostics affected = row_count;
        end if;

      when 'metric_history' then
        if p_dry_run then
          select count(*) into affected
            from metric_history where metric_date < cutoff::date;
        else
          delete from metric_history where metric_date < cutoff::date;
          get diagnostics affected = row_count;
        end if;

      when 'problem_dismissals' then
        if p_dry_run then
          select count(*) into affected
            from problem_dismissals where created_at < cutoff;
        else
          delete from problem_dismissals where created_at < cutoff;
          get diagnostics affected = row_count;
        end if;

      when 'phi_access_log' then
        if p_dry_run then
          select count(*) into affected
            from phi_access_log where occurred_at < cutoff;
        else
          delete from phi_access_log where occurred_at < cutoff;
          get diagnostics affected = row_count;
        end if;

      -- ── Added here ─────────────────────────────────────────────────────────

      when 'metric_observations' then
        -- By the day OBSERVED, not the day recorded: a recomputation of an old
        -- day belongs to that day, and keeping it alive because it was written
        -- recently would leave versions of days whose standing value is gone.
        if p_dry_run then
          select count(*) into affected
            from metric_observations where metric_date < cutoff::date;
        else
          delete from metric_observations where metric_date < cutoff::date;
          get diagnostics affected = row_count;
        end if;

      when 'finding_snapshots' then
        if p_dry_run then
          select count(*) into affected
            from finding_snapshots where business_date < cutoff::date;
        else
          delete from finding_snapshots where business_date < cutoff::date;
          get diagnostics affected = row_count;
        end if;

      when 'clinic_memory_builds' then
        if p_dry_run then
          select count(*) into affected
            from clinic_memory_builds where built_for < cutoff::date;
        else
          delete from clinic_memory_builds where built_for < cutoff::date;
          get diagnostics affected = row_count;
        end if;

      when 'action_completions' then
        if p_dry_run then
          select count(*) into affected
            from action_completions where completed_at < cutoff;
        else
          delete from action_completions where completed_at < cutoff;
          get diagnostics affected = row_count;
        end if;

      when 'finding_feedback' then
        if p_dry_run then
          select count(*) into affected
            from finding_feedback where business_date < cutoff::date;
        else
          delete from finding_feedback where business_date < cutoff::date;
          get diagnostics affected = row_count;
        end if;

      when 'job_runs' then
        if p_dry_run then
          select count(*) into affected from job_runs where finished_at < cutoff;
        else
          delete from job_runs where finished_at < cutoff;
          get diagnostics affected = row_count;
        end if;

      when 'deleted_treatment_documents' then
        -- Counted here, removed by the application job: the storage OBJECT has
        -- to go first, and Postgres cannot reach object storage. Deleting the
        -- row from here would orphan the file permanently.
        select count(*) into affected
          from treatment_documents
         where deleted_at is not null and deleted_at < cutoff;

      else
        -- A policy key with no implementation. Reported rather than ignored, so
        -- adding a row without adding a branch is visible in the job output
        -- instead of silently doing nothing.
        report := report || jsonb_build_object(
          'key', policy.key,
          'status', 'no-implementation',
          'rows', 0
        );
        continue;
    end case;

    report := report || jsonb_build_object(
      'key', policy.key,
      'status', case
                  when policy.key = 'deleted_treatment_documents' then 'counted-only'
                  when p_dry_run then 'dry-run'
                  else 'purged'
                end,
      'cutoff', cutoff,
      'rows', affected
    );
  end loop;

  return jsonb_build_object(
    'dry_run', p_dry_run,
    'ran_at', now(),
    'policies', report
  );
end;
$$;

comment on function run_retention_purge(boolean) is
  'Applies retention_policies to OPERATIONAL tables only. Defaults to a DRY '
  'RUN — a function whose default is to delete eventually deletes something by '
  'accident. Clinical, audit and state-history tables are unreachable from '
  'here: the CASE is explicit, so a new policy row cannot by itself cause a '
  'delete. Idempotent and safe to retry.';

revoke all on function run_retention_purge(boolean) from public;
revoke all on function run_retention_purge(boolean) from anon, authenticated;
grant execute on function run_retention_purge(boolean) to service_role;

-- =============================================================================
-- END OF MIGRATION
-- =============================================================================
