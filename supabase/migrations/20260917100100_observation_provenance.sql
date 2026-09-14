-- =============================================================================
-- Observation provenance: what a stored Business Brain observation knew, and
-- whether it was measured then or worked out later.
-- Migration: 20260917100100_observation_provenance.sql
--
-- 1. metric_history keeps one row per clinic-day-metric — the CURRENT view the
--    dashboard reads — and gains typed provenance. Every write to it is also
--    appended to metric_observations, so an original measurement stays
--    identifiable after a later recomputation, and a recomputation can never
--    silently take the place of what was measured at the time:
--
--      observed_at_time              computed within three hours after the
--                                    clinic-local day ended, from state as known
--                                    at the end of that day
--      point_in_time_reconstruction  computed later, but only from state as
--                                    known at the end of that day, and from no
--                                    unversioned input (schedule rules, clinic
--                                    settings, queue entries)
--      recomputed_later              computed later from current state
--      unknown                       written before provenance existed
--
--    The current view prefers the better provenance: a lower-quality write is
--    recorded in metric_observations and NOT applied to metric_history. Equal or
--    better quality replaces, which is how a correction still lands.
--
-- 2. finding_snapshots records which run produced it and whether that run was
--    healthy. A snapshot must be recorded during the run's own business day, so
--    one cannot be regenerated later and passed off as what was shown then. Rows
--    written before this migration are run_health 'unknown': the health gate did
--    not exist when they were written, and an empty one may be a failed run.
--
-- 3. clinic_memory_builds records the latest moment its evidence was read as of.
--
-- 4. action_completions.completed_at is the moment the completion was DECLARED.
--    Nothing records when the work itself was done. A declared completion can no
--    longer claim a moment later than its own recording.
--
-- 5. problem_dismissals.created_at is set by the database for client writes, so a
--    snooze cannot be backdated into days that were already shown.
-- =============================================================================

-- =============================================================================
-- 1. METRIC HISTORY
-- =============================================================================

alter table metric_history
  add column if not exists provenance         text        not null default 'unknown',
  add column if not exists produced_at        timestamptz,
  add column if not exists knowledge_as_of    timestamptz,
  add column if not exists unversioned_inputs text[]      not null default '{}';

alter table metric_history
  drop constraint if exists chk_metric_history_provenance;
alter table metric_history
  add constraint chk_metric_history_provenance
  check (provenance in ('observed_at_time', 'point_in_time_reconstruction', 'recomputed_later', 'unknown'));

comment on column metric_history.provenance is
  'How this reading came to exist. See migration 20260917100100.';
comment on column metric_history.produced_at is
  'When the reading was computed. Null for rows written before provenance existed.';
comment on column metric_history.knowledge_as_of is
  'The latest moment whose information the computation could use.';
comment on column metric_history.unversioned_inputs is
  'Inputs read as they stood at produced_at because nothing versions them.';

create table if not exists metric_observations (
  id                 uuid             primary key default gen_random_uuid(),
  seq                bigint           generated always as identity,
  clinic_id          uuid             not null references clinics (id) on delete cascade,
  metric_date        date             not null,
  metric_key         text             not null,
  value              double precision not null,
  provenance         text             not null,
  produced_at        timestamptz,
  knowledge_as_of    timestamptz,
  unversioned_inputs text[]           not null default '{}',
  -- False when a better-provenance reading already stood in metric_history.
  applied_to_current boolean          not null,
  recorded_at        timestamptz      not null default now(),

  constraint uq_metric_observations_seq unique (seq),
  constraint chk_metric_observations_provenance
    check (provenance in ('observed_at_time', 'point_in_time_reconstruction', 'recomputed_later', 'unknown'))
);

comment on table metric_observations is
  'Append-only: every reading ever written for a clinic-day-metric, with its provenance, '
  'including ones not applied to metric_history. The source for any question about what '
  'was measured when. See migration 20260917100100.';

create index if not exists idx_metric_observations_day
  on metric_observations (clinic_id, metric_date, metric_key, seq);

insert into metric_observations (clinic_id, metric_date, metric_key, value, provenance, produced_at, knowledge_as_of, applied_to_current)
select clinic_id, metric_date, metric_key, value, 'unknown', null, null, true
  from metric_history;

create or replace function metric_provenance_rank(p text)
returns integer
language sql
immutable
set search_path = public
as $$
  select case p
    when 'observed_at_time' then 3
    when 'point_in_time_reconstruction' then 2
    when 'recomputed_later' then 1
    else 0
  end
$$;

create or replace function metric_history_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_timezone text;
  v_day_end  timestamptz;
begin
  if new.provenance <> 'unknown' then
    if new.produced_at is null or new.knowledge_as_of is null then
      raise exception 'metric_history: % needs produced_at and knowledge_as_of', new.provenance
        using errcode = 'check_violation';
    end if;
    if new.produced_at > now() + interval '5 minutes' or new.knowledge_as_of > new.produced_at then
      raise exception 'metric_history: a reading cannot be produced in the future or know more than its production moment'
        using errcode = 'check_violation';
    end if;
    if new.provenance in ('observed_at_time', 'point_in_time_reconstruction') then
      select timezone into v_timezone from clinic_settings where clinic_id = new.clinic_id;
      v_day_end := (new.metric_date + 1)::timestamp at time zone coalesce(v_timezone, 'UTC');
      if new.knowledge_as_of > v_day_end then
        raise exception 'metric_history: % may not know anything after its own day ended', new.provenance
          using errcode = 'check_violation';
      end if;
      if new.provenance = 'observed_at_time'
         and (new.produced_at < v_day_end or new.produced_at > v_day_end + interval '3 hours') then
        raise exception 'metric_history: observed_at_time must be produced within three hours after its day ended'
          using errcode = 'check_violation';
      end if;
    end if;
  end if;

  if tg_op = 'UPDATE' and metric_provenance_rank(new.provenance) < metric_provenance_rank(old.provenance) then
    insert into metric_observations (clinic_id, metric_date, metric_key, value, provenance, produced_at, knowledge_as_of, unversioned_inputs, applied_to_current)
    values (new.clinic_id, new.metric_date, new.metric_key, new.value, new.provenance, new.produced_at, new.knowledge_as_of, new.unversioned_inputs, false);
    return old;
  end if;
  return new;
