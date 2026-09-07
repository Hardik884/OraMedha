"use server";

import { createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordSecurityEvent, subjectHash } from "@/lib/security/events";
import { describeEmailSendFailure } from "@/lib/auth/verification";
import {
  consumeSendQuotaShared,
  SEND_ACTIVATION,
} from "@/lib/security/rate-limit";
import type { ActionResult } from "@/types";

/**
 * actions/portal-activation.ts — first-time patient portal activation.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 *   A patient never says which clinic they belong to. The clinic is read from
 *   the patient record the CLINIC created, found by the address the CLINIC put
 *   on it. Nothing about tenancy is ever accepted from the browser.
 *
 *   The old flow asked the patient to pick a clinic from a dropdown and then
 *   matched them to a record by phone number inside it. The clinic id was
 *   validated against `clinics` before use, so it was never a tenant-isolation
 *   hole — but phone is not unique even within one clinic
 *   (20260822000000_drop_patient_phone_uniqueness.sql: households and parents
 *   booking for children share numbers), so "which record is this" came down to
 *   picking the first match. Eligibility now runs the other way: the clinic
 *   issues the address, and the address resolves to exactly one record or the
 *   activation is refused.
 *
 * THE THREE STEPS, AND WHY THEY ARE THREE
 *   1. requestActivation(email)   — proves an eligible record exists, sends a code
 *   2. verifyActivation(email, code) — proves the person controls that inbox
 *   3. completeActivation(password)  — sets a password and LINKS the account
 *
 *   The link is created in step 3, never in step 1 or 2. Until someone has both
 *   proved control of the address and chosen a password, no row ties an auth
 *   user to a patient record — so an abandoned or intercepted activation leaves
 *   nothing behind to inherit.
 *
 * ENUMERATION
 *   Step 1 answers identically whether or not the address belongs to a patient.
 *   That is the whole reason it returns `{ sent: true }` unconditionally. A form
 *   that said "no such patient" would be a way to test which addresses a clinic
 *   holds — which is a list of who is a patient there, and therefore clinical
 *   information about people who never used this product.
 *
 * OTP IS FOR ACTIVATION ONLY
 *   Once step 3 completes, the account is an ordinary email+password account.
 *   Nothing here runs again on subsequent sign-ins, and there is no forced
 *   password change. Recovery afterwards is the SAME mechanism staff use —
 *   actions/auth.ts:requestPasswordReset — not a second system.
 */

/**
 * A patient record eligible to be activated, or the reason it is not.
 *
 * `ambiguous` is its own outcome rather than an error string because it is a
 * real situation with a real answer: a person can genuinely be a patient of two
 * practices under one address, and nothing in the address says which one they
 * mean. Guessing would attach them to one clinic's clinical history on a coin
 * flip, so both are refused and the clinics resolve it.
 */
type Candidate =
  | { kind: "eligible"; patientId: string; clinicId: string; name: string }
  | { kind: "none" }
  | { kind: "ambiguous"; clinics: number }
  | { kind: "already_linked"; patientId: string };

/**
 * Resolve an address to the one patient record it may activate.
 *
 * Runs on the SERVICE ROLE deliberately. The caller is unauthenticated — they
 * have no session to be scoped by, and must not be given one before proving
 * control of the address — so RLS cannot do this lookup. That is the same
 * reasoning actions/auth.ts:resolveResetAudience uses. The tenancy guarantee is
 * not weakened by it: this function READS to decide eligibility and returns a
 * clinic id the caller never supplied and never sees.
 */
async function resolveActivationCandidate(email: string): Promise<Candidate> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin: any = createAdminClient();
  const target = email.trim().toLowerCase();

  // Searched across ALL clinics on purpose — that is the only way to notice the
  // ambiguous case. Scoping to one clinic would silently pick a side.
  const { data, error } = await admin
    .from("patients")
    .select("id, clinic_id, name")
    .eq("email", target)
    .is("deleted_at", null);

  if (error) {
    console.error("[portal-activation] candidate lookup failed:", error.message);
    return { kind: "none" };
  }

  const rows = (data ?? []) as { id: string; clinic_id: string; name: string }[];
  if (rows.length === 0) return { kind: "none" };

  const clinics = new Set(rows.map((r) => r.clinic_id));
  if (clinics.size > 1) return { kind: "ambiguous", clinics: clinics.size };

  // uq_patients_clinic_email_active makes more than one row per clinic
  // impossible, so within a single clinic this is exactly one record.
  const patient = rows[0];

  const { data: existing } = await admin
    .from("patient_portal_links")
    .select("id")
    .eq("patient_id", patient.id)
    .maybeSingle();

  if (existing) return { kind: "already_linked", patientId: patient.id };

  return {
    kind: "eligible",
    patientId: patient.id,
    clinicId: patient.clinic_id,
    name: patient.name,
  };
}

// =============================================================================
// STEP 1 — request a code
// =============================================================================

