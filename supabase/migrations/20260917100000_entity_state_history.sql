-- =============================================================================
-- Entity state history: what OraMedha knew about an appointment, treatment,
-- follow-up, payment or patient record, and when it knew it.
-- Migration: 20260917100000_entity_state_history.sql
--
-- WHY
--   appointments, treatments, follow_ups, payments and patients hold CURRENT
--   state only. A status, a date or a soft delete is overwritten in place, so any
--   question about a past moment is answered with today's knowledge: a treatment
--   cancelled this morning reads as cancelled in last month's figures, a payment
--   keyed in today with yesterday's date rewrites yesterday's balance, and a
--   follow-up edited today looks as if it was completed today (updated_at).
--
--   appointment_history and treatment_history do not close this. They are written
--   by SOME server actions, not by every path: checkInPatient and advanceQueue
--   change appointments.status without writing appointment_history, and a
--   dentist's RLS session can update these tables directly. An audit trail that
--   misses writes cannot say what the state was.
--
-- WHAT
--   One append-only version table per entity, written by a trigger in the same
--   transaction as the change — so every path is captured, including direct
--   client writes, RPCs, cron jobs and the service role. Each row is the state of
--   the fields the Business Brain reads, AFTER the change.
--
--   recorded_at      when OraMedha recorded the change: the database clock of the
--                    writing transaction. Never supplied by a caller.
--   effective_at     when the business event took effect, where the record says:
--                      recorded      no separate event time is captured, so the
--                                    change is dated when it was recorded
--                      performed_at  a treatment's own performed_at (may be
--                                    backdated: performed Monday, keyed Wednesday)
--                      payment_date  the start of the payment's clinic-local date
--                      unknown       a migration baseline: effective time not known
--   provenance       observed       captured by the trigger as it happened
--                    baseline       the state found when capture began (this
--                                   migration). Exact at recorded_at; NOTHING about
--                                   the entity before that moment is known.
--                    reconstructed  reserved for history rebuilt from other
--                                   sources. Nothing writes it today: the legacy
--                                   audit trails are incomplete (see above) and are
--                                   deliberately NOT imported.
--
-- WHAT IS NOT INVENTED
--   No transition before this migration is manufactured. For a moment earlier
--   than entity_history_capture.captured_since the state of a pre-existing row is
--   UNKNOWN, and the point-in-time readers say so rather than guess.
--
-- IMMUTABILITY
--   No client or service-role write grant. Rows are written only by the
--   SECURITY DEFINER triggers below. UPDATE always raises. DELETE is allowed only
--   for a retention purge, or when the entity row itself has been removed by a
--   non-client caller (a clinic being offboarded, a test cleaning up). A client
--   hard delete of a tracked row therefore FAILS: the dentist RLS policies still
--   permit DELETE on these tables, and without this a hard delete would erase the
--   history of the record along with the record.
-- =============================================================================

-- ── Capture start ───────────────────────────────────────────────────────────

create table if not exists entity_history_capture (
  entity         text        primary key,
  captured_since timestamptz not null,
  baseline_rows  bigint      not null,
  constraint chk_entity_history_capture_entity
    check (entity in ('appointment', 'treatment', 'follow_up', 'payment', 'patient'))
);

comment on table entity_history_capture is
  'When trigger capture of each entity''s state history began. A point-in-time read '
  'for a moment before captured_since cannot be answered from history.';

alter table entity_history_capture enable row level security;

create policy "entity_history_capture: signed-in read"
  on entity_history_capture for select
  to authenticated
  using (true);

revoke all on entity_history_capture from anon, authenticated, service_role;
grant select on entity_history_capture to authenticated, service_role;

-- ── Shared: append-only guard ───────────────────────────────────────────────

create or replace function entity_state_history_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent_exists boolean;
begin
  if tg_op = 'UPDATE' then
    raise exception '% is append-only: rows cannot be modified', tg_table_name
      using errcode = 'restrict_violation';
  end if;

  if coalesce(current_setting('app.purge_context', true), '') = 'retention' then
    return old;
  end if;

  -- Removal together with the record it describes (or its whole clinic), by a
  -- non-client caller only. Which cascade reaches this row first is not fixed,
  -- so either parent being gone qualifies.
  execute format('select exists (select 1 from %I where id = $1) and exists (select 1 from clinics where id = $2)', tg_argv[0])
    into v_parent_exists
    using (to_jsonb(old) ->> tg_argv[1])::uuid, old.clinic_id;
  if not v_parent_exists and coalesce(auth.role(), '') not in ('authenticated', 'anon') then
    return old;
  end if;

  raise exception '% rows may only be deleted by the retention purge', tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

revoke all on function entity_state_history_guard() from public, anon, authenticated;

-- =============================================================================
-- APPOINTMENTS
-- =============================================================================

