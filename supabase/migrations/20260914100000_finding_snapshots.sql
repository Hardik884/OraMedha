-- =============================================================================
-- finding_snapshots — what the Business Brain showed a clinic, day by day
-- Migration: 20260914100000_finding_snapshots.sql
--
-- WHY
--   The learning loop needs to know what was RECOMMENDED, not only what was
--   done. action_completions records that a card was completed; nothing records
--   that a card was shown and left. Without that, "this action is repeatedly
--   ignored" and "this problem has stayed flagged for five weeks" cannot be said
--   at all — reconstructing past findings from stored metrics would re-run today's
--   rules against yesterday's numbers and call the result history.
--
--   One row per clinic-day, written the first time a dentist opens the briefing
--   that day. A day with no row is a day nobody opened it: UNKNOWN, never "nothing
--   was flagged". That distinction is why this is a per-day row with a findings
--   array rather than one row per finding — an empty array is a recorded clear
--   day, and an absent row is not.
--
-- WHAT IT STORES, AND WHAT IT DOES NOT
--   Identifiers and ordinals: finding id, kind, polarity, category, role, rank,
--   severity, whether it was actionable, whether a snooze hid it. No patient ids
--   (opportunity entities are deliberately not copied), no names, no amounts, no
--   free text. The same discipline action_completions and phi_access_log apply.
--
-- NOT AN INPUT TO ANYTHING THAT DECIDES
--   Metrics, signals, diagnoses, constraints and the prioritiser never read this
--   table. The Learning Engine reads it to describe history and may PROPOSE a
--   change; nothing applies a proposal.
-- =============================================================================

create table if not exists finding_snapshots (
  id            uuid        primary key default gen_random_uuid(),
  clinic_id     uuid        not null references clinics (id) on delete cascade,
  -- Clinic-local business date the briefing described.
  business_date date        not null,
  recorded_at   timestamptz not null default now(),
  -- [{ findingId, kind, polarity, category, role, rank, severity, actionable, suppressed }]
  findings      jsonb       not null default '[]'::jsonb,

  constraint uq_finding_snapshots_clinic_day unique (clinic_id, business_date),
  constraint chk_finding_snapshots_array check (jsonb_typeof(findings) = 'array')
);

comment on table finding_snapshots is
  'Append-only record of the Business Brain findings a clinic was shown, one row per '
  'clinic-day, first view wins. Identifiers and ordinals only. A missing day is unknown, '
  'not clear. Read by the Learning Engine; never by anything that decides what to show.';

create index if not exists idx_finding_snapshots_recent
  on finding_snapshots (clinic_id, business_date desc);

-- =============================================================================
-- APPEND-ONLY — the same two mechanisms action_completions uses.
-- =============================================================================

create or replace function finding_snapshots_is_append_only()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception
      'finding_snapshots is append-only: rows cannot be modified'
      using errcode = 'restrict_violation';
  end if;

  if tg_op = 'DELETE'
     and coalesce(current_setting('app.purge_context', true), '') <> 'retention' then
    raise exception
      'finding_snapshots rows may only be deleted by the retention purge'
      using errcode = 'restrict_violation';
  end if;

  return old;
end;
$$;

drop trigger if exists trg_finding_snapshots_append_only on finding_snapshots;
create trigger trg_finding_snapshots_append_only
  before update or delete on finding_snapshots
  for each row execute function finding_snapshots_is_append_only();

-- =============================================================================
-- ROW LEVEL SECURITY
--
-- Dentist read, scoped by clinic AND role. No client write policy: the row is
-- written by the server with the service role after the response is sent, the
-- same arrangement metric_history uses, so no browser can fabricate what a
-- clinic was shown.
-- =============================================================================

alter table finding_snapshots enable row level security;

drop policy if exists "finding_snapshots: dentist read" on finding_snapshots;
create policy "finding_snapshots: dentist read"
  on finding_snapshots for select
  to authenticated
  using (
    clinic_id = (select auth_clinic_id())
    and (select auth_role()) = 'dentist'::user_role
  );

grant select on finding_snapshots to authenticated;
grant select, insert on finding_snapshots to service_role;
