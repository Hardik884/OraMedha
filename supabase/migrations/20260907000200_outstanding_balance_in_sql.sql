-- =============================================================================
-- Compute outstanding balances in SQL instead of in the Node process
-- Migration: 20260907000200_outstanding_balance_in_sql.sql
--
-- WHAT WAS WRONG
--   getPatientsWithOutstandingBalance (actions/payments.ts) fetched EVERY
--   patient, EVERY treatment and EVERY payment in the clinic, with no limit, no
--   date filter and no pagination, and reduced them in JavaScript.
--
--   That is slow, but the reason it is a correctness bug rather than a
--   performance one is PostgREST's row cap. supabase/config.toml sets
--   max_rows = 1000. Past that the response is TRUNCATED SILENTLY — no error,
--   no signal, no partial-content status the client checks. The balances then
--   come out wrong in whichever direction the truncation fell: a clinic whose
--   treatments truncate understates dues, and one whose payments truncate
--   overstates them.
--
--   This is not a display-only concern. actions/messaging.ts feeds the same
--   function into the payment-reminder list, so the failure mode is chasing a
--   patient for money they have already paid.
--
--   A clinic seeing twenty patients a day crosses 1,000 treatments in roughly
--   three months, so this was a "when", not an "if".
--
-- THE FIX
--   One aggregate, evaluated in the database, returning one row per patient who
--   owes something. There is nothing to truncate: the result set is bounded by
--   the number of patients with a non-zero balance, not by the number of
--   treatments and payments behind it.
--
-- THE ARITHMETIC IS lib/billing/balance.ts, EXACTLY
--   It has to be, or the receptionist's list and the patient's profile will
--   disagree about what someone owes — and the one place that must never happen
--   is money. Every term below maps to a named helper there:
--
--     isBillableTreatment  → status in ('completed','in_progress'). A planned
--                            or cancelled treatment contributes nothing.
--     opdChargeFor         → the SNAPSHOTTED opd_fee when opd_charged, clamped
--                            at 0. Deliberately independent of status: the
--                            consultation happened either way.
--     xrayChargeFor        → likewise for xray_cost when xray_taken. Film and
--                            machine time were consumed regardless.
--     computeOutstandingBalance → greatest(0, charges - payments), so an
--                            overpayment shows as settled rather than negative.
--
--   actions/__tests__/outstanding-balance-rpc.spec.ts seeds a fixture that
--   exercises every term above and asserts this function and
--   computeOutstandingBalance() produce the same number. Two implementations of
--   one money rule can drift; that spec is what stops them.
--
-- AUTHORISATION LIVES IN THE FUNCTION
--   CLAUDE.md §13.10: "Put a function's authorisation in the function. If it is
--   only safe because of a policy on another object, that safety survives by
--   luck." SECURITY DEFINER is required here — it aggregates across every
--   patient in the clinic, which the caller's own RLS would filter row by row
--   and make the aggregate wrong rather than merely restricted — so the clinic
--   and role checks are stated here explicitly, and the clinic is taken from
--   auth_clinic_id() rather than from an argument.
-- =============================================================================

create or replace function clinic_outstanding_balances()
returns table (
  patient_id         uuid,
  name               text,
  phone              text,
  payment_plan_until date,
  balance            numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with scope as (
    -- Resolved once, from the session — never from an argument. A caller who
    -- is not clinic staff resolves to NULL and every join below matches
    -- nothing, so the function returns an empty set rather than raising.
    select
      case
        when auth_role() in ('dentist', 'receptionist') then auth_clinic_id()
        else null::uuid
      end as clinic_id
  ),
  charges as (
    select
      t.patient_id,
      sum(
        case when t.status in ('completed', 'in_progress')
             then coalesce(t.cost, 0) else 0 end
        + case when t.opd_charged
             then greatest(0, coalesce(t.opd_fee, 0)) else 0 end
        + case when t.xray_taken
             then greatest(0, coalesce(t.xray_cost, 0)) else 0 end
      ) as charged
    from treatments t, scope s
    where t.clinic_id = s.clinic_id
      and t.deleted_at is null
    group by t.patient_id
  ),
  paid as (
    select p.patient_id, sum(coalesce(p.amount, 0)) as settled
    from payments p, scope s
    where p.clinic_id = s.clinic_id
      and p.deleted_at is null
    group by p.patient_id
  )
  select
    pt.id,
    pt.name,
    pt.phone,
    pt.payment_plan_until,
    greatest(0, coalesce(c.charged, 0) - coalesce(pd.settled, 0)) as balance
  from patients pt
  join scope s on pt.clinic_id = s.clinic_id
  left join charges c  on c.patient_id  = pt.id
  left join paid    pd on pd.patient_id = pt.id
  where pt.deleted_at is null
    and greatest(0, coalesce(c.charged, 0) - coalesce(pd.settled, 0)) > 0
  order by balance desc, pt.name asc;
$$;

comment on function clinic_outstanding_balances() is
  'One row per patient in the CALLER''S clinic with a non-zero outstanding '
  'balance, highest first. Mirrors lib/billing/balance.ts exactly: billable '
  'statuses only for treatment cost, OPD and X-ray charged regardless of '
  'status, clamped at zero. SECURITY DEFINER because it aggregates across the '
  'clinic; the clinic comes from auth_clinic_id() and the role check is inside '
  'the function, never from an argument.';

-- CREATE FUNCTION grants EXECUTE to PUBLIC implicitly, and 20260727000002
-- deliberately keeps functions out of the schema's default privileges, so both
-- halves have to be stated. Same shape as auth_patient_pinned_fields()
-- (20260903000100) and run_metric_history_job() (20260731000100).
revoke all on function clinic_outstanding_balances() from public;
revoke all on function clinic_outstanding_balances() from anon;
grant execute on function clinic_outstanding_balances() to authenticated, service_role;

-- =============================================================================
-- Supporting indexes
-- =============================================================================
-- The aggregate groups by patient_id within a clinic. Both tables already carry
-- (clinic_id) partial indexes for the soft-delete predicate; these add the
-- grouping key so the CTEs can be satisfied without a heap scan per patient.

create index if not exists idx_treatments_clinic_patient_active
  on treatments (clinic_id, patient_id)
  where deleted_at is null;

create index if not exists idx_payments_clinic_patient_active
  on payments (clinic_id, patient_id)
  where deleted_at is null;

-- =============================================================================
-- END OF MIGRATION
-- =============================================================================
