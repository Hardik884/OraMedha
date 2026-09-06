-- =============================================================================
-- bulk_decrement_queue_positions — carry its own clinic predicate
-- Migration: 20260905090100_scope_bulk_decrement_queue_positions.sql
--
-- WHAT IT WAS
--   20260622000000 defined it as:
--
--       update queue_entries set position = position - 1 where id = any(p_ids)
--
--   SECURITY INVOKER, granted to `authenticated`, and taking a caller-supplied
--   array of UUIDs with no predicate of its own. Nothing in the function says
--   which clinic it may touch.
--
--   That is not currently exploitable across tenants. Because it is INVOKER,
--   `queue_entries: staff update` still applies, and that policy is scoped to
--   auth_clinic_id() — so a caller passing another clinic's queue ids updates
--   zero rows. The isolation is real; it just lives entirely somewhere else.
--
-- WHY CHANGE ANYTHING THEN
--   Because the function reads as if it may update any row in the table, and
--   the only reason it may not is a policy on a different object written for a
--   different purpose. The next person to touch either one has to hold both in
--   their head to see that it is safe. Authorisation you cannot see at the call
--   site is authorisation that survives by luck.
--
--   It also fails closed now. auth_clinic_id() returns NULL for service_role
--   and anon, and `clinic_id = NULL` matches nothing — so an accidental
--   service-role invocation, which RLS would NOT have constrained, updates
--   nothing instead of everything named in the array.
--
-- STILL SECURITY INVOKER, DELIBERATELY
--   The task this performs is one the caller is already entitled to perform.
--   Making it DEFINER would move it out from under the RLS policy that is doing
--   the real work and turn an internal helper into a privilege boundary, which
--   is more surface, not less.
--
-- `position > 1`
--   Every legitimate call passes rows whose position is strictly greater than
--   the skipped entry's, so position >= 2 always. The guard therefore never
--   fires in normal operation; it exists so that a same-clinic caller invoking
--   the RPC directly cannot drive positions to zero or negative and corrupt the
--   ordering of a live waiting room.
--
-- Sole caller: skipPatient() in actions/queue.ts, using the RLS-bound session
-- client. Behaviour there is unchanged.
-- =============================================================================

create or replace function bulk_decrement_queue_positions(p_ids uuid[])
returns void
language sql
security invoker
set search_path = public
as $$
  update queue_entries
  set    position = position - 1
  where  id = any(p_ids)
    and  clinic_id = (select auth_clinic_id())
    and  position > 1;
$$;

comment on function bulk_decrement_queue_positions is
  'Decrements position by 1 for the given queue_entry rows in a single UPDATE. '
  'Used by skipPatient() to avoid an N+1 serial loop when reordering the queue. '
  'Scoped to the caller''s own clinic in the function body as well as by RLS, '
  'and refuses to move a row below position 1. Returns without effect for any '
  'caller with no clinic (service_role, anon), which RLS alone would not stop.';
