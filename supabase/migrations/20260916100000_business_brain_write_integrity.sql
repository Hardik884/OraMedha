-- =============================================================================
-- Business Brain write integrity
-- Migration: 20260916100000_business_brain_write_integrity.sql
--
-- WHY
--   Two Business Brain tables accepted INSERTs straight from a signed-in
--   dentist's session. RLS pinned the clinic, but nothing else: a request sent to
--   PostgREST directly, bypassing the server actions, could store
--
--     action_completions  any target_patient_ids, any headline reading, and a
--                         constraint_id naming another clinic — which made the
--                         Learning and Memory engines refuse the whole clinic's
--                         history as cross-tenant on every build;
--     clinic_decisions    any basis JSON, including free text, which memory
--                         builds then copied into stored memory.
--
--   The server actions already resolve every one of those facts server-side. So
--   the client write path is closed, the actions write with the service role
--   after validating, and the database itself refuses the shapes that must never
--   be stored — so a future writer cannot reintroduce them by accident.
--
-- EXISTING ROWS
--   The checks are added NOT VALID: they bind every new row immediately and do
--   not fail on rows written before this migration. Engines keep refusing a
--   malformed historical row on their own.
-- =============================================================================

-- ── action_completions ───────────────────────────────────────────────────────

-- `constraint.<category>:<this row's clinic>:<YYYY-MM-DD>` — the id the briefing
-- card carried, for this clinic and this category only.
alter table action_completions
  drop constraint if exists chk_action_completions_constraint_id;
alter table action_completions
  add constraint chk_action_completions_constraint_id
  check (
    constraint_id = 'constraint.' || category || ':' || clinic_id::text || ':' || substring(constraint_id from '[0-9]{4}-[0-9]{2}-[0-9]{2}$')
    and constraint_id ~ ':[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  ) not valid;

drop policy if exists "action_completions: dentist insert" on action_completions;
revoke insert on action_completions from authenticated;
grant select, insert on action_completions to service_role;

-- The idempotency lookup: one completion per clinic and briefing card.
create index if not exists idx_action_completions_constraint
  on action_completions (clinic_id, constraint_id, completed_at);

-- ── clinic_decisions ─────────────────────────────────────────────────────────

-- A basis is codes and numbers: every value a number, null, or a short code.
create or replace function jsonb_values_are_codes(value jsonb)
returns boolean
language sql
immutable
as $$
  select jsonb_typeof(value) = 'object'
     and not exists (
       select 1
       from jsonb_each(value) as e(key, v)
       where e.key !~ '^[A-Za-z0-9_]{1,64}$'
          or not (
            jsonb_typeof(e.v) in ('number', 'null')
            or (jsonb_typeof(e.v) = 'string' and (e.v #>> '{}') ~ '^[A-Za-z0-9_.:-]{0,160}$')
          )
     );
$$;

comment on function jsonb_values_are_codes(jsonb) is
  'True when a jsonb object holds only identifier-shaped keys and number, null or '
  'short code values — never free text. Used to keep prose and PII out of stored decisions.';

alter table clinic_decisions
  drop constraint if exists chk_clinic_decisions_basis_codes;
alter table clinic_decisions
  add constraint chk_clinic_decisions_basis_codes
  check (jsonb_values_are_codes(basis)) not valid;

-- Every proposal and memory id ends with the clinic it belongs to.
alter table clinic_decisions
  drop constraint if exists chk_clinic_decisions_target_clinic;
alter table clinic_decisions
  add constraint chk_clinic_decisions_target_clinic
  check (right(target_id, 37) = ':' || clinic_id::text) not valid;

drop policy if exists "clinic_decisions: dentist insert" on clinic_decisions;
revoke insert on clinic_decisions from authenticated;
