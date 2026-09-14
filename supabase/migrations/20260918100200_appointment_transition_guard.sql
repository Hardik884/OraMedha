-- =============================================================================
-- Appointment status transitions, enforced by the database
-- Migration: 20260918100200_appointment_transition_guard.sql
--
-- WHY
--   updateAppointmentStatus rejects transitions outside the lifecycle, but the
--   RLS UPDATE policies let any clinic staff session set `status` to anything
--   directly through PostgREST: a completed visit reopened, a cancellation
--   undone, a no-show a person recorded turned into a completed visit. Visit
--   counts, revenue per visit, no-show rates and recall outcomes all read the
--   status as fact.
--
-- WHAT
--   For signed-in callers a status change must be one of:
--
--     scheduled   → checked_in | cancelled | no_show          staff
--     checked_in  → in_progress | cancelled | no_show         staff
--     in_progress → completed                                 staff
--     scheduled   → cancelled                                 the patient, own
--     scheduled   → completed                                 dentist: a visit seen
--     checked_in  → completed                                   with no recorded
--                                                               arrival or call-in
--     checked_in  → completed                                 receptionist, when the
--                                                               live queue has the
--                                                               patient in the chair
--     checked_in  → scheduled                                 staff, only when no live
--                                                               queue entry exists (the
--                                                               check-in rollback when
--                                                               the queue insert failed)
--     no_show     → completed                                 dentist, when the no-show
--                                                               was inferred by the
--                                                               nightly job (no actor)
--                                                               within the last 7 days
--
--   completed and cancelled are final. The service role and database jobs are
--   not signed-in callers and are not restricted: the nightly no-show job and
--   server code that already applies these rules run there.
--   Mirrors VALID_APPOINTMENT_TRANSITIONS (types/index.ts) and
--   lib/appointments/visit-completion.ts.
-- =============================================================================

create or replace function appointments_guard_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role user_role;
  v_from text := old.status::text;
  v_to   text := new.status::text;
begin
  if coalesce(auth.role(), '') not in ('authenticated', 'anon') then
    return new;
  end if;

  if v_from in ('completed', 'cancelled') then
    raise exception 'appointments: a % appointment cannot change status', v_from
      using errcode = 'check_violation';
  end if;

  v_role := auth_role();

  if v_role is null or v_role = 'patient' then
    if v_from = 'scheduled' and v_to = 'cancelled' then
      return new;
    end if;
    raise exception 'appointments: cannot change status from % to %', v_from, v_to
      using errcode = 'insufficient_privilege';
  end if;

  -- Staff: the lifecycle.
  if (v_from, v_to) in (
       ('scheduled', 'checked_in'), ('scheduled', 'cancelled'), ('scheduled', 'no_show'),
       ('checked_in', 'in_progress'), ('checked_in', 'cancelled'), ('checked_in', 'no_show'),
       ('in_progress', 'completed')
     ) then
    return new;
  end if;

  -- Check-in rollback: only while nothing is in the queue for this visit.
  if v_from = 'checked_in' and v_to = 'scheduled'
     and not exists (
       select 1 from queue_entries q
        where q.appointment_id = new.id
          and q.removed_at is null
          and q.status in ('waiting', 'in_progress')
     ) then
    return new;
  end if;

  if v_to = 'completed' then
    if v_role = 'dentist' and v_from in ('scheduled', 'checked_in') then
      return new;
    end if;

    if v_from = 'checked_in' and exists (
         select 1 from queue_entries q
          where q.appointment_id = new.id
            and q.removed_at is null
            and q.status = 'in_progress'
       ) then
      return new;
    end if;

    if v_role = 'dentist' and v_from = 'no_show' and exists (
         select 1
           from (
             select h.performed_by, h."timestamp"
               from appointment_history h
              where h.appointment_id = new.id
                and h.new_value ->> 'status' = 'no_show'
              order by h."timestamp" desc
              limit 1
           ) latest
          where latest.performed_by is null
            and latest."timestamp" <= now()
            and latest."timestamp" >= now() - interval '7 days'
       ) then
      return new;
    end if;
  end if;

  raise exception 'appointments: cannot change status from % to %', v_from, v_to
    using errcode = 'check_violation';
end;
$$;

revoke all on function appointments_guard_transition() from public, anon, authenticated;

drop trigger if exists trg_appointments_guard_transition on appointments;
create trigger trg_appointments_guard_transition
  before update of status on appointments
  for each row
  when (old.status is distinct from new.status)
  execute function appointments_guard_transition();
