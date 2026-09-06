-- =============================================================================
-- reminder_logs — staff may add to the record, not edit or erase it
-- Migration: 20260905090200_reminder_logs_no_client_delete.sql
--
-- WHAT IT WAS
--   Both staff policies (20260808000000) were `for all`, which is SELECT +
--   INSERT + UPDATE + DELETE. The table's own comment calls it "append-only",
--   and its header says "Nothing updates or deletes them in normal operation" —
--   so the grant and the intent had drifted apart. A receptionist could delete
--   the record that a patient had already been messaged.
--
--   That matters slightly more than a stray permission usually does, because of
--   what these rows DO: the reminder lists suppress a patient for a cooldown
--   window after a message is logged. Deleting the row un-suppresses them. The
--   effect of the permission is "message this patient about their overdue
--   payment again, now", and the audit of having done so goes with it.
--
-- IS DELETE ACTUALLY USED?
--   Once, and not from here. softDeletePatient() (actions/patients.ts) clears a
--   deleted patient's reminder_logs as part of the cascade. That path is
--   dentist-only AND runs on the service role, which is exempt from RLS, so it
--   is unaffected by anything in this file. No workflow anywhere calls a delete
--   through a client policy.
--
--   UPDATE is used by nothing at all. The rows carry a fact and a timestamp;
--   there is no editable field on them.
--
-- WHAT THIS DOES
--   Replaces `for all` with explicit SELECT and INSERT policies per role. Same
--   clinic scope, same WITH CHECK pinning clinic_id, same two roles. Staff keep
--   every operation the reminder workflow performs — reading the log to
--   suppress duplicates, and writing a row when a message is sent.
--
--   No trigger is added. This is a client-permission correction, not a claim
--   that the table is now tamper-proof against the service role; reminder_logs
--   is operational bookkeeping with a 365-day retention policy, not a clinical
--   or consent record. The tables that DO need that guarantee
--   (phi_access_log, data_consent_records, treatment_history) already have it,
--   and nothing here touches them.
-- =============================================================================

drop policy if exists "reminder_logs: dentist full access"      on reminder_logs;
drop policy if exists "reminder_logs: receptionist full access" on reminder_logs;

create policy "reminder_logs: staff read"
  on reminder_logs for select
  to authenticated
  using (
    clinic_id = (select auth_clinic_id())
    and (select auth_role()) in ('dentist', 'receptionist')
  );

create policy "reminder_logs: staff insert"
  on reminder_logs for insert
  to authenticated
  with check (
    clinic_id = (select auth_clinic_id())
    and (select auth_role()) in ('dentist', 'receptionist')
  );

comment on policy "reminder_logs: staff read" on reminder_logs is
  'Dentists and receptionists read their own clinic''s reminder history, which '
  'is what suppresses duplicate messages across page refreshes.';

comment on policy "reminder_logs: staff insert" on reminder_logs is
  'Dentists and receptionists record that a reminder was sent. There is '
  'deliberately no UPDATE or DELETE policy: under RLS the absence of a policy '
  'is a denial, and this table is append-only by design. The patient-deletion '
  'cascade clears rows through the service role, which RLS does not constrain.';
