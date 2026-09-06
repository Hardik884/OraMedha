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
 *   → A shared store (Redis, or a Postgres table) is the upgrade. Deliberately
 *     not built here: OraMedha runs no such service today, and a fake
 *     distributed limiter that silently is not one is worse than an honest
 *     local one. See docs/SECURITY.md.
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
// SAME HONEST CAVEAT AS ABOVE: in-process and in-memory. Per serverless
// instance, cleared by a restart. Supabase Auth's own per-hour mailer limit
// sits underneath and is the distributed one. This adds what that cannot — a
// PER-ADDRESS ceiling, so one address cannot absorb the whole clinic's hourly
// allowance before anyone else can reset a password.

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
