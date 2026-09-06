-- =============================================================================
-- profiles — a patient may read their OWN row and nothing else
-- Migration: 20260905090000_profiles_patient_roster_scope.sql
--
-- THE DEFECT
--   `profiles: read own clinic members` (20260619000000) reads:
--
--       using (clinic_id = auth_clinic_id())
--
--   That was written when only staff had a profiles row, and the comment above
--   it says why — "needed for dentist dropdowns". Portal patients later got a
--   profiles row too (activation upserts one carrying the clinic), and the
--   policy has no role predicate, so it started handing the entire staff roster
--   to every activated patient. Verified against a local database by signing in
--   as a portal patient and issuing GET /rest/v1/profiles?select=* — HTTP 200,
--   every row in the clinic:
--
--       id (the staff member's auth.users UUID) | full_name | role
--       clinic_id | is_admin | signature_url | created_at | updated_at
--
--   Two separate disclosures, and the second is the one that is easy to miss:
--
--     1. STAFF. `is_admin` names which account gates /admin — the one account
--        whose compromise is not scoped to a single clinic. Alongside it sits
--        that account's auth user id. Neither is secret in the sense that
--        knowing them breaks anything by itself; both are precisely what you
--        would collect first if you intended to try.
--
--     2. OTHER PATIENTS. Every other activated patient in the clinic is also a
--        profiles row, so any patient could read the names of the clinic's other
--        portal patients. Attending a dental practice is health information. A
--        patient learning who else attends theirs is a disclosure with no
--        product purpose whatsoever.
--
-- THE FIX
--   Split the single policy in two. Postgres ORs multiple permissive SELECT
--   policies, so this is "your own row, plus — if you are staff — your clinic".
--
--   Row-level is the whole of the fix: RLS cannot restrict COLUMNS, and column
--   GRANTs apply per database role (`authenticated`), not per user, so they
--   cannot separate a patient from a dentist. Rather than pursue a column-level
--   scheme that cannot express the distinction, patients lose table access to
--   everything but themselves, and the handful of server actions that
--   legitimately need a dentist's NAME on a patient's own document — their
--   prescription, their bill, their treatment record — read it through the
--   service role and return just that name. Explicit, server-side, one field.
--
-- WHAT DOES NOT CHANGE
--   Staff behaviour is byte-for-byte what it was: same clinic scope, same
--   columns, same dropdowns. Nobody gains anything here. Tenant isolation is
--   unchanged — the staff branch still keys off auth_clinic_id(). Every
--   own-row read (resolveSession, queue, payments, portal-link's staff guard)
--   is served by the first policy.
-- =============================================================================

drop policy if exists "profiles: read own clinic members" on profiles;

-- ── Everyone: their own row ──────────────────────────────────────────────────
-- resolveSession() depends on this, so it must hold for every authenticated
-- caller including patients. It is also the only profiles access a patient has.
create policy "profiles: read own row"
  on profiles for select
  to authenticated
  using (id = (select auth.uid()));

-- ── Staff only: the rest of their clinic ─────────────────────────────────────
-- Verbatim the old predicate with a role test added. auth_role() is STABLE
-- SECURITY DEFINER, so calling it from inside a profiles policy does not
-- recurse into this policy.
create policy "profiles: staff read clinic members"
  on profiles for select
  to authenticated
  using (
    (select auth_role()) in ('dentist', 'receptionist')
    and clinic_id = (select auth_clinic_id())
  );

comment on policy "profiles: read own row" on profiles is
  'Every authenticated user can read their own profile row. For a portal '
  'patient this is their ONLY profiles access — see the staff policy alongside.';

comment on policy "profiles: staff read clinic members" on profiles is
  'Dentists and receptionists read every profile in their own clinic, which is '
  'what the dentist dropdowns need. Replaces the role-blind predicate that also '
  'handed the roster — including is_admin and other patients'' names — to any '
  'activated portal patient.';
