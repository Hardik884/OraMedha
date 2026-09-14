-- =============================================================================
-- Follow-up status guard
-- Migration: 20260918100000_follow_up_status_guard.sql
--
-- WHY
--   completeFollowUp and cancelFollowUp are dentist-only and one-way (pending →
--   completed / cancelled). updateFollowUp accepted any status from any staff
--   member, and the RLS UPDATE policies let a receptionist's session set any
--   status directly — so a receptionist could close a follow-up, and anyone could
--   reopen a completed or cancelled one. Overdue counts, recall send lists and
--   retention outcomes all read these statuses as facts.
--
-- WHAT
--   For signed-in callers, a follow-up's status may change only:
--     - from pending, to completed or cancelled, by the clinic's dentist; or
--     - from pending to completed by a receptionist, when the follow-up's recall
--       appointment (appointments.follow_up_id) is already completed. That is the
--       completion cascade run by "Mark Done & Call Next", which a receptionist
--       may press — the only receptionist path that closes a follow-up.
--   Completed and cancelled are final for everyone signed in.
--
--   The service role and database jobs are not signed-in callers and are not
--   restricted here: they run server code that already applies the rules.
--   Inserts are unchanged (historical entry of a closed follow-up stays allowed).
-- =============================================================================

create or replace function follow_ups_guard_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role user_role;
begin
  if coalesce(auth.role(), '') not in ('authenticated', 'anon') then
    return new;
  end if;

  if old.status <> 'pending' then
    raise exception 'follow_ups: a % follow-up cannot be reopened or changed', old.status
      using errcode = 'check_violation';
  end if;

  v_role := auth_role();
  if v_role = 'dentist' then
    return new;
  end if;

  if v_role = 'receptionist'
     and new.status = 'completed'
     and exists (
       select 1
         from appointments a
        where a.follow_up_id = new.id
          and a.clinic_id = new.clinic_id
          and a.status = 'completed'
          and a.deleted_at is null
     ) then
    return new;
  end if;

  raise exception 'follow_ups: only the dentist can complete or cancel a follow-up'
    using errcode = 'insufficient_privilege';
end;
$$;

revoke all on function follow_ups_guard_status() from public, anon, authenticated;

drop trigger if exists trg_follow_ups_guard_status on follow_ups;
create trigger trg_follow_ups_guard_status
  before update of status on follow_ups
  for each row
  when (old.status is distinct from new.status)
  execute function follow_ups_guard_status();
