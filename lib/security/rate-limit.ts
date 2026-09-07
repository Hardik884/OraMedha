/**
 * lib/security/rate-limit.ts
 *
 * Throttling repeated authentication attempts.
 *
 * WHAT THIS IS, HONESTLY
 *   An in-process, in-memory counter. It is a real and useful control against
 *   the common case — a script hammering one account or one browser retrying
 *   endlessly — and it is NOT a distributed rate limiter. Two facts follow, and
 *   both are stated here rather than discovered later:
 *
 *     1. On a serverless platform each instance keeps its own counter, so the
 *        effective limit across N warm instances is N times the configured one.
 *     2. A restart clears it.
 *
 *   Supabase Auth applies its own IP-based limits underneath this
 *   (auth.rate_limit in config.toml), which is the layer that is actually
 *   distributed. This adds the thing that layer cannot do: a PER-ACCOUNT
 *   lockout, so an attacker spreading attempts across many IPs against one
 *   dentist's account still runs into a wall.
 *
 *   → THE SHARED STORE NOW EXISTS. 20260907000300 puts these counters in a
 *     Postgres table, and the application calls the *Shared functions at the
 *     bottom of this file. The in-memory implementation below is no longer the
 *     control — it is the FALLBACK the shared path uses when the database is
 *     unreachable, so a query timeout degrades the limiter instead of removing
 *     it. It is also what the unit tests exercise, because the policy is the
 *     part worth testing without a database.
 *
 * WHY A LOCKOUT AND NOT A BLANKET DELAY
 *   A delay costs the attacker nothing they cannot parallelise. A lockout on a
 *   sliding window costs them the account for its duration. The window is short
 *   enough that a real person who mistyped their password three times is
 *   inconvenienced for minutes, not locked out of their clinic for a day —
 *   which matters, because a receptionist locked out at 9am is a clinical
 *   availability problem, not just an annoyance.
 */

/** Failures allowed inside the window before the identifier is locked. */
export const MAX_ATTEMPTS = 8;

/** Sliding window over which failures are counted. */
export const WINDOW_MS = 15 * 60 * 1000;

/** How long a locked identifier stays locked. */
export const LOCKOUT_MS = 15 * 60 * 1000;

type Bucket = {
  /** Timestamps of failures still inside the window. */
  failures: number[];
  /** When the lockout ends, or null. */
  lockedUntil: number | null;
};

const BUCKETS = new Map<string, Bucket>();

/**
 * Bound on distinct identifiers held at once.
 *
 * Without it, an attacker enumerating addresses would grow the map without
 * limit — turning a defence into a memory-exhaustion vector. When the bound is
 * hit the oldest entries are dropped, which at worst forgives some failures
 * against accounts nobody has touched recently.
 */
const MAX_TRACKED = 10_000;

function prune(bucket: Bucket, now: number): void {
  bucket.failures = bucket.failures.filter((t) => now - t < WINDOW_MS);
  if (bucket.lockedUntil !== null && bucket.lockedUntil <= now) {
    bucket.lockedUntil = null;
    bucket.failures = [];
  }
}

function bucketFor(key: string): Bucket {
  let bucket = BUCKETS.get(key);
  if (!bucket) {
    if (BUCKETS.size >= MAX_TRACKED) {
      // Map preserves insertion order, so the first key is the least recently
      // created. Drop a slice rather than one, so this does not run every call.
      for (const stale of [...BUCKETS.keys()].slice(0, MAX_TRACKED / 10)) {
        BUCKETS.delete(stale);
      }
    }
    bucket = { failures: [], lockedUntil: null };
    BUCKETS.set(key, bucket);
  }
  return bucket;
}

export type RateLimitState = {
  /** True when the identifier is currently locked out. */
  locked: boolean;
  /** Seconds until the lockout lifts. 0 when not locked. */
  retryAfterSeconds: number;
  /** Failures counted inside the current window. */
  failures: number;
};

/** Current state for an identifier, without recording anything. */
export function checkRateLimit(key: string, now = Date.now()): RateLimitState {
  const bucket = BUCKETS.get(key);
  if (!bucket) return { locked: false, retryAfterSeconds: 0, failures: 0 };

  prune(bucket, now);

  const locked = bucket.lockedUntil !== null && bucket.lockedUntil > now;
  return {
    locked,
    retryAfterSeconds: locked
      ? Math.ceil((bucket.lockedUntil! - now) / 1000)
      : 0,
    failures: bucket.failures.length,
  };
}

