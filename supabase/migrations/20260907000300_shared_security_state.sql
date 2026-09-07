-- =============================================================================
-- Move the security counters out of process memory
-- Migration: 20260907000300_shared_security_state.sql
--
-- WHAT WAS WRONG
--   Three controls were backed by module-level Maps in the Node process:
--
--     lib/security/rate-limit.ts  BUCKETS            — sign-in lockout
--     lib/security/rate-limit.ts  BUCKETS            — per-address send ceiling
--     actions/ai.ts               PENDING_AI_ACTIONS — AI action confirmation
--
--   rate-limit.ts is candid about the consequence in its own header: "On a
--   serverless platform each instance keeps its own counter, so the effective
--   limit across N warm instances is N times the configured one", and "A
--   restart clears it". It names a shared store as the upgrade. This is that
--   upgrade — the honesty was never the problem, the unmet condition was.
--
--   The consequences differ by control, and the third is not a security
--   weakening at all but a functional break:
--
--     - the 8-attempt lockout becomes 8×N attempts, and a cold start resets it,
--       so on a platform that scales to zero it is close to no lockout at all;
--     - the 3-per-address send ceiling multiplies the same way, which matters
--       because it is the only thing standing between an unauthenticated caller
--       and the clinic's whole mail allowance;
--     - the AI confirmation token must be redeemed in a LATER turn than it was
--       issued. If the confirming request lands on a different instance the
--       token is simply absent, the model re-proposes, and the patient is asked
--       "shall I book it?" forever. It fails closed — nothing is mis-booked —
--       but the assistant cannot complete a booking, intermittently, depending
--       on instance routing.
--
-- THE SHAPE OF THE FIX
--   The POLICY stays in TypeScript, where it is unit-tested without a database
--   (lib/security/__tests__/rate-limit.spec.ts). Only the STORE moves here, and
--   the window arithmetic is passed in as arguments rather than duplicated in
--   SQL, so there is exactly one definition of "8 failures in 15 minutes".
--
--   Each operation is a single statement so it is atomic across instances.
--   That is the whole point: a read-then-write from two Node processes is the
--   race the in-memory version could not lose only because it never shared
--   anything.
--
-- WHY NO ROLE BUT service_role MAY TOUCH THIS
--   The sign-in throttle is consumed by a caller who is, at that moment,
--   ANONYMOUS — they have not authenticated yet. If `anon` could execute these
--   functions, an attacker could call throttle_clear() on their own key and the
--   lockout would be decorative. So EXECUTE is granted to service_role only,
--   and the Server Actions call them through createAdminClient(), which is
--   server-side and never reachable from a browser.
--
--   The tables themselves get RLS with NO policies, which under RLS is a
--   denial, plus explicit revokes. Two independent mechanisms, the same
--   posture the audit tables use.
-- =============================================================================

-- =============================================================================
-- 1. THE THROTTLE STORE
-- =============================================================================

create table if not exists security_throttle (
  -- Namespaced by the caller: "send:activation:<hash>", or a bare subject hash
  -- for sign-in. Never an email address — actions/auth.ts hashes the subject so
  -- this table cannot become a list of who holds an account here.
  key           text        primary key,
  -- Timestamps of the events still relevant to the window. Kept as an array
  -- rather than one row per event so a key is one row and one lock, and so
  -- pruning is part of the same statement that appends.
  events        timestamptz[] not null default '{}',
  locked_until  timestamptz,
  updated_at    timestamptz not null default now()
);

comment on table security_throttle is
  'Shared counters for the sign-in lockout and the per-address email send '
  'ceiling. Replaces the per-process Map in lib/security/rate-limit.ts, which '
  'gave each serverless instance its own allowance. Keys are hashed subjects, '
  'never addresses. No client role may read or write it.';

alter table security_throttle enable row level security;
-- Deliberately NO policies. Under RLS the absence of a policy is a denial.
revoke all on security_throttle from anon, authenticated;