create table if not exists appointment_status_history (
  id                 uuid               primary key default gen_random_uuid(),
  seq                bigint             generated always as identity,
  clinic_id          uuid               not null references clinics (id) on delete cascade,
  appointment_id     uuid               not null references appointments (id) on delete cascade,
  -- Immutable facts of the row, carried so the history answers without joining
  -- tables whose RLS hides soft-deleted rows.
  patient_id         uuid               not null,
  entity_created_at  timestamptz        not null,
  change             text               not null,
  old_status         appointment_status,
  new_status         appointment_status not null,
  scheduled_at       timestamptz        not null,
  duration_minutes   integer            not null,
  source             appointment_source not null,
  is_deleted         boolean            not null,
  effective_at       timestamptz,
  effective_at_basis text               not null,
  recorded_at        timestamptz        not null default now(),
  changed_by         uuid,
  provenance         text               not null,

  constraint uq_appointment_status_history_seq unique (seq),
  constraint chk_appointment_status_history_change
    check (change in ('created', 'status_changed', 'rescheduled', 'deleted', 'restored', 'updated', 'baseline')),
  constraint chk_appointment_status_history_provenance
    check (provenance in ('observed', 'baseline', 'reconstructed')),
  constraint chk_appointment_status_history_basis
    check (effective_at_basis in ('recorded', 'unknown')),
  constraint chk_appointment_status_history_effective
    check ((effective_at_basis = 'unknown') = (effective_at is null)
       and (effective_at_basis <> 'recorded' or effective_at = recorded_at)),
  constraint chk_appointment_status_history_baseline
    check ((provenance = 'baseline') = (change = 'baseline'))
);

comment on table appointment_status_history is
  'Append-only state versions of appointments (status, schedule, deletion), written by '
  'trigger on every change. recorded_at is when OraMedha knew; effective_at is when it '
  'took effect, with its basis. See migration 20260917100000.';

create index if not exists idx_appointment_status_history_entity
  on appointment_status_history (clinic_id, appointment_id, recorded_at desc, seq desc);
create index if not exists idx_appointment_status_history_scheduled
  on appointment_status_history (clinic_id, scheduled_at);
create index if not exists idx_appointment_status_history_patient
  on appointment_status_history (clinic_id, patient_id, recorded_at);

insert into appointment_status_history (
  clinic_id, appointment_id, patient_id, entity_created_at, change, old_status, new_status,
  scheduled_at, duration_minutes, source, is_deleted, effective_at, effective_at_basis, changed_by, provenance
)
select clinic_id, id, patient_id, created_at, 'baseline', null, status,
       scheduled_at, duration_minutes, source, deleted_at is not null, null, 'unknown', null, 'baseline'
  from appointments;

create or replace function record_appointment_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_change text;
begin
  if tg_op = 'INSERT' then
    v_change := 'created';
  elsif (old.deleted_at is null) <> (new.deleted_at is null) then
    v_change := case when new.deleted_at is null then 'restored' else 'deleted' end;
  elsif old.status is distinct from new.status then
    v_change := 'status_changed';
  elsif old.scheduled_at is distinct from new.scheduled_at then
    v_change := 'rescheduled';
  else
    v_change := 'updated';
  end if;

  insert into appointment_status_history (
    clinic_id, appointment_id, patient_id, entity_created_at, change, old_status, new_status,
    scheduled_at, duration_minutes, source, is_deleted, effective_at, effective_at_basis,
    recorded_at, changed_by, provenance
  ) values (
    new.clinic_id, new.id, new.patient_id, new.created_at, v_change,
    case when tg_op = 'UPDATE' then old.status end, new.status,
    new.scheduled_at, new.duration_minutes, new.source, new.deleted_at is not null,
    now(), 'recorded', now(), auth.uid(), 'observed'
  );
  return null;
end;
$$;

revoke all on function record_appointment_state() from public, anon, authenticated;

drop trigger if exists trg_appointments_state_insert on appointments;
create trigger trg_appointments_state_insert
  after insert on appointments
  for each row execute function record_appointment_state();

drop trigger if exists trg_appointments_state_update on appointments;
create trigger trg_appointments_state_update
  after update on appointments
  for each row
  when (
    old.status is distinct from new.status
    or old.scheduled_at is distinct from new.scheduled_at
    or old.duration_minutes is distinct from new.duration_minutes
    or old.source is distinct from new.source
    or (old.deleted_at is null) <> (new.deleted_at is null)
  )
  execute function record_appointment_state();

drop trigger if exists trg_appointment_status_history_guard on appointment_status_history;
create trigger trg_appointment_status_history_guard
  before update or delete on appointment_status_history
  for each row execute function entity_state_history_guard('appointments', 'appointment_id');

-- =============================================================================
-- TREATMENTS
-- =============================================================================