end;
$$;

create or replace function metric_history_after_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into metric_observations (clinic_id, metric_date, metric_key, value, provenance, produced_at, knowledge_as_of, unversioned_inputs, applied_to_current)
  values (new.clinic_id, new.metric_date, new.metric_key, new.value, new.provenance, new.produced_at, new.knowledge_as_of, new.unversioned_inputs, true);
  return null;
end;
$$;

revoke all on function metric_history_before_write() from public, anon, authenticated;
revoke all on function metric_history_after_write() from public, anon, authenticated;

drop trigger if exists trg_metric_history_before_write on metric_history;
create trigger trg_metric_history_before_write
  before insert or update on metric_history
  for each row execute function metric_history_before_write();

drop trigger if exists trg_metric_history_after_insert on metric_history;
create trigger trg_metric_history_after_insert
  after insert on metric_history
  for each row execute function metric_history_after_write();

drop trigger if exists trg_metric_history_after_update on metric_history;
create trigger trg_metric_history_after_update
  after update on metric_history
  for each row
  when (old.* is distinct from new.*)
  execute function metric_history_after_write();

drop trigger if exists trg_metric_observations_guard on metric_observations;
create trigger trg_metric_observations_guard
  before update or delete on metric_observations
  for each row execute function entity_state_history_guard('clinics', 'clinic_id');

alter table metric_observations enable row level security;

drop policy if exists "metric_observations: dentist read" on metric_observations;
create policy "metric_observations: dentist read"
  on metric_observations for select
  to authenticated
  using (clinic_id = (select auth_clinic_id()) and (select auth_role()) = 'dentist'::user_role);

revoke all on metric_observations from anon, authenticated, service_role;
grant select on metric_observations to authenticated, service_role;

-- =============================================================================
-- 2. FINDING SNAPSHOTS
-- =============================================================================

alter table finding_snapshots
  add column if not exists run_health     text        not null default 'unknown',
  add column if not exists run_started_at timestamptz,
  add column if not exists brain_version  text;

alter table finding_snapshots drop constraint if exists chk_finding_snapshots_run_health;
alter table finding_snapshots
  add constraint chk_finding_snapshots_run_health
  check (
    run_health in ('healthy', 'unknown')
    and (run_health <> 'healthy' or (run_started_at is not null and brain_version is not null))
  );

comment on column finding_snapshots.run_health is
  'healthy: recorded from a run in which every stage succeeded. unknown: recorded before '
  'run health was tracked — an empty unknown snapshot may be a failed run, not a quiet day.';

create or replace function finding_snapshots_validate_run()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_timezone text;
begin
  if new.run_started_at is null then
    return new;
  end if;
  select timezone into v_timezone from clinic_settings where clinic_id = new.clinic_id;
  if (new.run_started_at at time zone coalesce(v_timezone, 'UTC'))::date <> new.business_date then
    raise exception 'finding_snapshots: the run must have started on the business day it describes'
      using errcode = 'check_violation';
  end if;
  if new.recorded_at < new.run_started_at - interval '5 minutes'
     or new.recorded_at > new.run_started_at + interval '2 hours' then
    raise exception 'finding_snapshots: a snapshot is recorded by the run that showed it, not regenerated later'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function finding_snapshots_validate_run() from public, anon, authenticated;

drop trigger if exists trg_finding_snapshots_validate_run on finding_snapshots;
create trigger trg_finding_snapshots_validate_run
  before insert on finding_snapshots
  for each row execute function finding_snapshots_validate_run();

-- =============================================================================
-- 3. CLINIC MEMORY BUILDS
-- =============================================================================

alter table clinic_memory_builds
  add column if not exists knowledge_as_of timestamptz;

comment on column clinic_memory_builds.knowledge_as_of is
  'Every evidence read behind this build was bounded to this moment: the end of built_for, '
  'or the build time if earlier. Null for builds written before it was recorded.';

-- =============================================================================
-- 4. ACTION COMPLETIONS — completed_at is the declaration moment
-- =============================================================================

comment on column action_completions.completed_at is
  'When the completion was DECLARED (for source=declared) — not when the work was done, '
  'which nothing records.';

alter table action_completions drop constraint if exists chk_action_completions_declared_not_after_recording;
alter table action_completions
  add constraint chk_action_completions_declared_not_after_recording
  check (completed_at <= created_at + interval '1 minute') not valid;

-- =============================================================================
-- 5. PROBLEM DISMISSALS — a client cannot backdate a snooze
-- =============================================================================

create or replace function problem_dismissals_stamp_created_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') in ('authenticated', 'anon') then
    new.created_at := now();
  end if;
  return new;
end;
$$;

revoke all on function problem_dismissals_stamp_created_at() from public, anon, authenticated;

drop trigger if exists trg_problem_dismissals_stamp_created_at on problem_dismissals;
create trigger trg_problem_dismissals_stamp_created_at
  before insert on problem_dismissals
  for each row execute function problem_dismissals_stamp_created_at();
