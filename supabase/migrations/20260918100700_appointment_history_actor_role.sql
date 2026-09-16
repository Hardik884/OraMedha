-- =============================================================================
-- Who made an appointment change, by role
-- Migration: 20260918100700_appointment_history_actor_role.sql
--
-- WHY
--   A cancellation reads the same whether the patient cancelled from the portal
--   or the clinic cancelled on them. appointment_history keeps `performed_by`,
--   but the dentist cannot resolve a portal patient's account to a role (their
--   profile and portal link are not readable to staff, and must not be), so
--   every cancellation's side was unknowable to the Business Brain.
--
-- WHAT
--   `performed_by_role`, stamped by trigger on insert from the actor's profile —
--   every writer, no application change, no new input. A role, not an identity.
--   Null when there was no actor (the nightly no-show job) or the row predates
--   this migration: unknown, never guessed. Existing rows are not backfilled.
-- =============================================================================

alter table appointment_history
  add column if not exists performed_by_role user_role;

comment on column appointment_history.performed_by_role is
  'Role of the actor when the change was recorded (stamped by trigger from profiles). '
  'Null = no actor (a system job) or recorded before 20260918100700.';

create or replace function appointment_history_stamp_actor_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.performed_by is not null then
    select p.role into new.performed_by_role from profiles p where p.id = new.performed_by;
  else
    new.performed_by_role := null;
  end if;
  return new;
end;
$$;

revoke all on function appointment_history_stamp_actor_role() from public, anon, authenticated;

drop trigger if exists trg_appointment_history_actor_role on appointment_history;
create trigger trg_appointment_history_actor_role
  before insert on appointment_history
  for each row
  execute function appointment_history_stamp_actor_role();