create table if not exists treatment_status_history (
  id                 uuid             primary key default gen_random_uuid(),
  seq                bigint           generated always as identity,
  clinic_id          uuid             not null references clinics (id) on delete cascade,
  treatment_id       uuid             not null references treatments (id) on delete cascade,
  patient_id         uuid             not null,
  entity_created_at  timestamptz      not null,
  change             text             not null,
  old_status         treatment_status,
  new_status         treatment_status not null,
  cost               numeric(10, 2)   not null,
  performed_at       timestamptz,
  opd_charged        boolean          not null,
  opd_fee            numeric(10, 2)   not null,
  xray_taken         boolean          not null,
  xray_cost          numeric(10, 2),
  is_deleted         boolean          not null,
  effective_at       timestamptz,
  effective_at_basis text             not null,
  recorded_at        timestamptz      not null default now(),
  changed_by         uuid,
  provenance         text             not null,

  constraint uq_treatment_status_history_seq unique (seq),
  constraint chk_treatment_status_history_change
    check (change in ('created', 'status_changed', 'deleted', 'restored', 'updated', 'baseline')),
  constraint chk_treatment_status_history_provenance
    check (provenance in ('observed', 'baseline', 'reconstructed')),
  constraint chk_treatment_status_history_basis
    check (effective_at_basis in ('recorded', 'performed_at', 'unknown')),
  constraint chk_treatment_status_history_effective
    check ((effective_at_basis = 'unknown') = (effective_at is null)
       and (effective_at_basis <> 'recorded' or effective_at = recorded_at)),
  constraint chk_treatment_status_history_baseline
    check ((provenance = 'baseline') = (change = 'baseline'))
);

comment on table treatment_status_history is
  'Append-only state versions of treatments (status, charges, performed_at, deletion), '
  'written by trigger. Clinical notes are never copied. See migration 20260917100000.';

create index if not exists idx_treatment_status_history_entity
  on treatment_status_history (clinic_id, treatment_id, recorded_at desc, seq desc);
create index if not exists idx_treatment_status_history_recorded
  on treatment_status_history (clinic_id, recorded_at);

insert into treatment_status_history (
  clinic_id, treatment_id, patient_id, entity_created_at, change, old_status, new_status, cost,
  performed_at, opd_charged, opd_fee, xray_taken, xray_cost, is_deleted, effective_at,
  effective_at_basis, changed_by, provenance
)
select clinic_id, id, patient_id, created_at, 'baseline', null, status, cost,
       performed_at, opd_charged, opd_fee, xray_taken, xray_cost, deleted_at is not null, null,
       'unknown', null, 'baseline'
  from treatments;

create or replace function record_treatment_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_change text;
  v_performed_effective boolean;
begin
  if tg_op = 'INSERT' then
    v_change := 'created';
  elsif (old.deleted_at is null) <> (new.deleted_at is null) then
    v_change := case when new.deleted_at is null then 'restored' else 'deleted' end;
  elsif old.status is distinct from new.status then
    v_change := 'status_changed';
  else
    v_change := 'updated';
  end if;

  -- Work performed has its own recorded moment; use it when this change is the
  -- one that put the work on record.
  v_performed_effective :=
    v_change in ('created', 'status_changed', 'updated')
    and new.status in ('completed', 'in_progress')
    and new.performed_at is not null
    and (tg_op = 'INSERT' or old.status is distinct from new.status or old.performed_at is distinct from new.performed_at);

  insert into treatment_status_history (
    clinic_id, treatment_id, patient_id, entity_created_at, change, old_status, new_status, cost,
    performed_at, opd_charged, opd_fee, xray_taken, xray_cost, is_deleted, effective_at,
    effective_at_basis, recorded_at, changed_by, provenance
  ) values (
    new.clinic_id, new.id, new.patient_id, new.created_at, v_change,
    case when tg_op = 'UPDATE' then old.status end, new.status, new.cost,
    new.performed_at, new.opd_charged, new.opd_fee, new.xray_taken, new.xray_cost,
    new.deleted_at is not null,
    case when v_performed_effective then new.performed_at else now() end,
    case when v_performed_effective then 'performed_at' else 'recorded' end,
    now(), auth.uid(), 'observed'
  );
  return null;
end;
$$;

revoke all on function record_treatment_state() from public, anon, authenticated;

drop trigger if exists trg_treatments_state_insert on treatments;
create trigger trg_treatments_state_insert
  after insert on treatments
  for each row execute function record_treatment_state();

drop trigger if exists trg_treatments_state_update on treatments;
create trigger trg_treatments_state_update
  after update on treatments
  for each row
  when (
    old.status is distinct from new.status
    or old.cost is distinct from new.cost
    or old.performed_at is distinct from new.performed_at
    or old.opd_charged is distinct from new.opd_charged
    or old.opd_fee is distinct from new.opd_fee
    or old.xray_taken is distinct from new.xray_taken
    or old.xray_cost is distinct from new.xray_cost
    or (old.deleted_at is null) <> (new.deleted_at is null)
  )
  execute function record_treatment_state();

drop trigger if exists trg_treatment_status_history_guard on treatment_status_history;
create trigger trg_treatment_status_history_guard
  before update or delete on treatment_status_history
  for each row execute function entity_state_history_guard('treatments', 'treatment_id');

-- =============================================================================
-- FOLLOW-UPS
-- =============================================================================