create index if not exists idx_security_throttle_stale
  on security_throttle (updated_at);

-- =============================================================================
-- 2. THE OPERATIONS
-- =============================================================================
-- Each is ONE statement, so two instances racing produce a correct count rather
-- than two independent ones. Windows arrive as arguments; TypeScript owns the
-- numbers.

/** Current state for a key, recording nothing. */
create or replace function throttle_check(
  p_key       text,
  p_window_ms integer
)
returns table (locked boolean, retry_after_seconds integer, failures integer)
language sql
stable
as $$
  select
    coalesce(t.locked_until > now(), false),
    case
      when t.locked_until > now()
        then greatest(1, ceil(extract(epoch from (t.locked_until - now())))::int)
      else 0
    end,
    coalesce(
      (select count(*)
         from unnest(t.events) e
        where e > now() - make_interval(secs => p_window_ms / 1000.0)),
      0
    )::int
  from security_throttle t
  where t.key = p_key;
$$;

/**
 * Records one failure and returns the resulting state.
 *
 * Crossing p_max inside the window starts a lockout.
 *
 * plpgsql with an explicit row lock rather than a chain of CTEs: a
 * data-modifying CTE sees the snapshot taken at statement start, so the
 * "did this failure cross the threshold" test cannot observe the row the same
 * statement just wrote. SELECT … FOR UPDATE makes the read-modify-write
 * sequential across instances, which is the property that was missing when this
 * lived in a per-process Map.
 */
create or replace function throttle_record_failure(
  p_key        text,
  p_max        integer,
  p_window_ms  integer,
  p_lockout_ms integer
)
returns table (locked boolean, retry_after_seconds integer, failures integer)
language plpgsql
as $$
declare
  v_window  interval := make_interval(secs => p_window_ms / 1000.0);
  v_lockout interval := make_interval(secs => p_lockout_ms / 1000.0);
  v_events  timestamptz[];
  v_locked  timestamptz;
begin
  insert into security_throttle (key) values (p_key)
    on conflict (key) do nothing;

  select
      array(select e from unnest(t.events) e where e > now() - v_window),
      t.locked_until
    into v_events, v_locked
    from security_throttle t
   where t.key = p_key
     for update;

  -- An expired lockout also clears the failures behind it, so someone who was
  -- locked out yesterday starts today from zero rather than one failure away.
  if v_locked is not null and v_locked <= now() then
    v_locked := null;
    v_events := '{}';
  end if;

  v_events := v_events || now();

  if array_length(v_events, 1) >= p_max then
    v_locked := now() + v_lockout;
  end if;

  update security_throttle
     set events = v_events, locked_until = v_locked, updated_at = now()
   where key = p_key;

  return query select
    coalesce(v_locked > now(), false),
    case when v_locked > now()
         then greatest(1, ceil(extract(epoch from (v_locked - now())))::int)
         else 0 end,
    coalesce(array_length(v_events, 1), 0);
end;
$$;

/** Clears a key. Called on a SUCCESSFUL sign-in. */
create or replace function throttle_clear(p_key text)
returns void
language sql
as $$
  delete from security_throttle where key = p_key;
$$;

/**
 * Consumes one send for a key, and reports whether it was allowed.
 *
 * A different shape from the failure counter above: every send counts, whether
 * or not it succeeded, because the send IS the cost. Returns exhausted = true
 * WITHOUT recording, so a refused attempt does not extend the window.
 */
create or replace function throttle_consume_send(
  p_key       text,
  p_max       integer,
  p_window_ms integer
)
returns table (exhausted boolean, retry_after_seconds integer)
language plpgsql
as $$
declare
  v_window interval := make_interval(secs => p_window_ms / 1000.0);
  v_events timestamptz[];
  v_oldest timestamptz;
