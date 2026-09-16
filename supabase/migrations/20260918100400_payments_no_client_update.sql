-- =============================================================================
-- Payments are not edited from a signed-in session
-- Migration: 20260918100400_payments_no_client_update.sql
--
-- WHY
--   A payment is a record of money received. No screen edits one: the app
--   inserts payments, and the only change it ever makes is the patient-deletion
--   cascade's soft delete, which runs through the service role. But both staff
--   roles held RLS UPDATE policies, so a request sent straight to PostgREST
--   could change an amount, a date or a patient on a recorded payment — and the
--   receptionist's policy had no WITH CHECK at all, so it could also move a
--   payment to another clinic's patient id.
--
-- WHAT
--   The two UPDATE policies are dropped and UPDATE is revoked from anon and
--   authenticated. Inserts are unchanged. The service role is unaffected.
--   Correcting a payment remains what it was in the app: not supported.
-- =============================================================================

drop policy if exists "payments: dentist update" on payments;
drop policy if exists "payments: receptionist update" on payments;

revoke update on payments from anon, authenticated;