create table if not exists follow_up_status_history (
  id                 uuid             primary key default gen_random_uuid(),
  seq                bigint           generated always as identity,
  clinic_id          uuid             not null references clinics (id) on delete cascade,
  follow_up_id       uuid             not null references follow_ups (id) on delete cascade,
  patient_id         uuid             not null,
  entity_created_at  timestamptz      not null,
  change             text             not null,
  old_status         follow_up_status,
  new_status         follow_up_status not null,
  due_date           date             not null,
  is_deleted         boolean          not null,
  effective_at       timestamptz,
  effective_at_basis text             not null,
  recorded_at        timestamptz      not null default now(),
  changed_by         uuid,
  provenance         text             not null,

  constraint uq_follow_up_status_history_seq unique (seq),
  constraint chk_follow_up_status_history_change
    check (change in ('created', 'status_changed', 'rescheduled', 'deleted', 'restored', 'baseline')),
  constraint chk_follow_up_status_history_provenance
    check (provenance in ('observed', 'baseline', 'reconstructed')),
  constraint chk_follow_up_status_history_basis
    check (effective_at_basis in ('recorded', 'unknown')),
  constraint chk_follow_up_status_history_effective
    check ((effective_at_basis = 'unknown') = (effective_at is null)
       and (effective_at_basis <> 'recorded' or effective_at = recorded_at)),
  constraint chk_follow_up_status_history_baseline
    check ((provenance = 'baseline') = (change = 'baseline'))
);

comment on table follow_up_status_history is
  'Append-only state versions of follow-ups (status, due date, deletion), written by '
  'trigger. follow_ups has no completion timestamp, so a completion is dated when it '
  'was recorded. See migration 20260917100000.';

create index if not exists idx_follow_up_status_history_entity
  on follow_up_status_history (clinic_id, follow_up_id, recorded_at desc, seq desc);
create index if not exists idx_follow_up_status_history_due
  on follow_up_status_history (clinic_id, due_date);
create index if not exists idx_follow_up_status_history_patient
  on follow_up_status_history (clinic_id, patient_id, recorded_at);

insert into follow_up_status_history (
  clinic_id, follow_up_id, patient_id, entity_created_at, change, old_status, new_status,
  due_date, is_deleted, effective_at, effective_at_basis, changed_by, provenance
)
select clinic_id, id, patient_id, created_at, 'baseline', null, status,
       due_date, deleted_at is not null, null, 'unknown', null, 'baseline'
  from follow_ups;

create or replace function record_follow_up_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_change text;
begin
  if tg_op = 'INSERT' then
    v_change := 'created';
  elsif (old.deleted_at is null) <> (new.deleted_at is null) then
    v_change := case when new.deleted_at is null then 'restored' else 'deleted' end;
  elsif old.status is distinct from new.status then
    v_change := 'status_changed';
  else
    v_change := 'rescheduled';
  end if;

  insert into follow_up_status_history (
    clinic_id, follow_up_id, patient_id, entity_created_at, change, old_status, new_status,
    due_date, is_deleted, effective_at, effective_at_basis, recorded_at, changed_by, provenance
  ) values (
    new.clinic_id, new.id, new.patient_id, new.created_at, v_change,
    case when tg_op = 'UPDATE' then old.status end, new.status,
    new.due_date, new.deleted_at is not null, now(), 'recorded', now(), auth.uid(), 'observed'
  );
  return null;
end;
$$;

revoke all on function record_follow_up_state() from public, anon, authenticated;

drop trigger if exists trg_follow_ups_state_insert on follow_ups;
create trigger trg_follow_ups_state_insert
  after insert on follow_ups
  for each row execute function record_follow_up_state();

drop trigger if exists trg_follow_ups_state_update on follow_ups;
create trigger trg_follow_ups_state_update
  after update on follow_ups
  for each row
  when (
    old.status is distinct from new.status
    or old.due_date is distinct from new.due_date
    or (old.deleted_at is null) <> (new.deleted_at is null)
  )
  execute function record_follow_up_state();

drop trigger if exists trg_follow_up_status_history_guard on follow_up_status_history;
create trigger trg_follow_up_status_history_guard
  before update or delete on follow_up_status_history
  for each row execute function entity_state_history_guard('follow_ups', 'follow_up_id');

-- =============================================================================
-- PAYMENTS
-- =============================================================================

