-- =============================================================================
-- Stop non-dentist audiences reading clinical free-text columns
-- Migration: 20260907000100_restrict_clinical_columns.sql
--
-- WHAT WAS WRONG
--   CLAUDE.md §5.4 says `treatments.internal_notes` is "visible only to
--   dentist. Never returned by patient-facing APIs or portal queries." §3 gives
--   receptionists "no access to clinical treatment details". The portal's own
--   column list (lib/appointments/patient-safe-columns.ts) names
--   notes / chief_complaints / medical_history / oral_findings /
--   provisional_diagnosis as columns a patient must never receive.
--
--   All of that was enforced only by VIEWS that omit the columns
--   (patient_treatments, receptionist_treatments) and by hand-written select
--   lists in the Server Actions. Both audiences also hold a SELECT policy on
--   the BASE TABLE, and 20260727000002 grants SELECT on all tables to
--   `authenticated` table-wide. RLS cannot restrict columns — CLAUDE.md §13.10
--   says so itself — so the view was a convention, not a control.
--
--   The migration that created the receptionist view was candid about it:
--     "internal_notes is excluded at the view layer, not by column-level RLS …
--      Receptionists must ALWAYS query this view, never the base table."
--
--   Nothing made them. Reproduced against a real database, as an ordinary
--   session holding only the public anon key and the caller's own JWT:
--
--     -- portal patient
--     select internal_notes from treatments where id = <their own treatment>;
--       → 'DENTIST ONLY INTERNAL NOTE'
--     select oral_findings, provisional_diagnosis from appointments
--      where id = <their own appointment>;
--       → 'CLINICIAN ORAL FINDINGS', 'CLINICIAN PROVISIONAL DIAGNOSIS'
--
--     -- receptionist
--     select internal_notes from treatments where id = <any in their clinic>;
--       → 'DENTIST ONLY INTERNAL NOTE'
--
-- THE FIX, AND WHY IT IS A GRANT AND NOT A POLICY
--   Postgres has no per-user column security: RLS is row-level, and column
--   GRANTs are per database ROLE. Every signed-in user of this product —
--   dentist, receptionist and patient alike — arrives as the same role,
--   `authenticated`. So no cleverer policy can express "this column, but only
--   for a dentist".
--
--   What a column GRANT *can* express is "not through the Data API at all". The
--   protected columns are therefore withheld from `anon` and `authenticated`,
--   which removes them from every query shape at once — base table, view,
--   embedded resource, and any policy someone adds later — and the audiences
--   that legitimately need them read them back through a SECURITY DEFINER
--   projection that performs its own authorisation. That is the pattern
--   CLAUDE.md §13.10 prescribes for exactly this situation, and the one
--   lib/staff/dentist-directory.ts already uses for a dentist's name.
--
--   `service_role` is untouched. It is what the retention purge, the patient
--   data export and the audit trails run as.
--
-- THE CONSEQUENCE YOU WILL MEET FIRST
--   A table-level GRANT SUBSUMES column grants, so `revoke select (col)` alone
--   does nothing while the table-level grant is held — it has to be revoked and
--   re-granted per column. Once it is, `SELECT *` FAILS for every role,
--   including the dentist:
--
--     select * from treatments;  →  ERROR: permission denied for table treatments
--
--   That is why this migration ships alongside edits removing `select("*")`
--   from actions/appointments.ts, actions/treatments.ts and
--   actions/dental-chart.ts. It is also, deliberately, a fail-CLOSED design: a
--   column added by a later migration is not granted until someone says so, so
--   the next clinical field cannot leak the way these did. The DO blocks below
--   derive the grant from the catalog and name only what is withheld.
--
-- WHY THE PROJECTIONS ARE SECURITY DEFINER
--   A `security_invoker` view evaluates as the caller and would inherit the
--   caller's (now absent) column privilege, returning nothing. These must run
--   as owner to read the column at all.
--
--   That does NOT reopen what 20260902155414 closed. The five views in that
--   incident were definer views with NO predicate of their own, which is why an
--   unauthenticated caller could read every row. Each view below carries its
--   authorisation in its own WHERE clause — clinic AND role — so it is a
--   projection over rows the caller already holds, not a bypass.
--   actions/__tests__/view-security-invoker.spec.ts asserts behaviour rather
--   than the catalog flag, which is what makes that distinction testable.
-- =============================================================================

-- =============================================================================
-- 1. TREATMENTS — internal_notes is the dentist's own record
-- =============================================================================

do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'treatments'
    and column_name <> 'internal_notes';

  execute 'revoke select on treatments from anon, authenticated';
  execute format('grant select (%s) on treatments to anon, authenticated', cols);
end $$;

comment on column treatments.internal_notes is
  'Dentist-only clinical notes. SELECT is withheld from anon and authenticated: '
  'read it through the treatment_clinical_notes view, which checks the caller is '
  'the clinic''s dentist. Writes are unaffected — INSERT/UPDATE privileges are '
  'separate from SELECT — but any statement whose RETURNING clause names this '
  'column (including SELECT *) is refused, so the Server Actions project '
  'explicitly.';

create or replace view treatment_clinical_notes as
  select
    t.id,
    t.clinic_id,
    t.patient_id,
    t.internal_notes
  from treatments t
  where t.deleted_at is null
    and t.clinic_id = auth_clinic_id()
    and auth_role() = 'dentist';

comment on view treatment_clinical_notes is
  'Dentist-only projection of treatments.internal_notes. SECURITY DEFINER by '
  'necessity — the column is withheld from `authenticated`, so an invoker view '
  'could not read it. Carries its own authorisation: the caller must be a '
  'dentist AND the row must be in their clinic, so it is a projection over rows '
  'they already hold, not an RLS bypass.';

