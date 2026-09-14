-- =============================================================================
-- What a reminder was about
-- Migration: 20260918100600_reminder_subject.sql
--
-- WHY
--   reminder_logs recorded that a patient was sent a recall, a payment reminder
--   or a treatment-plan nudge — but not WHICH follow-up, which planned treatment
--   or what balance. A later booking or payment could only be matched to "some
--   reminder of this kind", so an outcome could be credited to a message about
--   something else entirely.
--
-- WHAT
--   Three nullable subject columns, filled automatically by markReminderSent
--   from the same populations the send list is built from — no new field for
--   staff to fill in:
--     subject_follow_up_id   recall_invitation: the overdue follow-up
--     subject_treatment_id   treatment_plan_follow_up: the planned treatment
--     subject_amount         payment_reminder: the balance outstanding when sent
--   Null means the subject could not be resolved at send time: not known, never
--   "about nothing". A subject must belong to the same clinic and patient, and
--   only fits its own kind. Existing rows are left as they are.
-- =============================================================================

alter table reminder_logs
  add column if not exists subject_follow_up_id uuid references follow_ups (id),
  add column if not exists subject_treatment_id uuid references treatments (id),
  add column if not exists subject_amount numeric(10, 2);

alter table reminder_logs drop constraint if exists chk_reminder_logs_subject_kind;
alter table reminder_logs
  add constraint chk_reminder_logs_subject_kind check (
        (subject_follow_up_id is null or kind = 'recall_invitation')
    and (subject_treatment_id is null or kind = 'treatment_plan_follow_up')
    and (subject_amount is null or (kind = 'payment_reminder' and subject_amount >= 0))
  );

comment on column reminder_logs.subject_follow_up_id is
  'The overdue follow-up a recall invitation was about. Null = not resolved at send time.';
comment on column reminder_logs.subject_treatment_id is
  'The planned treatment a treatment-plan reminder was about. Null = not resolved at send time.';
comment on column reminder_logs.subject_amount is
  'The outstanding balance when a payment reminder was sent. Null = not resolved at send time.';

create or replace function reminder_logs_validate_subject()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.subject_follow_up_id is not null and not exists (
       select 1 from follow_ups f
        where f.id = new.subject_follow_up_id
          and f.clinic_id = new.clinic_id
          and f.patient_id = new.patient_id
     ) then
    raise exception 'reminder_logs: subject follow-up does not belong to this patient'
      using errcode = 'check_violation';
  end if;
  if new.subject_treatment_id is not null and not exists (
       select 1 from treatments t
        where t.id = new.subject_treatment_id
          and t.clinic_id = new.clinic_id
          and t.patient_id = new.patient_id
     ) then
    raise exception 'reminder_logs: subject treatment does not belong to this patient'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function reminder_logs_validate_subject() from public, anon, authenticated;

drop trigger if exists trg_reminder_logs_validate_subject on reminder_logs;
create trigger trg_reminder_logs_validate_subject
  before insert or update of subject_follow_up_id, subject_treatment_id on reminder_logs
  for each row
  execute function reminder_logs_validate_subject();
