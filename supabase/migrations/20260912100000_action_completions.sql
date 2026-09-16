-- =============================================================================
-- action_completions — the record that a clinic actually did the thing
-- Migration: 20260912100000_action_completions.sql
--
-- WHY
--   The Business Brain ends at Action. It prepares work — filtered screens,
--   message drafts, pre-opened forms — and then knows nothing at all about what
--   happened next. The one existing loop-closer, reminder_outcomes.ts, works only
--   because reminder_logs records that a staff member sent a message; every other
--   recommendation on the Morning Briefing is followed by silence.
--
--   Ticking a card's checklist lives in React state and dies on refresh, so the
--   system cannot answer the simplest useful question a clinic will ask: "I did
--   what you told me to — did it work?"
--
--   This table is the missing fact. One append-only row each time an action is
--   completed, carrying enough to verify the intended result afterwards and
--   nothing more.
--
-- WHAT THIS IS NOT
--   Not a task manager. There is no assignee, no due date, no status workflow,
--   no reopening. A row means "this was done, at this moment, by this person".
--
--   Not an input to the Clinic Score. The score reads measured clinic metrics
--   and nothing else, which is what makes it impossible to game by clicking —
--   see lib/business-brain/clinic-health.ts. A completion moves the score only
--   through the data the work actually changed. Nothing here is ever added to it.
--
--   Not a second source of truth for the pipeline. Metrics, signals, diagnoses
--   and constraints are computed exactly as before; this is read alongside them
--   by the Outcome Engine, never fed back into them.
--
-- WHAT IT STORES, AND WHAT IT DELIBERATELY DOES NOT
--   Identifiers and one aggregate. No patient names, no phone numbers, no
--   amounts owed per patient, no clinical text — the same discipline
--   phi_access_log applies, for the same reason: a record about patient-related
--   work that itself contains patient detail widens the blast radius of the next
--   incident instead of narrowing it.
--
--   `target_patient_ids` is the exception that earns its place. Entity-level
--   verification — "6 of the 8 patients you contacted have since been seen" — is
--   only possible if the row remembers WHICH eight, and a count alone cannot
--   distinguish six of the right patients from six unrelated ones. It holds ids
--   only, resolved SERVER-SIDE from the same population the briefing showed;
--   the browser never supplies them.
--
--   `metric_key` / `metric_value` hold the headline reading at the moment of
--   completion. This is the one denormalised measurement in the table and it is
--   necessary rather than convenient: metric_history stores COMPLETED days, so a
--   mid-morning value — the "12" in "the backlog fell from 12 to 3" — cannot be
--   reconstructed from it afterwards. Everything else about the metric is read
--   live or from history.
--
-- WHY NO FOREIGN KEY ON THE TARGETS
--   A uuid[] rather than a child table with `references patients (id)`, and the
--   reason is the record's purpose rather than convenience. This is an audit
--   fact: "on this date, staff reported working these eight targets." A cascade
--   that removed ids when a patient is later deleted would retroactively rewrite
--   the denominator, turning "you cleared 8 of 8" into "6 of 6" — changing
--   history to match the present, which is the one thing an audit row must not
--   do. Audit trails here are built to outlive what they describe (docs/
--   RETENTION.md), and phi_access_log and consent_audit take the same position.
--
--   The correctness cost is handled at READ time instead: the verifier resolves
--   targets through a clinic-scoped query that filters soft-deleted patients, so
--   a deleted patient is excluded from today's verification while the historical
--   record of having been targeted survives intact.
--
--   Stated plainly because it also means this table is invisible to
--   patient-cascade-completeness.spec.ts, which finds tables by their FK
--   declaration. That is the intended outcome, not an oversight.
-- =============================================================================

create table if not exists action_completions (
  id           uuid        primary key default gen_random_uuid(),
  clinic_id    uuid        not null references clinics (id) on delete cascade,

  -- The Business Brain ConstraintCategory the completed action belonged to,
  -- e.g. 'retention', 'revenue_leakage', 'treatment_acceptance'. Text rather
  -- than an enum for the same reason problem_dismissals.category is: categories
  -- are added most releases, and ALTER TYPE ... ADD VALUE cannot run in the same
  -- transaction as the code that uses it.
  category     text        not null,

  -- The stable constraint id the card carried, `constraint.<category>:<clinic>:
  -- <date>`. Ties the completion back to the exact run that recommended it, so a
  -- completion can be matched to the finding rather than only to the category.
  constraint_id text       not null,

  completed_at timestamptz not null default now(),

  -- Who did it. Nullable because a row inferred from clinic data has no human
  -- author, and recording one would be a small lie about provenance.
  completed_by uuid        references profiles (id),

  -- How we know. 'declared' — a staff member pressed Done. 'inferred' — derived
  -- from clinic data changing without anyone saying so. Kept distinct rather than
  -- collapsed into a boolean-ish default because the two carry different
  -- evidential weight and conflating them would let a guess read as a statement.
  source       text        not null,

  -- Optional short note, only where the workflow genuinely needs one. Never
  -- required: forcing a sentence out of someone to close a card is how a
  -- completion button becomes a form nobody presses.
  note         text,

  -- Patient ids the action targeted, resolved server-side. Empty for categories
  -- with no identifiable population (an idle chair targets nobody), which is
  -- exactly the case verification must report as unverifiable rather than as
  -- zero-of-zero success.
  target_patient_ids uuid[] not null default '{}',

  -- The headline metric and its reading when the action was completed. See the
  -- header for why this one measurement is stored rather than derived.
  metric_key   text,
  metric_value numeric,

  created_at   timestamptz not null default now(),

  constraint chk_action_completions_source
    check (source in ('declared', 'inferred')),
  -- A note is optional, but an empty string is not a note. Matches the
  -- problem_dismissals.reason convention: either absent or meaningful.
  constraint chk_action_completions_note
    check (note is null or length(btrim(note)) > 0),
  -- A metric reading is either both halves or neither. One without the other
  -- cannot support the "fell from X to Y" statement it exists for.
  constraint chk_action_completions_metric_pair
    check ((metric_key is null) = (metric_value is null))
);