create table if not exists payment_state_history (
  id                 uuid           primary key default gen_random_uuid(),
  seq                bigint         generated always as identity,
  clinic_id          uuid           not null references clinics (id) on delete cascade,
  payment_id         uuid           not null references payments (id) on delete cascade,
  patient_id         uuid           not null,
  entity_created_at  timestamptz    not null,
  change             text           not null,
  amount             numeric(10, 2) not null,
  payment_date       date           not null,
  is_deleted         boolean        not null,
  effective_at       timestamptz,
  effective_at_basis text           not null,
  recorded_at        timestamptz    not null default now(),
  changed_by         uuid,
  provenance         text           not null,

  constraint uq_payment_state_history_seq unique (seq),
  constraint chk_payment_state_history_change
    check (change in ('created', 'updated', 'deleted', 'restored', 'baseline')),
  constraint chk_payment_state_history_provenance
    check (provenance in ('observed', 'baseline', 'reconstructed')),
  constraint chk_payment_state_history_basis
    check (effective_at_basis in ('recorded', 'payment_date', 'unknown')),
  constraint chk_payment_state_history_effective
    check ((effective_at_basis = 'unknown') = (effective_at is null)
       and (effective_at_basis <> 'recorded' or effective_at = recorded_at)),
  constraint chk_payment_state_history_baseline
    check ((provenance = 'baseline') = (change = 'baseline'))
);

comment on table payment_state_history is
  'Append-only state versions of payments (amount, date, deletion), written by trigger. '
  'A payment keyed in today for yesterday is effective yesterday and KNOWN today. '
  'See migration 20260917100000.';

create index if not exists idx_payment_state_history_entity
  on payment_state_history (clinic_id, payment_id, recorded_at desc, seq desc);
create index if not exists idx_payment_state_history_patient
  on payment_state_history (clinic_id, patient_id, recorded_at);

insert into payment_state_history (
  clinic_id, payment_id, patient_id, entity_created_at, change, amount, payment_date,
  is_deleted, effective_at, effective_at_basis, changed_by, provenance
)
select clinic_id, id, patient_id, created_at, 'baseline', amount, payment_date,
       deleted_at is not null, null, 'unknown', null, 'baseline'
  from payments;

create or replace function record_payment_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_change   text;
  v_timezone text;
begin
  if tg_op = 'INSERT' then
    v_change := 'created';
  elsif (old.deleted_at is null) <> (new.deleted_at is null) then
    v_change := case when new.deleted_at is null then 'restored' else 'deleted' end;
  else
    v_change := 'updated';
  end if;

  select timezone into v_timezone from clinic_settings where clinic_id = new.clinic_id;

  insert into payment_state_history (
    clinic_id, payment_id, patient_id, entity_created_at, change, amount, payment_date,
    is_deleted, effective_at, effective_at_basis, recorded_at, changed_by, provenance
  ) values (
    new.clinic_id, new.id, new.patient_id, new.created_at, v_change, new.amount, new.payment_date,
    new.deleted_at is not null,
    case when v_change in ('created', 'updated')
         then new.payment_date::timestamp at time zone coalesce(v_timezone, 'UTC')
         else now() end,
    case when v_change in ('created', 'updated') then 'payment_date' else 'recorded' end,
    now(), auth.uid(), 'observed'
  );
  return null;
end;
$$;

revoke all on function record_payment_state() from public, anon, authenticated;

drop trigger if exists trg_payments_state_insert on payments;
create trigger trg_payments_state_insert
  after insert on payments
  for each row execute function record_payment_state();

drop trigger if exists trg_payments_state_update on payments;
create trigger trg_payments_state_update
  after update on payments
  for each row
  when (
    old.amount is distinct from new.amount
    or old.payment_date is distinct from new.payment_date
    or (old.deleted_at is null) <> (new.deleted_at is null)
  )
  execute function record_payment_state();

drop trigger if exists trg_payment_state_history_guard on payment_state_history;
create trigger trg_payment_state_history_guard
  before update or delete on payment_state_history
  for each row execute function entity_state_history_guard('payments', 'payment_id');

-- =============================================================================
-- PATIENTS — registration, deletion and payment-plan state only
-- =============================================================================

create table if not exists patient_state_history (
  id                 uuid        primary key default gen_random_uuid(),
  seq                bigint      generated always as identity,
  clinic_id          uuid        not null references clinics (id) on delete cascade,
  patient_id         uuid        not null references patients (id) on delete cascade,
  entity_created_at  timestamptz not null,
  change             text        not null,
  payment_plan_until date,
  is_deleted         boolean     not null,
  effective_at       timestamptz,
  effective_at_basis text        not null,
  recorded_at        timestamptz not null default now(),
  changed_by         uuid,
  provenance         text        not null,

  constraint uq_patient_state_history_seq unique (seq),
  constraint chk_patient_state_history_change
    check (change in ('created', 'updated', 'deleted', 'restored', 'baseline')),
  constraint chk_patient_state_history_provenance
    check (provenance in ('observed', 'baseline', 'reconstructed')),
  constraint chk_patient_state_history_basis
    check (effective_at_basis in ('recorded', 'unknown')),
  constraint chk_patient_state_history_effective
    check ((effective_at_basis = 'unknown') = (effective_at is null)
       and (effective_at_basis <> 'recorded' or effective_at = recorded_at)),
  constraint chk_patient_state_history_baseline
    check ((provenance = 'baseline') = (change = 'baseline'))
);

comment on table patient_state_history is
  'Append-only versions of a patient record''s existence, deletion and payment plan — '
  'no name, contact or clinical field is copied. Written by trigger. '
  'See migration 20260917100000.';