revoke all on treatment_clinical_notes from anon;
grant select on treatment_clinical_notes to authenticated, service_role;

-- =============================================================================
-- 2. APPOINTMENTS — the clinician's assessment of the visit
-- =============================================================================
--
-- These five are the set lib/appointments/patient-safe-columns.ts already
-- declares clinical, minus `created_by`, which is a staff id rather than
-- clinical content and stays readable so the existing attribution and analytics
-- queries are untouched.

do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'appointments'
    and column_name not in (
      'notes', 'chief_complaints', 'medical_history',
      'oral_findings', 'provisional_diagnosis'
    );

  execute 'revoke select on appointments from anon, authenticated';
  execute format('grant select (%s) on appointments to anon, authenticated', cols);
end $$;

create or replace view appointment_clinical_notes as
  select
    a.id,
    a.clinic_id,
    a.patient_id,
    a.notes,
    a.chief_complaints,
    a.medical_history,
    a.oral_findings,
    a.provisional_diagnosis
  from appointments a
  where a.deleted_at is null
    and a.clinic_id = auth_clinic_id()
    and auth_role() in ('dentist', 'receptionist');

comment on view appointment_clinical_notes is
  'Staff-only projection of the clinical free-text on an appointment. BOTH staff '
  'roles are included because the receptionist screens legitimately show '
  'chief_complaints when booking and checking in; the audience that must never '
  'see any of it is the PATIENT. SECURITY DEFINER by necessity (the columns are '
  'withheld from `authenticated`) and scoped by clinic and role in its own WHERE '
  'clause.';

revoke all on appointment_clinical_notes from anon;
grant select on appointment_clinical_notes to authenticated, service_role;

-- =============================================================================
-- 3. THE PROJECTIONS MUST NOT BE WRITABLE
-- =============================================================================
-- A simple view over a single table is auto-updatable in Postgres. Left alone
-- these would become a way to write the very columns this migration protects,
-- without passing the base table's UPDATE policies. Only SELECT is granted
-- above; the rules make that independent of the grant.

create rule treatment_clinical_notes_no_insert as
  on insert to treatment_clinical_notes do instead nothing;
create rule treatment_clinical_notes_no_update as
  on update to treatment_clinical_notes do instead nothing;
create rule treatment_clinical_notes_no_delete as
  on delete to treatment_clinical_notes do instead nothing;

create rule appointment_clinical_notes_no_insert as
  on insert to appointment_clinical_notes do instead nothing;
create rule appointment_clinical_notes_no_update as
  on update to appointment_clinical_notes do instead nothing;
create rule appointment_clinical_notes_no_delete as
  on delete to appointment_clinical_notes do instead nothing;

-- =============================================================================
-- 4. FUTURE COLUMNS
-- =============================================================================
-- `alter default privileges` cannot express column grants, so a column added to
-- either table by a later migration starts UNREADABLE through the Data API and
-- must be granted explicitly:
--
--   grant select (new_column) on appointments to anon, authenticated;
--
-- That is the intended default. The alternative — a new column being readable
-- by every patient until someone notices — is what this migration exists to fix.
-- =============================================================================

-- =============================================================================
-- 5. THE active_* VIEWS MUST STOP PROJECTING THE PROTECTED COLUMNS
-- =============================================================================
-- active_treatments and active_appointments (20260619000001, made
-- security_invoker in 20260902155414) select the clinical columns. An invoker
-- view evaluates column privileges as the CALLER, so after the grants above
-- every read of them fails with "permission denied for table treatments" —
-- for the dentist too, not only the audiences this migration restricts.
--
-- They are redefined without those columns. No application code selects from
-- either view (20260902155414 established that and it is still true), so this
-- changes no product behaviour; it keeps the soft-delete convenience views
-- usable and stops them being a second route to clinical text.
--
-- security_invoker is re-asserted on both. It is the property that made them
-- safe after 20260902155414 and it must survive a CREATE OR REPLACE.

-- CREATE OR REPLACE cannot remove a column from a view, so these are dropped
-- and recreated. Nothing depends on them (no application code, no other view),
-- which is why a plain DROP is safe here rather than CASCADE.
drop view if exists active_treatments;
create view active_treatments
with (security_invoker = true) as
  select
    id, clinic_id, appointment_id, patient_id, treatment_type,
    patient_visible_notes, cost, status, performed_at,
    deleted_at, created_at, updated_at
  from treatments
  where deleted_at is null;

comment on view active_treatments is
  'Soft-delete convenience view over treatments. internal_notes is deliberately '
  'absent: it is withheld from anon and authenticated at the column level, so '
  'projecting it here would make every read of this view fail. Dentists read it '
  'through treatment_clinical_notes.';

drop view if exists active_appointments;
create view active_appointments
with (security_invoker = true) as
  select
    id, clinic_id, patient_id, dentist_id, scheduled_at, duration_minutes,
    source, status, deleted_at, created_at, updated_at
  from appointments
  where deleted_at is null;

comment on view active_appointments is
  'Soft-delete convenience view over appointments. The clinical free-text '
  'columns are deliberately absent for the same reason as active_treatments; '
  'staff read them through appointment_clinical_notes.';

-- The soft-delete views are recreated above, so their grants are reasserted
-- here — a dropped view takes its privileges with it, and 20260727000002's
-- `alter default privileges` covers only objects created by `postgres` going
-- forward, which is not a guarantee worth relying on for a security boundary.
grant select on active_treatments  to anon, authenticated, service_role;
grant select on active_appointments to anon, authenticated, service_role;