comment on table action_completions is
  'Append-only record that a Business Brain action was completed, with the patient '
  'ids it targeted and the headline metric reading at that moment. Read by the '
  'Outcome Engine to verify the intended result. Never an input to the Clinic Score.';

comment on column action_completions.target_patient_ids is
  'Patient ids the action targeted, resolved server-side from the same population '
  'the briefing displayed. Ids only — no names, numbers or clinical detail. '
  'Deliberately not a foreign key so the audit fact survives a patient deletion; '
  'soft-deleted patients are excluded at read time by the verifier instead.';

comment on column action_completions.source is
  'declared = a staff member pressed Done. inferred = derived from clinic data. '
  'Never conflated: the two carry different evidential weight.';

-- The hot query: "what has this clinic completed recently, newest first?"
create index if not exists idx_action_completions_recent
  on action_completions (clinic_id, completed_at desc);

-- And the per-category lookup the Outcome Engine uses to pair a completion with
-- the finding it answered.
create index if not exists idx_action_completions_category
  on action_completions (clinic_id, category, completed_at desc);

-- =============================================================================
-- APPEND-ONLY
--
-- Two independent mechanisms, because the one that fails is the one you relied
-- on: RLS withholds UPDATE and DELETE from every client role below, and this
-- trigger blocks them outright — which is what binds the service role, since
-- `service_role` carries BYPASSRLS and no policy can constrain it.
--
-- A completion that the application can silently rewrite is not evidence. If the
-- record could be edited, "you cleared 8 of 8" would be a claim about the
-- current contents of a mutable row rather than about what happened.
--
-- DELETE is permitted in exactly one circumstance, matching phi_access_log: a
-- transaction that has declared itself a retention purge. Nothing in the
-- application sets that, and because it is a transaction-local setting it cannot
-- leak into an unrelated statement.
-- =============================================================================

create or replace function action_completions_is_append_only()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception
      'action_completions is append-only: rows cannot be modified'
      using errcode = 'restrict_violation';
  end if;

  if tg_op = 'DELETE'
     and coalesce(current_setting('app.purge_context', true), '') <> 'retention' then
    raise exception
      'action_completions rows may only be deleted by the retention purge'
      using errcode = 'restrict_violation';
  end if;

  -- Reached only by an authorised delete. Returning OLD lets it proceed; a
  -- `return null` here would SILENTLY CANCEL the row operation and report
  -- success, which is the bug phi_access_log's own trigger had to fix.
  return old;
end;
$$;

comment on function action_completions_is_append_only() is
  'Blocks UPDATE on action_completions unconditionally, and DELETE unless the '
  'transaction has set app.purge_context = ''retention''. Applies to the service '
  'role too, which RLS cannot constrain.';

drop trigger if exists trg_action_completions_append_only on action_completions;
create trigger trg_action_completions_append_only
  before update or delete on action_completions
  for each row execute function action_completions_is_append_only();

-- =============================================================================
-- ROW LEVEL SECURITY
--
-- Dentist-only, matching every other Business Brain surface: the Morning
-- Briefing is a dentist screen, so completing one of its cards is a dentist
-- action. Scoped by BOTH clinic and role — a policy scoped only by tenant is a
-- policy that will be wrong the day a new role joins the tenant (CLAUDE.md
-- §13.10).
--
-- WITH CHECK pins clinic_id to the actor's own clinic, so a client cannot write
-- a completion against another tenant however the request body is shaped. The
-- server action additionally never reads clinic_id from the browser at all.
-- =============================================================================

alter table action_completions enable row level security;

drop policy if exists "action_completions: dentist read" on action_completions;
create policy "action_completions: dentist read"
  on action_completions for select
  to authenticated
  using (
    clinic_id = (select auth_clinic_id())
    and (select auth_role()) = 'dentist'::user_role
  );

drop policy if exists "action_completions: dentist insert" on action_completions;
create policy "action_completions: dentist insert"
  on action_completions for insert
  to authenticated
  with check (
    clinic_id = (select auth_clinic_id())
    and (select auth_role()) = 'dentist'::user_role
  );

-- SELECT and INSERT only. No UPDATE, no DELETE — under RLS the absence of a
-- policy is a denial, and the grant below makes that explicit rather than
-- leaving it to a `for all` policy to imply.
grant select, insert on action_completions to authenticated;
