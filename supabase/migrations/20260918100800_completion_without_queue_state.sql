-- =============================================================================
-- Completing a checked-in visit never depends on the queue
-- Migration: 20260918100800_completion_without_queue_state.sql
--
-- WHY
--   20260918100200 let a receptionist complete a `checked_in` appointment only
--   while a live queue entry for it was `in_progress`. The queue and the
--   appointment can drift apart — a check-in whose status update failed, an
--   entry left behind, a visit started from the appointment list — and then
--   "Mark Done & Call Next" could not close the visit, the chair stayed
--   occupied, and nobody else could be called.
--
-- WHAT
--   `checked_in` → `completed` is allowed for any staff member: the arrival is
--   recorded, so completing it invents nothing. The queue is no longer consulted.
--   `scheduled` → `completed` (no recorded arrival) stays the dentist's alone.
--   Every other rule is unchanged. The application side is lib/queue/advance.ts,
--   which closes the chair and calls the next patient whatever state the queue is
--   in.
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
    -- A checked-in patient's arrival is recorded: any staff member may close the
    -- visit, whatever the queue says. Only a visit with NO recorded arrival
    -- (still scheduled) is the dentist's alone to complete.
    if v_from = 'checked_in' then
      return new;
    end if;

    if v_role = 'dentist' and v_from = 'scheduled' then
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
