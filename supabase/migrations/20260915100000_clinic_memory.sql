-- =============================================================================
-- Clinic memory: human decisions, and rebuildable memory builds
-- Migration: 20260915100000_clinic_memory.sql
--
-- WHAT IS STORED, AND WHY ONLY THIS
--   Clinic memory is DERIVED from evidence the database already holds —
--   metric_history, finding_snapshots, action_completions and the clinic's own
--   tables. Two things cannot be derived, so they are stored:
--
--   clinic_decisions        a person accepting or rejecting a learning proposal,
--                           or rejecting a memory. Intent is a fact only a human
--                           can create. Append-only; the latest row per target
--                           governs, and a revocation is a new row.
--
--   clinic_memory_builds    the output of deriving memory for one clinic-day,
--                           written by the scheduled job so a dashboard load reads
--                           one row instead of a year of history. A CACHE, not an
--                           authority: rebuilding from the same evidence gives the
--                           same entries and the same digest, which the tests
--                           assert. Builds are append-only so earlier memory is
--                           never silently rewritten.
--
-- WHAT NEITHER TABLE MAY HOLD
--   Patient ids, names, phone numbers, notes, clinical free text, amounts per
--   patient, or generated prose. Decision targets are constrained to the
--   engine's identifier shape; the memory jsonb holds codes, dates and numbers.
--   There is no free-text column on either table.
-- =============================================================================

create table if not exists clinic_decisions (
  id            uuid        primary key default gen_random_uuid(),
  clinic_id     uuid        not null references clinics (id) on delete cascade,
  target_type   text        not null,
  -- `proposal.<kind>:learning.<kind>:<subject>:<clinic>` or `memory.<type>:...`
  target_id     text        not null,
  proposal_kind text,
  subject       text        not null,
  decision      text        not null,
  -- The evidence as it stood when the decision was made: codes and numbers.
  basis         jsonb       not null default '{}'::jsonb,
  decided_by    uuid        not null references profiles (id),
  decided_at    timestamptz not null default now(),

  constraint chk_clinic_decisions_target_type check (target_type in ('proposal', 'memory')),
  constraint chk_clinic_decisions_decision check (decision in ('accepted', 'rejected', 'revoked')),
  constraint chk_clinic_decisions_target_shape
    check (target_id ~ '^(proposal|memory)\.[a-z_]+:[A-Za-z0-9_.:-]+$' and length(target_id) <= 300),
  constraint chk_clinic_decisions_target_prefix
    check (starts_with(target_id, target_type || '.')),
  constraint chk_clinic_decisions_subject check (subject ~ '^[a-z0-9_.]+$' and length(subject) <= 100),
  constraint chk_clinic_decisions_proposal_kind
    check (proposal_kind is null or proposal_kind in ('threshold_adjustment', 'action_preference', 'workflow_improvement', 'confidence_adjustment')),
  constraint chk_clinic_decisions_basis check (jsonb_typeof(basis) = 'object')
);

comment on table clinic_decisions is
  'Append-only human decisions on Business Brain learning proposals and clinic memories. '
  'The latest row per target governs; a revocation is a new row. Nothing in the Business '
  'Brain applies a decision implicitly.';

create index if not exists idx_clinic_decisions_target
  on clinic_decisions (clinic_id, target_type, target_id, decided_at);

create table if not exists clinic_memory_builds (
  id                 uuid        primary key default gen_random_uuid(),
  clinic_id          uuid        not null references clinics (id) on delete cascade,
  -- The last completed business day the evidence runs to.
  built_for          date        not null,
  derivation_version text        not null,
  window_from        date        not null,
  window_to          date        not null,
  -- Deterministic digest of entries and decisions: same evidence, same digest.
  digest             text        not null,
  memory             jsonb       not null,
  built_at           timestamptz not null default now(),

  constraint uq_clinic_memory_builds unique (clinic_id, built_for, derivation_version),
  constraint chk_clinic_memory_builds_object check (jsonb_typeof(memory) = 'object'),
  constraint chk_clinic_memory_builds_window check (window_from <= window_to and window_to = built_for)
);

comment on table clinic_memory_builds is
  'Rebuildable cache of derived clinic memory, one row per clinic-day and derivation '
  'version, written by the scheduled job. Not an authority: the evidence tables are.';

create index if not exists idx_clinic_memory_builds_latest
  on clinic_memory_builds (clinic_id, built_for desc, built_at desc);

-- =============================================================================
-- APPEND-ONLY — both tables, the same two mechanisms action_completions uses.
-- =============================================================================

create or replace function clinic_memory_is_append_only()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception '% is append-only: rows cannot be modified', tg_table_name
      using errcode = 'restrict_violation';
  end if;

  if tg_op = 'DELETE'
     and coalesce(current_setting('app.purge_context', true), '') <> 'retention' then
    raise exception '% rows may only be deleted by the retention purge', tg_table_name
      using errcode = 'restrict_violation';
  end if;

  return old;
end;
$$;

drop trigger if exists trg_clinic_decisions_append_only on clinic_decisions;
create trigger trg_clinic_decisions_append_only
  before update or delete on clinic_decisions
  for each row execute function clinic_memory_is_append_only();

drop trigger if exists trg_clinic_memory_builds_append_only on clinic_memory_builds;
create trigger trg_clinic_memory_builds_append_only
  before update or delete on clinic_memory_builds
  for each row execute function clinic_memory_is_append_only();

-- =============================================================================
-- ROW LEVEL SECURITY
--
-- Dentist-only, scoped by clinic AND role, like every Business Brain surface.
--
-- A decision is written by the dentist's own session: WITH CHECK pins the clinic
-- to theirs AND the author to themselves, so nobody can record a decision in
-- another clinic's name or in another person's.
--
-- A memory build is written only by the service role in the scheduled job. No
-- client may author memory.
-- =============================================================================

alter table clinic_decisions enable row level security;
alter table clinic_memory_builds enable row level security;

drop policy if exists "clinic_decisions: dentist read" on clinic_decisions;
create policy "clinic_decisions: dentist read"
  on clinic_decisions for select
  to authenticated
  using (
    clinic_id = (select auth_clinic_id())
    and (select auth_role()) = 'dentist'::user_role
  );

drop policy if exists "clinic_decisions: dentist insert" on clinic_decisions;
create policy "clinic_decisions: dentist insert"
  on clinic_decisions for insert
  to authenticated
  with check (
    clinic_id = (select auth_clinic_id())
    and (select auth_role()) = 'dentist'::user_role
    and decided_by = (select auth.uid())
  );

drop policy if exists "clinic_memory_builds: dentist read" on clinic_memory_builds;
create policy "clinic_memory_builds: dentist read"
  on clinic_memory_builds for select
  to authenticated
  using (
    clinic_id = (select auth_clinic_id())
    and (select auth_role()) = 'dentist'::user_role
  );

grant select, insert on clinic_decisions to authenticated;
grant select on clinic_memory_builds to authenticated;
grant select, insert on clinic_decisions, clinic_memory_builds to service_role;
