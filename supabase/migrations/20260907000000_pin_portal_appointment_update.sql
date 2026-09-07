-- =============================================================================
-- Pin the patient-portal UPDATE policy on `appointments`
-- Migration: 20260907000000_pin_portal_appointment_update.sql
--
-- WHAT WAS WRONG
--   20260619000001 (FIX-G) replaced the portal UPDATE policy with one that
--   "adds WITH CHECK to prevent field tampering":
--
--     create policy "appointments: portal update own"
--       on appointments for update
--       using      (patient_id = auth_patient_id() and deleted_at is null
--                   and status in ('scheduled','checked_in'))
--       with check (patient_id = auth_patient_id() and deleted_at is null);
--
--   It prevents no tampering. `patient_id = auth_patient_id()` is a column the
--   caller never changes, so the WITH CHECK asserts nothing about the rest of
--   the row — the identical defect 20260903000100 documented and fixed on
--   `patients`, which never got carried across to `appointments`.
--
--   There is no column-level backstop either: 20260727000002 grants
--   `select, insert, update, delete` on ALL tables to `authenticated`,
--   table-wide. The anon key and project URL ship in the client bundle by
--   design and the patient's JWT is in their own cookie jar, so this is
--   reachable from a browser console. Reproduced against a real database:
--
--     -- as a portal patient, on their OWN appointment
--     update appointments
--        set scheduled_at = '2030-12-25 03:00:00+00',
--            duration_minutes = 600,
--            status = 'completed'
--      where id = <their appointment>;                         -- UPDATE 1
--
--     update appointments
--        set clinic_id = <another clinic>,
--            oral_findings = 'TAMPERED',
--            notes = 'TAMPERED'
--      where id = <their appointment>;                         -- UPDATE 1
--
--   What that costs:
--     - self-reschedule to any instant, bypassing availability_rules, clinic
--       hours, the past-date rule and computeSlots entirely;
--     - status = 'completed' WITHOUT completeAppointmentCascade, so no visit
--       increment and no appointment_history row — "Patients Seen Today" and
--       the completion rate are simply wrong;
--     - duration_minutes = 600, which corrupts every capacity metric;
--     - clinic_id moved to another tenant, putting the appointment in a clinic
--       that cannot read the patient it references.
--
--   Changing `dentist_id` happens to fail today, but only incidentally:
--   validate_dentist_role() is not SECURITY DEFINER, so its profiles lookup
--   runs under the caller's RLS, a patient cannot see another clinic's dentist
--   row, and the trigger raises "does not reference a valid profile". That is
--   luck, not a control, and it is pinned properly below.
--
-- THE FIX
--   Pin by DENY-LIST rather than allow-list.
--
--   20260903000100 named the nine columns the portal may not change. One day
--   later 20260904184013 added `patients.email` and did not add it to the pin,
--   so the list was already incomplete — which is the failure mode of naming
--   what is forbidden. This policy names what is PERMITTED instead:
--
--     to_jsonb(new row) - 'status' - 'updated_at'  =  the pre-update row
--
--   Every other column, including any column added later, is frozen by
--   default. A future migration adding a field to `appointments` cannot
--   silently widen what a patient may write.
--
--   The two exceptions are exactly what cancelAppointment writes:
--     status      — and WITH CHECK constrains it to 'cancelled' specifically,
--                   so the portal can cancel and can do nothing else;
--     updated_at  — set by the set_updated_at trigger.
--
--   The pre-update snapshot is read through a STABLE SECURITY DEFINER helper,
--   the same two load-bearing properties 20260903000100 relied on:
--     SECURITY DEFINER — reads `appointments` from inside an `appointments`
--       policy without recursing through RLS;
--     STABLE — evaluated against the snapshot taken at statement start, so it
--       returns the row as it was BEFORE this UPDATE. That is what makes the
--       comparison a real no-change assertion rather than a tautology.
--
--   The helper is scoped to the caller's OWN appointments, so it cannot be used
--   as an oracle to read anyone else's row.
--
-- SCOPE
--   `to authenticated` only. service_role is exempt from RLS, which is what the
--   staff reschedule/cancel paths and completeAppointmentCascade use where they
--   legitimately change pinned columns.
-- =============================================================================

-- =============================================================================
-- 1. THE PRE-UPDATE SNAPSHOT
-- =============================================================================

create or replace function auth_appointment_frozen(p_appointment_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select to_jsonb(a) - 'status' - 'updated_at'
  from appointments a
  where a.id = p_appointment_id
    and a.patient_id = auth_patient_id();
$$;

comment on function auth_appointment_frozen(uuid) is
  'Every column of the calling portal user''s own appointment EXCEPT status and '
  'updated_at, as they stood at statement start. Returns NULL for an appointment '
  'that is not theirs, so it cannot be used to read another patient''s row. '
  'STABLE + SECURITY DEFINER so an appointments policy can read appointments '
  'without recursing through RLS and still sees the pre-UPDATE values. Used only '
  'by the "appointments: portal update own" WITH CHECK.';

-- The helper reads an appointment row as the owner, so it must not be callable
-- directly. Same shape as auth_patient_pinned_fields() in 20260903000100:
-- 20260727000002 deliberately excludes FUNCTIONS from the schema's default
-- privileges, so `authenticated` must be granted EXECUTE explicitly or the
-- WITH CHECK below cannot evaluate and every portal cancel fails at runtime
-- with "permission denied for function auth_appointment_frozen" (42501) —
-- while the migration itself still installs cleanly.
revoke all on function auth_appointment_frozen(uuid) from public;
revoke all on function auth_appointment_frozen(uuid) from anon;
grant execute on function auth_appointment_frozen(uuid) to authenticated, service_role;

-- =============================================================================
-- 2. THE POLICY
-- =============================================================================

drop policy if exists "appointments: portal update own" on appointments;

create policy "appointments: portal update own"
  on appointments for update
  to authenticated
  using (
    patient_id = (select auth_patient_id())
    and deleted_at is null
    and status in ('scheduled', 'checked_in')
  )
  with check (
    patient_id = (select auth_patient_id())
    and deleted_at is null
    -- Cancelling is the ONLY transition the portal may perform. The USING
    -- clause above still decides which appointments are eligible; this decides
    -- what may become of them.
    and status = 'cancelled'
    -- …and nothing else about the row may move.
    and (to_jsonb(appointments) - 'status' - 'updated_at')
        = auth_appointment_frozen(id)
  );

comment on policy "appointments: portal update own" on appointments is
  'Portal self-service CANCELLATION only. USING restricts the eligible rows to '
  'the caller''s own non-deleted, scheduled/checked-in appointments; WITH CHECK '
  'requires the new status to be exactly ''cancelled'' and freezes every other '
  'column — including ones added by later migrations — against its pre-update '
  'value. Applies to authenticated sessions only; service_role is exempt from '
  'RLS and is what the staff reschedule and completion paths use.';

-- =============================================================================
-- END OF MIGRATION
-- =============================================================================