create index if not exists idx_patient_state_history_entity
  on patient_state_history (clinic_id, patient_id, recorded_at desc, seq desc);

insert into patient_state_history (
  clinic_id, patient_id, entity_created_at, change, payment_plan_until, is_deleted,
  effective_at, effective_at_basis, changed_by, provenance
)
select clinic_id, id, created_at, 'baseline', payment_plan_until, deleted_at is not null,
       null, 'unknown', null, 'baseline'
  from patients;

create or replace function record_patient_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_change text;
begin
  if tg_op = 'INSERT' then
    v_change := 'created';
  elsif (old.deleted_at is null) <> (new.deleted_at is null) then
    v_change := case when new.deleted_at is null then 'restored' else 'deleted' end;
  else
    v_change := 'updated';
  end if;

  insert into patient_state_history (
    clinic_id, patient_id, entity_created_at, change, payment_plan_until, is_deleted,
    effective_at, effective_at_basis, recorded_at, changed_by, provenance
  ) values (
    new.clinic_id, new.id, new.created_at, v_change, new.payment_plan_until,
    new.deleted_at is not null, now(), 'recorded', now(), auth.uid(), 'observed'
  );
  return null;
end;
$$;

revoke all on function record_patient_state() from public, anon, authenticated;

drop trigger if exists trg_patients_state_insert on patients;
create trigger trg_patients_state_insert
  after insert on patients
  for each row execute function record_patient_state();

drop trigger if exists trg_patients_state_update on patients;
create trigger trg_patients_state_update
  after update on patients
  for each row
  when (
    old.payment_plan_until is distinct from new.payment_plan_until
    or (old.deleted_at is null) <> (new.deleted_at is null)
  )
  execute function record_patient_state();

drop trigger if exists trg_patient_state_history_guard on patient_state_history;
create trigger trg_patient_state_history_guard
  before update or delete on patient_state_history
  for each row execute function entity_state_history_guard('patients', 'patient_id');

-- ── Capture start, recorded in the same transaction as the baselines ────────

insert into entity_history_capture (entity, captured_since, baseline_rows)
values
  ('appointment', now(), (select count(*) from appointment_status_history where provenance = 'baseline')),
  ('treatment',   now(), (select count(*) from treatment_status_history   where provenance = 'baseline')),
  ('follow_up',   now(), (select count(*) from follow_up_status_history   where provenance = 'baseline')),
  ('payment',     now(), (select count(*) from payment_state_history      where provenance = 'baseline')),
  ('patient',     now(), (select count(*) from patient_state_history      where provenance = 'baseline'))
on conflict (entity) do nothing;

-- =============================================================================
-- ROW LEVEL SECURITY
--
-- Dentist-only reads, scoped by clinic AND role, like every Business Brain
-- surface. No write grant to anyone: a client or server that could insert here
-- could author what the clinic's records used to say.
-- =============================================================================

do $$
declare
  t text;
begin
  foreach t in array array[
    'appointment_status_history', 'treatment_status_history', 'follow_up_status_history',
    'payment_state_history', 'patient_state_history'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || ': dentist read', t);
    execute format(
      'create policy %I on %I for select to authenticated using (clinic_id = (select auth_clinic_id()) and (select auth_role()) = ''dentist''::user_role)',
      t || ': dentist read', t
    );
    execute format('revoke all on %I from anon, authenticated, service_role', t);
    execute format('grant select on %I to authenticated, service_role', t);
  end loop;
end $$;

-- =============================================================================
-- POINT-IN-TIME READERS
--
-- Each returns, per entity, the latest version RECORDED at or before p_known_at —
-- what OraMedha knew at that moment — optionally filtered on that version's own
-- fields. The filter is applied AFTER the latest version is chosen: an
-- appointment that was on 3 September when last known must not match 3 September
-- because an older version said so.
--
-- SECURITY INVOKER: a dentist's session reads under the RLS above; the service
-- role reads as itself. Entities with no version at p_known_at are absent from
-- the result; whether that means "did not exist" or "unknown" is decided by the
-- caller against entity_history_capture.
-- =============================================================================

