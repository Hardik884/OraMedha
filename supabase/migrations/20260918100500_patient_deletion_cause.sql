-- =============================================================================
-- Why a record was soft-deleted: its patient was deleted
-- Migration: 20260918100500_patient_deletion_cause.sql
--
-- WHY
--   Deleting a patient soft-deletes their appointments, treatments, payments and
--   follow-ups. Every reader filters `deleted_at is null`, so the money the
--   clinic really collected, and the work it really delivered, vanished from
--   past revenue and production the moment a patient record was deleted —
--   rewriting last month's figures today. A payment a receptionist deleted as a
--   mistake and a payment whose patient was later deleted looked identical.
--
-- WHAT
--   1. `deletion_cause` on appointments, treatments, payments and follow_ups.
--      'patient_deleted' is set by the patient-deletion cascade, in the same
--      update that sets `deleted_at`. Null on a deleted row means the cause is
--      not recorded — every row deleted before this migration — and such rows
--      stay excluded exactly as before. Nothing is backfilled.
--
--   2. Two projections for historical revenue and production:
--        patient_deleted_payments(clinic, known_at)
--        patient_deleted_treatments(clinic, known_at)
--      Each returns, for records deleted with their patient, the last version
--      recorded before the deletion and no later than `known_at` — from the
--      state history, so a later edit cannot change what was known then. They
--      carry no patient id, name or clinical field: amounts, dates, statuses and
--      charges only. Forward-looking figures (balances, pipeline, recalls) never
--      read them.
--
--      SECURITY DEFINER because RLS hides soft-deleted rows from every session,
--      and must. The authorisation is in the function: the service role, or the
--      clinic's own dentist.
-- =============================================================================

alter table appointments add column if not exists deletion_cause text;
alter table treatments   add column if not exists deletion_cause text;
alter table payments     add column if not exists deletion_cause text;
alter table follow_ups   add column if not exists deletion_cause text;

do $$
declare
  t text;
begin
  foreach t in array array['appointments', 'treatments', 'payments', 'follow_ups'] loop
    execute format('alter table %I drop constraint if exists chk_%s_deletion_cause', t, t);
    execute format(
      'alter table %I add constraint chk_%s_deletion_cause check ('
      || '(deletion_cause is null or deletion_cause = ''patient_deleted'') '
      || 'and (deletion_cause is null or deleted_at is not null))',
      t, t
    );
    execute format(
      'comment on column %I.deletion_cause is %L',
      t,
      'Why the row was soft-deleted: ''patient_deleted'' when the patient-deletion cascade removed it. '
      || 'Null on a deleted row = cause not recorded. Historical revenue/production still count '
      || 'patient_deleted rows; forward-looking figures do not.'
    );
  end loop;
end
$$;

-- Clients never set the cause: only the service-role cascade does. A column
-- REVOKE would be a no-op under the table-level UPDATE grant, so a trigger.
create or replace function guard_deletion_cause()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') not in ('authenticated', 'anon') then
    return new;
  end if;
  if (tg_op = 'INSERT' and new.deletion_cause is not null)
     or (tg_op = 'UPDATE' and new.deletion_cause is distinct from old.deletion_cause) then
    raise exception '%: deletion_cause is set only by the patient-deletion cascade', tg_table_name
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

revoke all on function guard_deletion_cause() from public, anon, authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['appointments', 'treatments', 'payments', 'follow_ups'] loop
    execute format('drop trigger if exists trg_%s_guard_deletion_cause on %I', t, t);
    execute format(
      'create trigger trg_%s_guard_deletion_cause before insert or update of deletion_cause on %I '
      || 'for each row execute function guard_deletion_cause()',
      t, t
    );
  end loop;
end
$$;

create or replace function patient_deleted_payments(
  p_clinic_id uuid,
  p_known_at  timestamptz default null
)
returns table (payment_id uuid, amount numeric, payment_date date)
language sql
stable
security definer
set search_path = public
as $$
  select v.payment_id, v.amount, v.payment_date
    from (
      select distinct on (h.payment_id) h.payment_id, h.amount, h.payment_date
        from payment_state_history h
        join payments p on p.id = h.payment_id
       where h.clinic_id = p_clinic_id
         and p.clinic_id = p_clinic_id
         and p.deletion_cause = 'patient_deleted'
         and not h.is_deleted
         and h.recorded_at <= coalesce(p_known_at, now())
       order by h.payment_id, h.recorded_at desc, h.seq desc
    ) v
   where coalesce(auth.role(), '') = 'service_role'
      or (auth_role() = 'dentist' and auth_clinic_id() = p_clinic_id)
$$;

create or replace function patient_deleted_treatments(
  p_clinic_id uuid,
  p_known_at  timestamptz default null
)
returns table (
  treatment_id uuid,
  status       treatment_status,
  cost         numeric,
  performed_at timestamptz,
  opd_charged  boolean,
  opd_fee      numeric,
  xray_taken   boolean,
  xray_cost    numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select v.treatment_id, v.new_status, v.cost, v.performed_at, v.opd_charged, v.opd_fee, v.xray_taken, v.xray_cost
    from (
      select distinct on (h.treatment_id)
             h.treatment_id, h.new_status, h.cost, h.performed_at, h.opd_charged, h.opd_fee, h.xray_taken, h.xray_cost
        from treatment_status_history h
        join treatments t on t.id = h.treatment_id
       where h.clinic_id = p_clinic_id
         and t.clinic_id = p_clinic_id
         and t.deletion_cause = 'patient_deleted'
         and not h.is_deleted
         and h.recorded_at <= coalesce(p_known_at, now())
       order by h.treatment_id, h.recorded_at desc, h.seq desc
    ) v
   where coalesce(auth.role(), '') = 'service_role'
      or (auth_role() = 'dentist' and auth_clinic_id() = p_clinic_id)
$$;

revoke all on function patient_deleted_payments(uuid, timestamptz) from public, anon;
revoke all on function patient_deleted_treatments(uuid, timestamptz) from public, anon;
grant execute on function patient_deleted_payments(uuid, timestamptz) to authenticated, service_role;
grant execute on function patient_deleted_treatments(uuid, timestamptz) to authenticated, service_role;
