-- =============================================================================
-- finding_feedback — was this worth telling you?
-- Migration: 20260919100000_finding_feedback.sql
--
-- WHY
--   Every other table in this module records what the clinic DID: a snooze, a
--   completion, a decision on a proposal. None of them answers the question the
--   whole briefing rests on — whether what it said was worth saying.
--
--   A snooze is the closest thing available today, and it is a poor proxy: a
--   dentist snoozes a problem that is real and inconvenient just as readily as
--   one that is wrong, so "dismissed" cannot be read as "false". Without a
--   direct answer, precision is unmeasurable, and a rule that fires wrongly for
--   a year looks exactly like one that fires correctly and is ignored.
--
--   Two verdicts, because more would be a survey and nobody fills in a survey
--   before their first patient. "Not relevant" carries a reason, because the
--   reasons are the difference between a rule to retire, a threshold to move,
--   and a finding that is true but not this clinic's priority — three different
--   fixes that look identical in a bare count.
--
-- CORRECTION IS A NEW ROW
--   No unique constraint, and the reader takes the LATEST row per finding. A
--   mis-click has to be correctable — this is an opinion, not a clinical record
--   — and overwriting would lose that the opinion changed, which is itself
--   worth knowing. The same shape data_consent_records uses for withdrawal.
--
-- WHAT IT STORES, AND WHAT IT DOES NOT
--   The finding's id, its kind and its category — identifiers the clinic was
--   already shown — plus a verdict, a reason code and who recorded it. No free
--   text, so no patient name, amount or clinical note can arrive here by
--   accident. The same discipline finding_snapshots and action_completions keep.
--
-- NOT AN INPUT TO ANYTHING THAT DECIDES
--   Nothing in the pipeline reads this table. It measures the pipeline; a rule
--   that quietened itself because one clinic said "not relevant" would be a rule
--   tuned by its own audience, one click at a time.
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'finding_verdict') then
    create type finding_verdict as enum ('useful', 'not_relevant');
  end if;
  if not exists (select 1 from pg_type where typname = 'finding_feedback_reason') then
    create type finding_feedback_reason as enum (
      -- The finding is true and the clinic already knew. Precision is fine; the
      -- briefing is telling them something they did not need told.
      'already_knew',
      -- The finding is not true of this clinic. The only reason that means the
      -- rule itself is wrong.
      'not_true',
      -- True, and not what this clinic is working on. A ranking problem, not a
      -- correctness one.
      'not_my_priority',
      -- True, and there is nothing they can do about it. An actionability
      -- problem: the finding names something outside the clinic's control.
      'cannot_act',
      'other'
    );
  end if;
end;
$$;

create table if not exists finding_feedback (
  id            uuid        primary key default gen_random_uuid(),
  clinic_id     uuid        not null references clinics (id) on delete cascade,
  -- Clinic-local business date of the briefing the finding was shown on.
  business_date date        not null,
  -- The finding's own id, as shown. Clinic-day scoped, so it identifies the card.
  finding_id    text        not null,
  -- Stable across days, which is what precision is grouped by: a category or a
  -- finding kind answers "does this RULE earn its place", where an id answers
  -- only "was this card useful on Tuesday".
  finding_kind  text        not null,
  category      text,
  verdict       finding_verdict not null,
  -- Required for 'not_relevant' (see the check below), meaningless for 'useful'.
  reason        finding_feedback_reason,
  recorded_by   uuid        references profiles (id) on delete set null,
  recorded_at   timestamptz not null default now(),

  -- A "not relevant" with no reason is a count, and a count cannot be acted on:
  -- it does not say whether to retire the rule, move a threshold or rank it
  -- lower. The UI asks, so the schema requires it.
  constraint chk_finding_feedback_reason
    check (verdict <> 'not_relevant' or reason is not null)
);

comment on table finding_feedback is
  'A dentist''s verdict on one Business Brain finding: useful, or not relevant with a '
  'reason. Append-only; a correction is a new row and the latest wins. Identifiers and '
  'codes only, no free text. Read to measure precision; never read by the pipeline.';

create index if not exists idx_finding_feedback_recent
  on finding_feedback (clinic_id, business_date desc, recorded_at desc);

-- =============================================================================
-- APPEND-ONLY — the same two mechanisms finding_snapshots uses.
-- =============================================================================

create or replace function finding_feedback_is_append_only()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception
      'finding_feedback is append-only: record a new verdict instead of editing one'
      using errcode = 'restrict_violation';
  end if;

  if tg_op = 'DELETE'
     and coalesce(current_setting('app.purge_context', true), '') <> 'retention' then
    raise exception
      'finding_feedback rows may only be deleted by the retention purge'
      using errcode = 'restrict_violation';
  end if;

  return old;
end;
$$;

drop trigger if exists trg_finding_feedback_append_only on finding_feedback;
create trigger trg_finding_feedback_append_only
  before update or delete on finding_feedback
  for each row execute function finding_feedback_is_append_only();

-- =============================================================================
-- ROW LEVEL SECURITY
--
-- The dentist of the clinic may read and write their own clinic's feedback —
-- the same arrangement problem_dismissals has, and for the same reason: this is
-- a decision the dentist makes, not a measurement the server takes.
--
-- The INSERT policy pins clinic_id and recorded_by rather than trusting the
-- body, so a browser cannot file feedback against another clinic or in someone
-- else's name. There is no UPDATE or DELETE policy, and under RLS the absence of
-- a policy is a denial; the trigger above binds the service role too.
-- =============================================================================

alter table finding_feedback enable row level security;

drop policy if exists "finding_feedback: dentist read" on finding_feedback;
create policy "finding_feedback: dentist read"
  on finding_feedback for select
  to authenticated
  using (
    clinic_id = (select auth_clinic_id())
    and (select auth_role()) = 'dentist'::user_role
  );

drop policy if exists "finding_feedback: dentist record" on finding_feedback;
create policy "finding_feedback: dentist record"
  on finding_feedback for insert
  to authenticated
  with check (
    clinic_id = (select auth_clinic_id())
    and (select auth_role()) = 'dentist'::user_role
    and recorded_by = (select auth.uid())
  );

grant select, insert on finding_feedback to authenticated;
grant select, insert on finding_feedback to service_role;