create or replace function appointment_states_as_of(
  p_clinic_id      uuid,
  p_known_at       timestamptz,
  p_scheduled_from timestamptz          default null,
  p_scheduled_to   timestamptz          default null,
  p_statuses       appointment_status[] default null,
  p_patient_ids    uuid[]               default null
)
returns table (
  appointment_id    uuid,
  patient_id        uuid,
  entity_created_at timestamptz,
  status            appointment_status,
  scheduled_at      timestamptz,
  duration_minutes  integer,
  source            appointment_source,
  is_deleted        boolean,
  recorded_at       timestamptz,
  provenance        text,
  seq               bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select v.appointment_id, v.patient_id, v.entity_created_at, v.new_status, v.scheduled_at,
         v.duration_minutes, v.source, v.is_deleted, v.recorded_at, v.provenance, v.seq
    from (
      select distinct on (h.appointment_id) h.*
        from appointment_status_history h
       where h.clinic_id = p_clinic_id
         and h.recorded_at <= p_known_at
         and h.appointment_id in (
           select c.appointment_id
             from appointment_status_history c
            where c.clinic_id = p_clinic_id
              and c.recorded_at <= p_known_at
              and (p_scheduled_from is null or c.scheduled_at >= p_scheduled_from)
              and (p_scheduled_to is null or c.scheduled_at <= p_scheduled_to)
              and (p_patient_ids is null or c.patient_id = any (p_patient_ids))
         )
       order by h.appointment_id, h.recorded_at desc, h.seq desc
    ) v
   where (p_scheduled_from is null or v.scheduled_at >= p_scheduled_from)
     and (p_scheduled_to is null or v.scheduled_at <= p_scheduled_to)
     and (p_statuses is null or v.new_status = any (p_statuses))
$$;

create or replace function treatment_states_as_of(
  p_clinic_id uuid,
  p_known_at  timestamptz
)
returns table (
  treatment_id      uuid,
  patient_id        uuid,
  entity_created_at timestamptz,
  status            treatment_status,
  cost              numeric,
  performed_at      timestamptz,
  opd_charged       boolean,
  opd_fee           numeric,
  xray_taken        boolean,
  xray_cost         numeric,
  is_deleted        boolean,
  recorded_at       timestamptz,
  provenance        text,
  seq               bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select distinct on (h.treatment_id)
         h.treatment_id, h.patient_id, h.entity_created_at, h.new_status, h.cost, h.performed_at,
         h.opd_charged, h.opd_fee, h.xray_taken, h.xray_cost, h.is_deleted, h.recorded_at,
         h.provenance, h.seq
    from treatment_status_history h
   where h.clinic_id = p_clinic_id
     and h.recorded_at <= p_known_at
   order by h.treatment_id, h.recorded_at desc, h.seq desc
$$;

create or replace function follow_up_states_as_of(
  p_clinic_id uuid,
  p_known_at  timestamptz,
  p_due_to    date               default null,
  p_statuses  follow_up_status[] default null
)
returns table (
  follow_up_id      uuid,
  patient_id        uuid,
  entity_created_at timestamptz,
  status            follow_up_status,
  due_date          date,
  is_deleted        boolean,
  recorded_at       timestamptz,
  provenance        text,
  seq               bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select v.follow_up_id, v.patient_id, v.entity_created_at, v.new_status, v.due_date,
         v.is_deleted, v.recorded_at, v.provenance, v.seq
    from (
      select distinct on (h.follow_up_id) h.*
        from follow_up_status_history h
       where h.clinic_id = p_clinic_id
         and h.recorded_at <= p_known_at
         and h.follow_up_id in (
           select c.follow_up_id
             from follow_up_status_history c
            where c.clinic_id = p_clinic_id
              and c.recorded_at <= p_known_at
              and (p_due_to is null or c.due_date <= p_due_to)
         )
       order by h.follow_up_id, h.recorded_at desc, h.seq desc
    ) v
   where (p_due_to is null or v.due_date <= p_due_to)
     and (p_statuses is null or v.new_status = any (p_statuses))
$$;

create or replace function payment_states_as_of(
  p_clinic_id  uuid,
  p_known_at   timestamptz,
  p_payment_to date default null
)
returns table (
  payment_id        uuid,
  patient_id        uuid,
  entity_created_at timestamptz,
  amount            numeric,
  payment_date      date,
  is_deleted        boolean,
  recorded_at       timestamptz,
  provenance        text,
  seq               bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select v.payment_id, v.patient_id, v.entity_created_at, v.amount, v.payment_date,
         v.is_deleted, v.recorded_at, v.provenance, v.seq
    from (
      select distinct on (h.payment_id) h.*
        from payment_state_history h
       where h.clinic_id = p_clinic_id
         and h.recorded_at <= p_known_at
       order by h.payment_id, h.recorded_at desc, h.seq desc
    ) v
   where (p_payment_to is null or v.payment_date <= p_payment_to)
$$;

create or replace function patient_states_as_of(
  p_clinic_id   uuid,
  p_known_at    timestamptz,
  p_patient_ids uuid[] default null
)
returns table (
  patient_id         uuid,
  entity_created_at  timestamptz,
  payment_plan_until date,
  is_deleted         boolean,
  recorded_at        timestamptz,
  provenance         text,
  seq                bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select distinct on (h.patient_id)
         h.patient_id, h.entity_created_at, h.payment_plan_until, h.is_deleted, h.recorded_at,
         h.provenance, h.seq
    from patient_state_history h
   where h.clinic_id = p_clinic_id
     and h.recorded_at <= p_known_at
     and (p_patient_ids is null or h.patient_id = any (p_patient_ids))
   order by h.patient_id, h.recorded_at desc, h.seq desc
$$;

-- What followed an action for its targets, as OBSERVED transitions recorded in
-- (p_since, p_known_at] and still standing at p_known_at. Patient ids go in and
-- come out; the caller turns them into delays and never passes them on.
--
--   follow_up_completed   first recorded closure of each follow-up. Objectively
--                         observed only when an attended visit (an appointment
--                         moved to completed) for the same patient is also on
--                         record after the action; the result is dated when both
--                         records exist. A closure with no attended visit is the
--                         clinic's own statement that it happened: staff_declared.
--   payment_recorded      a payment row created, still not deleted.
--   appointment_booked    an appointment created, still live and not deleted.
create or replace function action_result_events(
  p_clinic_id   uuid,
  p_target      text,
  p_patient_ids uuid[],
  p_since       timestamptz,
  p_known_at    timestamptz
)
returns table (
  patient_id  uuid,
  recorded_at timestamptz,
  evidence    text,
  seq         bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with follow_up_closures as (
    select distinct on (t.follow_up_id) t.follow_up_id, t.patient_id, t.recorded_at, t.seq
      from follow_up_status_history t
     where p_target = 'follow_up_completed'
       and t.clinic_id = p_clinic_id
       and t.patient_id = any (p_patient_ids)
       and t.provenance = 'observed'
       and t.new_status = 'completed'
       and t.old_status is distinct from 'completed'
       and t.recorded_at >= p_since
       and t.recorded_at <= p_known_at
     order by t.follow_up_id, t.recorded_at asc, t.seq asc
  ),
  standing_closures as (
    select c.*
      from follow_up_closures c
     where exists (
       select 1 from (
         select l.new_status, l.is_deleted
           from follow_up_status_history l
          where l.clinic_id = p_clinic_id and l.follow_up_id = c.follow_up_id and l.recorded_at <= p_known_at
          order by l.recorded_at desc, l.seq desc
          limit 1
       ) latest
       where latest.new_status = 'completed' and not latest.is_deleted
     )
  ),
  attended as (
    select a.patient_id, min(a.recorded_at) as recorded_at
      from appointment_status_history a
     where p_target = 'follow_up_completed'
       and a.clinic_id = p_clinic_id
       and a.patient_id = any (p_patient_ids)
       and a.provenance = 'observed'
       and a.new_status = 'completed'
       and a.old_status is distinct from 'completed'
       and a.recorded_at >= p_since
       and a.recorded_at <= p_known_at
       and exists (
         select 1 from (
           select l.new_status, l.is_deleted
             from appointment_status_history l
            where l.clinic_id = p_clinic_id and l.appointment_id = a.appointment_id and l.recorded_at <= p_known_at
            order by l.recorded_at desc, l.seq desc
            limit 1
         ) latest
         where latest.new_status = 'completed' and not latest.is_deleted
       )
     group by a.patient_id
  )
  select s.patient_id,
         case when v.recorded_at is null then s.recorded_at else greatest(s.recorded_at, v.recorded_at) end,
         case when v.recorded_at is null then 'staff_declared' else 'objectively_observed' end,
         s.seq
    from standing_closures s
    left join attended v on v.patient_id = s.patient_id
  union all
  select p.patient_id, p.recorded_at, 'objectively_observed', p.seq
    from payment_state_history p
   where p_target = 'payment_recorded'
     and p.clinic_id = p_clinic_id
     and p.patient_id = any (p_patient_ids)
     and p.provenance = 'observed'
     and p.change = 'created'
     and p.recorded_at >= p_since
     and p.recorded_at <= p_known_at
     and exists (
       select 1 from (
         select l.is_deleted
           from payment_state_history l
          where l.clinic_id = p_clinic_id and l.payment_id = p.payment_id and l.recorded_at <= p_known_at
          order by l.recorded_at desc, l.seq desc
          limit 1
       ) latest
       where not latest.is_deleted
     )
  union all
  select b.patient_id, b.recorded_at, 'objectively_observed', b.seq
    from appointment_status_history b
   where p_target = 'appointment_booked'
     and b.clinic_id = p_clinic_id
     and b.patient_id = any (p_patient_ids)
     and b.provenance = 'observed'
     and b.change = 'created'
     and b.recorded_at >= p_since
     and b.recorded_at <= p_known_at
     and exists (
       select 1 from (
         select l.new_status, l.is_deleted
           from appointment_status_history l
          where l.clinic_id = p_clinic_id and l.appointment_id = b.appointment_id and l.recorded_at <= p_known_at
          order by l.recorded_at desc, l.seq desc
          limit 1
       ) latest
       where latest.new_status in ('scheduled', 'checked_in', 'in_progress', 'completed') and not latest.is_deleted
     )
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'appointment_states_as_of(uuid, timestamptz, timestamptz, timestamptz, appointment_status[], uuid[])',
    'treatment_states_as_of(uuid, timestamptz)',
    'follow_up_states_as_of(uuid, timestamptz, date, follow_up_status[])',
    'payment_states_as_of(uuid, timestamptz, date)',
    'patient_states_as_of(uuid, timestamptz, uuid[])',
    'action_result_events(uuid, text, uuid[], timestamptz, timestamptz)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