/**
 * Records a failure and returns the resulting state.
 * Crossing MAX_ATTEMPTS inside the window starts a lockout.
 */
export function recordFailure(key: string, now = Date.now()): RateLimitState {
  const bucket = bucketFor(key);
  prune(bucket, now);

  bucket.failures.push(now);

  if (bucket.failures.length >= MAX_ATTEMPTS) {
    bucket.lockedUntil = now + LOCKOUT_MS;
  }

  return checkRateLimit(key, now);
}

/**
 * Clears the counter for an identifier.
 *
 * Called on a SUCCESSFUL sign-in. Without it, someone who mistypes their
 * password six times, succeeds on the seventh, and mistypes twice more the
 * following week would be locked out on a stale count.
 */
export function clearFailures(key: string): void {
  BUCKETS.delete(key);
}

/** Test seam. Never called by application code. */
export function resetAllRateLimits(): void {
  BUCKETS.clear();
}

// =============================================================================
// SEND QUOTA — a different question, on the same machinery
// =============================================================================
//
// Everything above counts FAILURES and locks an account after too many. That
// is the right shape for a password guess, where a success is the thing being
// defended against and a failure is the signal.
//
// Sending an email is the opposite shape. Every send counts, succeeded or not,
// because the send IS the cost: an unauthenticated caller who can make the
// server email an address they name can use OraMedha to deliver mail to
// somebody else's inbox, and can burn the clinic's Resend quota doing it. There
// is no "failure" to count — a request that works is exactly the problem.
//
// So this is a plain N-per-window ceiling rather than a lockout, sharing the
// bucket, the pruning and the memory bound above rather than growing a second
// copy of them. Keys are namespaced by the caller (see SEND_* below) so a
// password-reset request and an activation request do not consume each other's
// allowance, and neither touches the sign-in counter.
//
// Shares the shared store too: consumeSendQuotaShared() at the bottom of this
// file is what the application calls, and the in-memory version below is its
// fallback. Supabase Auth's own per-hour mailer limit sits underneath and is
// the distributed one. This adds what that cannot — a PER-ADDRESS ceiling, so
// one address cannot absorb the whole clinic's hourly allowance before anyone
// else can reset a password.

/** Sends allowed for one address inside SEND_WINDOW_MS. */
export const MAX_SENDS = 3;

/**
 * Window for the send ceiling.
 *
 * Longer than the sign-in window on purpose. A person who did not receive a
 * code retries within a minute or two; three attempts inside ten minutes covers
 * a genuinely unlucky user and still bounds a script to 18 messages an hour per
 * address instead of as many as it can issue requests.
 */
export const SEND_WINDOW_MS = 10 * 60 * 1000;

/** Namespaces, so one flow's ceiling is not another's. */
export const SEND_ACTIVATION = "send:activation";
export const SEND_PASSWORD_RESET = "send:reset";

export type SendQuotaState = {
  /** True when this address has no allowance left in the window. */
  exhausted: boolean;
  /** Seconds until the oldest send falls out of the window. 0 when allowed. */
  retryAfterSeconds: number;
};

/**
 * Consume one send for `namespace` + `subject`, and report whether it was
 * allowed.
 *
 * Records BEFORE the send rather than after, and records even when the send
 * ends up not happening. Both are deliberate: the expensive thing is the
 * request, and a caller probing addresses that turn out not to exist must burn
 * allowance exactly like one probing addresses that do — otherwise the ceiling
 * itself becomes the enumeration oracle the surrounding action works so hard
 * not to be.
 */
export function consumeSendQuota(
  namespace: string,
  subject: string,
  now = Date.now()
): SendQuotaState {
  const bucket = bucketFor(`${namespace}:${subject}`);

  bucket.failures = bucket.failures.filter((t) => now - t < SEND_WINDOW_MS);

  if (bucket.failures.length >= MAX_SENDS) {
    const oldest = bucket.failures[0];
    return {
      exhausted: true,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((oldest + SEND_WINDOW_MS - now) / 1000)
      ),
    };
  }

  bucket.failures.push(now);
  return { exhausted: false, retryAfterSeconds: 0 };
}

