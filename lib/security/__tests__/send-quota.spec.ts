/**
 * lib/security/__tests__/send-quota.spec.ts
 *
 * The ceiling on unauthenticated, email-sending actions.
 *
 * WHAT IT DEFENDS
 *   Two server actions are reachable with no session and cause the server to
 *   send mail to an address the caller types: `requestActivation` (patient
 *   portal) and `requestPasswordReset` (every audience). Before this, neither
 *   had a server-side ceiling. The sign-in limiter did not cover them, because
 *   it counts FAILED password attempts and every request to these two succeeds
 *   — the send is the cost, not the failure. The verify-email cooldown did not
 *   either: it is stamped in a cookie, so it costs an attacker one deletion.
 *
 *   Left open, both let someone aim repeated mail at a third party's inbox and
 *   exhaust the clinic's shared provider allowance — which then stops real
 *   patients activating and real dentists resetting passwords.
 *
 * WHY THIS IS A UNIT TEST
 *   The limiter is in-process and in-memory, so its behaviour is fully
 *   determined here. What a unit test CANNOT establish is the caveat the module
 *   states plainly: per serverless instance, cleared by a restart. That is a
 *   real limit of the control, not of the test, and no assertion below implies
 *   otherwise.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  consumeSendQuota,
  MAX_SENDS,
  SEND_ACTIVATION,
  SEND_PASSWORD_RESET,
  SEND_WINDOW_MS,
  resetAllRateLimits,
} from "../rate-limit";

const ADDRESS = "hash-of-someone@example.test";
const OTHER = "hash-of-someone-else@example.test";

describe("consumeSendQuota", () => {
  beforeEach(() => resetAllRateLimits());

  it("allows exactly MAX_SENDS inside the window, then stops", () => {
    for (let i = 0; i < MAX_SENDS; i++) {
      expect(consumeSendQuota(SEND_ACTIVATION, ADDRESS).exhausted).toBe(false);
    }
    expect(consumeSendQuota(SEND_ACTIVATION, ADDRESS).exhausted).toBe(true);
  });

  it("reports a retry time a caller can actually show someone", () => {
    for (let i = 0; i < MAX_SENDS; i++) consumeSendQuota(SEND_ACTIVATION, ADDRESS);
    const state = consumeSendQuota(SEND_ACTIVATION, ADDRESS);

    expect(state.retryAfterSeconds).toBeGreaterThan(0);
    expect(state.retryAfterSeconds).toBeLessThanOrEqual(SEND_WINDOW_MS / 1000);
  });

  it("does not consume further allowance once exhausted", () => {
    const now = Date.now();
    for (let i = 0; i < MAX_SENDS; i++)
      consumeSendQuota(SEND_ACTIVATION, ADDRESS, now);

    // Hammering while blocked must not push the window forward, or an attacker
    // could hold an honest user out indefinitely by continuing to try.
    const first = consumeSendQuota(SEND_ACTIVATION, ADDRESS, now);
    const later = consumeSendQuota(SEND_ACTIVATION, ADDRESS, now + 60_000);
    expect(first.exhausted).toBe(true);
    expect(later.exhausted).toBe(true);
    expect(later.retryAfterSeconds).toBeLessThan(first.retryAfterSeconds);
  });

  it("lets the address through again once the window has passed", () => {
    const now = Date.now();
    for (let i = 0; i < MAX_SENDS; i++)
      consumeSendQuota(SEND_ACTIVATION, ADDRESS, now);
    expect(consumeSendQuota(SEND_ACTIVATION, ADDRESS, now).exhausted).toBe(true);

    // A real patient who genuinely did not receive three codes must not be
    // locked out of their own clinic permanently.
    expect(
      consumeSendQuota(SEND_ACTIVATION, ADDRESS, now + SEND_WINDOW_MS + 1)
        .exhausted
    ).toBe(false);
  });

  it("counts each address separately", () => {
    for (let i = 0; i < MAX_SENDS; i++) consumeSendQuota(SEND_ACTIVATION, ADDRESS);
    expect(consumeSendQuota(SEND_ACTIVATION, ADDRESS).exhausted).toBe(true);

    // One person exhausting their allowance must not stop anyone else.
    expect(consumeSendQuota(SEND_ACTIVATION, OTHER).exhausted).toBe(false);
  });

  it("keeps the two flows' allowances apart", () => {
    for (let i = 0; i < MAX_SENDS; i++) consumeSendQuota(SEND_ACTIVATION, ADDRESS);
    expect(consumeSendQuota(SEND_ACTIVATION, ADDRESS).exhausted).toBe(true);

    // Activating a portal account and resetting a password are different acts
    // by different people at different times. Sharing one counter would mean a
    // patient who used up activation attempts could not then reset a password.
    expect(consumeSendQuota(SEND_PASSWORD_RESET, ADDRESS).exhausted).toBe(false);
  });

  it("is not an enumeration oracle — it cannot tell real from unknown", () => {
    // Both actions consume the quota BEFORE deciding whether the address is
    // real, so the throttle behaves identically either way. If it did not, the
    // ceiling would answer the question the generic response exists to refuse.
    const real = Array.from({ length: MAX_SENDS + 1 }, () =>
      consumeSendQuota(SEND_ACTIVATION, "known").exhausted
    );
    const unknown = Array.from({ length: MAX_SENDS + 1 }, () =>
      consumeSendQuota(SEND_ACTIVATION, "stranger").exhausted
    );
    expect(real).toEqual(unknown);
  });
});