begin
  -- One row, locked for the duration, so two instances cannot both see the
  -- last remaining allowance.
  insert into security_throttle (key) values (p_key)
    on conflict (key) do nothing;

  select array(select e from unnest(t.events) e where e > now() - v_window)
    into v_events
    from security_throttle t
   where t.key = p_key
     for update;

  if coalesce(array_length(v_events, 1), 0) >= p_max then
    v_oldest := v_events[1];
    update security_throttle set events = v_events, updated_at = now() where key = p_key;
    return query select
      true,
      greatest(1, ceil(extract(epoch from (v_oldest + v_window - now())))::int);
    return;
  end if;

  update security_throttle
     set events = v_events || now(), updated_at = now()
   where key = p_key;

  return query select false, 0;
end;
$$;

revoke all on function throttle_check(text, integer) from public, anon, authenticated;
revoke all on function throttle_record_failure(text, integer, integer, integer) from public, anon, authenticated;
revoke all on function throttle_clear(text) from public, anon, authenticated;
revoke all on function throttle_consume_send(text, integer, integer) from public, anon, authenticated;

grant execute on function throttle_check(text, integer) to service_role;
grant execute on function throttle_record_failure(text, integer, integer, integer) to service_role;
grant execute on function throttle_clear(text) to service_role;
grant execute on function throttle_consume_send(text, integer, integer) to service_role;

-- =============================================================================
-- 3. AI ACTION CONFIRMATIONS
-- =============================================================================
-- The Patient AI Assistant must never execute a mutating tool on the same turn
-- it proposes one (CLAUDE.md §13.12). The proposal is stored, and the model has
-- to echo the token back on a LATER turn — which is what proves a real patient
-- confirmation happened in between.
--
-- Held in the database for the same reason as the counters above: on more than
-- one instance the token was frequently absent when redeemed, and the assistant
-- would re-propose forever rather than book.

create table if not exists ai_pending_actions (
  -- One outstanding proposal per user; a new one replaces the last, which is
  -- what the in-memory Map did (a single-entry-per-user store).
  user_id               uuid        primary key references auth.users (id) on delete cascade,
  token                 uuid        not null,
  tool_name             text        not null,
  args                  jsonb       not null,
  -- The turn the proposal was made on. Redemption must arrive on a DIFFERENT
  -- one, which is what stops the model self-confirming in a single turn.
  created_invocation_id text        not null,
  expires_at            timestamptz not null,
  created_at            timestamptz not null default now(),

  constraint chk_ai_pending_tool check (
    tool_name in ('createAppointment', 'rescheduleAppointment', 'cancelAppointment')
  )
);

comment on table ai_pending_actions is
  'Outstanding AI action proposals awaiting a patient''s confirmation. Replaces '
  'the per-process Map in actions/ai.ts, which made confirmation fail whenever '
  'the redeeming request landed on a different instance. No client role may '
  'read or write it: the whole point is that the caller cannot mint its own '
  'confirmation.';

alter table ai_pending_actions enable row level security;
-- No policies, deliberately.
revoke all on ai_pending_actions from anon, authenticated;

create index if not exists idx_ai_pending_actions_expiry
  on ai_pending_actions (expires_at);

-- =============================================================================
-- 4. HOUSEKEEPING
-- =============================================================================
-- Neither table needs a scheduled job. Both are swept opportunistically by the
-- functions that write them, which keeps them small without adding a cron
-- dependency that could silently stop (the two existing pg_cron jobs both
-- no-op when Vault is unconfigured — see 20260731000100).

create or replace function purge_expired_security_state()
returns void
language sql
as $$
  delete from ai_pending_actions where expires_at < now() - interval '1 hour';
  delete from security_throttle
   where updated_at < now() - interval '24 hours'
     and (locked_until is null or locked_until < now());
$$;

revoke all on function purge_expired_security_state() from public, anon, authenticated;
grant execute on function purge_expired_security_state() to service_role;

-- =============================================================================
-- END OF MIGRATION
-- =============================================================================