/**
 * requestActivation
 *
 * Sends an activation code, but only to an address a clinic has put on a
 * patient record that is not already linked.
 *
 * ALWAYS returns the same success. The distinction between "sent" and "not
 * sent" is invisible to the caller by design; the reason is recorded as a
 * security event instead, where an operator can see it and an attacker cannot.
 */
export async function requestActivation(
  _prevState: ActionResult<{ sent: true; email: string }>,
  formData: FormData
): Promise<ActionResult<{ sent: true; email: string }>> {
  const email = ((formData.get("email") as string) ?? "").trim().toLowerCase();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { data: null, error: "Please enter a valid email address." };
  }

  // ── Send ceiling ──────────────────────────────────────────────────────────
  // This action is UNAUTHENTICATED and its whole job is to make the server send
  // mail to an address the caller names. Left open it is a way to deliver
  // repeated mail to somebody else's inbox and to burn the clinic's sending
  // quota, after which no real patient can activate and no dentist can reset a
  // password, because they share one provider allowance.
  //
  // The cooldown on the verify-email screen does not cover this: it is stamped
  // in a cookie, so it shapes the UI for an honest user and costs an attacker
  // one deleted cookie.
  //
  // Consumed BEFORE eligibility is resolved, so an ineligible address burns
  // allowance exactly like an eligible one. Throttling only the addresses that
  // turn out to be real would make the ceiling itself the enumeration oracle
  // that every other line in this file is written to avoid.
  const quota = await consumeSendQuotaShared(SEND_ACTIVATION, subjectHash(email));
  if (quota.exhausted) {
    recordSecurityEvent("PORTAL_ACTIVATION_REFUSED", {
      reason: "send_quota",
      subjectHash: subjectHash(email),
      surface: "portal-activation",
    });
    return {
      data: null,
      error: `Too many requests for this address. Please try again in ${Math.ceil(
        quota.retryAfterSeconds / 60
      )} minute(s).`,
    };
  }

  try {
    const candidate = await resolveActivationCandidate(email);

    if (candidate.kind !== "eligible") {
      // Recorded, not returned. `subjectHash` keeps the security log from
      // becoming a list of which addresses a clinic holds.
      recordSecurityEvent("PORTAL_ACTIVATION_REFUSED", {
        reason: candidate.kind,
        subjectHash: subjectHash(email),
        surface: "portal-activation",
      });
      return { data: { sent: true, email }, error: null };
    }

    const supabase = await createServerClient();

    // shouldCreateUser: true — the auth account is created here, but it is NOT
    // linked to the patient record until completeActivation. An account with no
    // link resolves to no patient and sees nothing (auth_patient_id() returns
    // NULL, so every portal policy matches zero rows), which is why creating it
    // at this point is safe.
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    });

    if (error) {
      const failure = describeEmailSendFailure(error.message);
      console.error(`[requestActivation] ${failure.kind}:`, error.message);
      // A send failure is a system problem, and saying so here would confirm
      // the address is eligible — which is exactly what the generic response
      // above protects. The operator gets the cause from the log.
      return { data: { sent: true, email }, error: null };
    }

    return { data: { sent: true, email }, error: null };
  } catch (err) {
    console.error("[requestActivation] unexpected:", err);
    return { data: { sent: true, email }, error: null };
  }
}

// =============================================================================
// STEP 2 — verify the code
// =============================================================================

/**
 * verifyActivation
 *
 * Exchanges the emailed code for a session. Supabase owns expiry, attempt
 * limits (otp_expiry in supabase/config.toml), so a wrong or stale code fails
 * here rather than in application logic that could drift from it.
 *
 * A session at this point still grants NOTHING: no portal link exists yet, so
 * auth_patient_id() is NULL and every patient-scoped policy matches zero rows.
 */
export async function verifyActivation(
  _prevState: ActionResult<{ verified: true }>,
  formData: FormData
): Promise<ActionResult<{ verified: true }>> {
  const email = ((formData.get("email") as string) ?? "").trim().toLowerCase();
  const token = ((formData.get("token") as string) ?? "").trim();

  if (!email || !token) {
    return { data: null, error: "Enter the code from your email." };
  }

  try {
    const supabase = await createServerClient();

    /*
     * The OTP "type" depends on how Supabase decided to classify the send, and
     * the caller cannot know which it chose.
     *
     * signInWithOtp() is documented as one call, but the email it triggers —
     * and therefore the type the code verifies as — varies with whether the
     * account already existed and how the project is configured:
     *
     *   "signup"    a new account, treated as a signup confirmation
     *   "magiclink" the magic-link path, which is what PRODUCTION actually used
     *               for the same call that took the signup path locally
     *   "email"     a plain email OTP on an existing account
     *
     * That divergence is not theoretical. Verifying against "email" alone
     * rejected a code that had just been issued; adding "signup" fixed it
     * locally and left production still broken, because production was sending
     * magic links. Guessing the classification is the wrong shape of solution —
     * all three are attempted instead.
     *
     * This is not a weakening. Each attempt is a full verification of the same
     * single-use code against the same address; a wrong or expired code fails
     * all three, and a correct one is correct whichever label Supabase filed it
     * under.
     */
    const attempts = ["signup", "magiclink", "email"] as const;
    let error: { message: string } | null = null;

    for (const type of attempts) {
      const result = await supabase.auth.verifyOtp({ email, token, type });
      if (!result.error) {
        error = null;
        break;
      }
      error = result.error;
    }

    if (error) {
      recordSecurityEvent("PORTAL_ACTIVATION_CODE_REJECTED", {
        subjectHash: subjectHash(email),
        surface: "portal-activation",
      });
      // One message for wrong AND expired. Telling them which would say whether
      // a code was ever issued for this address.
      return {
        data: null,
        error: "That code is incorrect or has expired. Request a new one.",
      };
    }

    return { data: { verified: true }, error: null };
  } catch (err) {
    console.error("[verifyActivation] unexpected:", err);
    return { data: null, error: "Something went wrong. Please try again." };
  }
}

