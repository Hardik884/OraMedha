-- =============================================================================
-- No hard DELETE from a signed-in session: clinical records and queue entries
-- Migration: 20260918100300_no_client_hard_delete.sql
--
-- WHY
--   Soft delete is the rule (CLAUDE.md 5.11), and every app path follows it —
--   but the dentist still held RLS DELETE policies on patients, appointments,
--   treatments, payments and follow_ups, and both staff roles held DELETE on
--   queue_entries through their "full access" policies. A request sent straight
--   to PostgREST could erase a record, or erase a check-in, that the app never
--   would. The state-history foreign keys make most of those deletes fail today;
--   that is an accident of a later migration, not a rule anyone wrote down.
--
-- WHAT
--   - The five dentist DELETE policies are dropped.
--   - queue_entries' two "full access" (ALL) policies are dropped. Read, insert
--     and update are already granted by their own policies, which stay; only
--     DELETE goes. Taking a patient off the live queue is `removed_at`
--     (20260918100100).
--   - DELETE is revoked from anon and authenticated on all six tables, so a
--     policy added later cannot quietly reopen it.
--
--   The service role, and the security-definer retention purge that removes old
--   COMPLETED queue entries, are unaffected.
-- =============================================================================

drop policy if exists "patients: dentist delete" on patients;
drop policy if exists "appointments: dentist delete" on appointments;
drop policy if exists "treatments: dentist delete" on treatments;
drop policy if exists "payments: dentist delete" on payments;
drop policy if exists "follow_ups: dentist delete" on follow_ups;

drop policy if exists "queue_entries: dentist full access" on queue_entries;
drop policy if exists "queue_entries: receptionist full access" on queue_entries;

revoke delete on patients, appointments, treatments, payments, follow_ups, queue_entries
  from anon, authenticated;