// =============================================================================
// THE SHARED STORE
// =============================================================================
//
// Everything above is per-process and in-memory, and the header says plainly
// what that costs: on a serverless platform each instance keeps its own
// counter, so the effective limit across N warm instances is N times the
// configured one, and a cold start resets it. On a platform that scales to
// zero, an 8-attempt lockout is close to no lockout at all.
//
// These are the same controls against a table both instances share
// (20260907000300). The POLICY does not move — MAX_ATTEMPTS, WINDOW_MS,
// LOCKOUT_MS, MAX_SENDS and SEND_WINDOW_MS are still the only definition of the
// numbers, and they are passed into SQL as arguments rather than restated
// there. Only the STORE moves, which is why the unit tests above keep testing
// the arithmetic without a database.
//
// Each SQL function does its read-modify-write under a row lock, so two
// instances racing produce one correct count instead of two independent ones.
//
// WHY service_role
//   A sign-in throttle is consumed by a caller who has not authenticated yet.
//   If `anon` could execute these, an attacker would simply clear their own
//   lockout. EXECUTE is granted to service_role alone and reached through the
//   admin client, which exists only on the server.
//
// WHEN THE DATABASE IS UNREACHABLE
//   Every function below falls back to the in-memory counter rather than
//   failing open. A throttle that stops throttling because a query timed out
//   is worse than a local one, and refusing the sign-in outright would turn a
//   database blip into a clinic-wide outage. The fallback is logged, because
//   "the shared limiter is not working" is something an operator must be able
//   to see.

import { createAdminClient } from "@/lib/supabase/admin";

/* eslint-disable @typescript-eslint/no-explicit-any */
type ThrottleRow = {
  locked: boolean;
  retry_after_seconds: number;
  failures: number;
};

function admin(): any {
  return createAdminClient();
}

/** Current state for an identifier, recording nothing. */
export async function checkRateLimitShared(key: string): Promise<RateLimitState> {
  try {
    const { data, error } = await admin().rpc("throttle_check", {
      p_key: key,
      p_window_ms: WINDOW_MS,
    });
    if (error) throw new Error(error.message);

    const row = (data as ThrottleRow[] | null)?.[0];
    if (!row) return { locked: false, retryAfterSeconds: 0, failures: 0 };

    return {
      locked: row.locked,
      retryAfterSeconds: row.retry_after_seconds,
      failures: row.failures,
    };
  } catch (err) {
    console.error("[rate-limit] shared check failed, using in-process counter:", err);
    return checkRateLimit(key);
  }
}

/** Records a failure and returns the resulting state. */
export async function recordFailureShared(key: string): Promise<RateLimitState> {
  try {
    const { data, error } = await admin().rpc("throttle_record_failure", {
      p_key: key,
      p_max: MAX_ATTEMPTS,
      p_window_ms: WINDOW_MS,
      p_lockout_ms: LOCKOUT_MS,
    });
    if (error) throw new Error(error.message);

    const row = (data as ThrottleRow[] | null)?.[0];
    if (!row) return recordFailure(key);

    return {
      locked: row.locked,
      retryAfterSeconds: row.retry_after_seconds,
      failures: row.failures,
    };
  } catch (err) {
    console.error("[rate-limit] shared record failed, using in-process counter:", err);
    return recordFailure(key);
  }
}

/** Clears the counter for an identifier. Called on a SUCCESSFUL sign-in. */
export async function clearFailuresShared(key: string): Promise<void> {
  // Cleared locally too: if the shared call fails, the in-process counter is
  // what the fallback above will read, and it must not still hold the failures
  // this success just forgave.
  clearFailures(key);
  try {
    const { error } = await admin().rpc("throttle_clear", { p_key: key });
    if (error) throw new Error(error.message);
  } catch (err) {
    console.error("[rate-limit] shared clear failed:", err);
  }
}

/** Consume one send for `namespace` + `subject`, and report whether it was allowed. */
export async function consumeSendQuotaShared(
  namespace: string,
  subject: string
): Promise<SendQuotaState> {
  const key = `${namespace}:${subject}`;
  try {
    const { data, error } = await admin().rpc("throttle_consume_send", {
      p_key: key,
      p_max: MAX_SENDS,
      p_window_ms: SEND_WINDOW_MS,
    });
    if (error) throw new Error(error.message);

    const row = (data as { exhausted: boolean; retry_after_seconds: number }[] | null)?.[0];
    if (!row) return consumeSendQuota(namespace, subject);

    return { exhausted: row.exhausted, retryAfterSeconds: row.retry_after_seconds };
  } catch (err) {
    console.error("[rate-limit] shared send quota failed, using in-process counter:", err);
    return consumeSendQuota(namespace, subject);
  }
}