// =============================================================================
// STEP 3 — set a password, and link
// =============================================================================

/**
 * completeActivation
 *
 * Sets the password and creates the two rows that make the account real:
 * `patient_portal_links` (auth user ↔ patient record) and `profiles`
 * (role + clinic, which is what every RLS policy reads).
 *
 * The clinic on that profile comes from the patient record found in step 1 —
 * re-resolved here from the session's own verified address rather than carried
 * through the browser, so nothing between the steps can alter it.
 *
 * Re-checks eligibility. Between step 1 and step 3 the clinic may have linked
 * the record, cleared the address, or deleted the patient; a check that only
 * ran at the start would let a stale activation land anyway.
 */
export async function completeActivation(
  _prevState: ActionResult<{ activated: true }>,
  formData: FormData
): Promise<ActionResult<{ activated: true }>> {
  const password = (formData.get("password") as string) ?? "";
  const confirmPassword = (formData.get("confirmPassword") as string) ?? "";

  if (!password || !confirmPassword) {
    return { data: null, error: "All fields are required." };
  }
  if (password !== confirmPassword) {
    return { data: null, error: "Passwords do not match." };
  }
  if (password.length < 8) {
    return { data: null, error: "Password must be at least 8 characters." };
  }

  try {
    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    // No session means the code was never verified, or it has since expired.
    if (!user?.email) {
      return {
        data: null,
        error: "Your activation session has expired. Please start again.",
      };
    }

    // The address is taken from the VERIFIED session, not from the form. This
    // is what stops a caller who verified one address from activating a record
    // belonging to another.
    const candidate = await resolveActivationCandidate(user.email.toLowerCase());

    if (candidate.kind !== "eligible") {
      recordSecurityEvent("PORTAL_ACTIVATION_REFUSED", {
        reason: `complete:${candidate.kind}`,
        subjectHash: subjectHash(user.email),
        surface: "portal-activation",
      });
      return {
        data: null,
        error:
          "This account can't be activated. Please contact your clinic to check your details.",
      };
    }

    const { error: pwError } = await supabase.auth.updateUser({ password });
    if (pwError) {
      return { data: null, error: "Couldn't set that password. Please try again." };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admin: any = createAdminClient();

    // profiles carries the role and clinic every RLS policy reads. upsert
    // because an auth account created by an earlier abandoned attempt may
    // already have one.
    const { error: profileErr } = await admin.from("profiles").upsert(
      {
        id: user.id,
        clinic_id: candidate.clinicId,
        full_name: candidate.name,
        role: "patient",
      },
      { onConflict: "id" }
    );
    if (profileErr) {
      console.error("[completeActivation] profile:", profileErr);
      return { data: null, error: "Couldn't finish activation. Please try again." };
    }

    // The link itself. patient_id and user_id are both UNIQUE, so a race
    // between two activations of the same record loses here rather than
    // producing two links — which is why this is the last step and why the
    // error is handled rather than assumed away.
    const { error: linkErr } = await admin
      .from("patient_portal_links")
      .insert({ patient_id: candidate.patientId, user_id: user.id });

    if (linkErr) {
      console.error("[completeActivation] link:", linkErr);
      return {
        data: null,
        error:
          "This patient record is already linked to another account. Please contact your clinic.",
      };
    }

    // Marks the record as portal-active for staff-facing views. Not the source
    // of truth for access — the link is — so a failure here is logged and does
    // not fail the activation.
    const { error: stampErr } = await admin
      .from("patients")
      .update({ portal_registered_at: new Date().toISOString() })
      .eq("id", candidate.patientId);
    if (stampErr) console.error("[completeActivation] stamp:", stampErr);

    recordSecurityEvent("PORTAL_ACTIVATED", {
      subjectHash: subjectHash(user.email),
      surface: "portal-activation",
    });

    return { data: { activated: true }, error: null };
  } catch (err) {
    console.error("[completeActivation] unexpected:", err);
    return { data: null, error: "Something went wrong. Please try again." };
  }
}
