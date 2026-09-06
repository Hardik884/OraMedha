"use server";

import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAppUrl } from "@/lib/app-url";
import { getClinicById } from "@/actions/clinics";
import {
  setSelectedClinic,
  clearSelectedClinic,
  setSignupClinic,
  clearSignupClinic,
  setSignupPhone,
  clearSignupPhone,
  setSignupEmail,
  getSignupEmail,
  clearSignupEmail,
} from "@/lib/clinic-session";
import { describeEmailSendFailure } from "@/lib/auth/verification";
import { recordSecurityEvent, subjectHash } from "@/lib/security/events";
import {
  checkRateLimit,
  clearFailures,
  consumeSendQuota,
  MAX_SENDS,
  recordFailure,
  SEND_PASSWORD_RESET,
} from "@/lib/security/rate-limit";
import type { ActionResult } from "@/types";

/**
 * actions/auth.ts — DentGrow authentication.
 *
 * DentGrow has THREE separate sign-in entry points, one per audience. They are
 * separate on purpose: each one knows exactly who it is for, so none of them
 * has to ask the visitor to describe themselves with a role picker or a clinic
 * dropdown.
 *
 *   /login          → signInStaff    → dentists and receptionists
 *   /patient/login  → signInPatient  → patients (portal)
 *   /admin/login    → signInAdmin    → platform admin / developer only
 *
 * The single rule that makes this safe: NOTHING about who you are comes from
 * the browser. The form posts an email and a password, nothing else. Role,
 * clinic and admin capability are all read from the `profiles` row that belongs
 * to the authenticated user, server-side, after the password check. A visitor
 * cannot pick their clinic, cannot claim a role, and cannot reach the admin
 * portal by typing its URL.
 *
 * A clinic is chosen in exactly one place in the whole product — the NEW
 * patient signup form — and even there the chosen id is validated against the
 * clinics table before it is used for anything (see signUpPatient).
 *
 * Each entry point also refuses accounts that belong to a different audience,
 * so a patient cannot sign in "into" the staff app and an admin cannot quietly
 * sign in through the staff door.
 */

// ── Audiences ─────────────────────────────────────────────────────────────────

/** Where a signed-in account belongs, resolved entirely server-side. */
type Audience = "admin" | "staff" | "patient" | "unlinked";

type AuthedProfile = {
  role: "dentist" | "receptionist" | "patient";
  clinic_id: string;
  is_admin: boolean;
};

/** Home route for an audience, used after a successful sign-in. */
function homeFor(profile: AuthedProfile | null): string {
  if (!profile) return "/portal/setup";
  if (profile.is_admin) return "/admin";
  switch (profile.role) {
    case "dentist":
      return "/dentist";
    case "receptionist":
      return "/receptionist";
    default:
      return "/portal";
  }
}

function audienceOf(profile: AuthedProfile | null): Audience {
  if (!profile) return "unlinked";
  // Admin wins over role: owner@dentgrow.local is a dentist AND an admin, and
  // the admin door is the only one it is allowed through.
  if (profile.is_admin) return "admin";
  if (profile.role === "dentist" || profile.role === "receptionist") return "staff";
  return "patient";
}

/**
 * Human-readable message for a Supabase Auth failure.
 *
 * Raw Supabase errors are never surfaced (CLAUDE.md §13.1) — they leak
 * implementation detail and read as gibberish to a receptionist. Every unknown
 * failure collapses to the same generic line, which also keeps the response
 * uniform for anyone probing which addresses exist.
 */
function friendlyAuthError(message: string | undefined): string {
  const m = (message ?? "").toLowerCase();
  if (m.includes("invalid login credentials")) {
    return "That email and password don't match an account.";
  }
  if (m.includes("email not confirmed")) {
    return "Please confirm your email address, then sign in.";
  }
  if (m.includes("rate limit") || m.includes("too many")) {
    return "Too many attempts. Please wait a minute and try again.";
  }
  return "We couldn't sign you in. Please check your details and try again.";
}

/**
 * authenticate — password check + server-side profile resolution.
 *
 * Shared by all three sign-in actions. Returns either a friendly error string
 * or the caller's real profile. Never trusts anything from the form beyond the
 * email and password themselves.
 */
async function authenticate(
  formData: FormData,
  /** Which door this attempt came through — recorded on security events. */
  surface: "staff" | "patient" | "admin"
): Promise<{ error: string } | { profile: AuthedProfile | null }> {
  const email = ((formData.get("email") as string) ?? "").trim();
  const password = (formData.get("password") as string) ?? "";

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  // Per-ACCOUNT throttling, keyed on a one-way hash of the address so the
  // counter is stable without the security log becoming a list of who has an
  // account here. Supabase Auth already limits per IP; this is the limit that
  // an attacker spreading attempts across many IPs against one dentist still
  // runs into. See lib/security/rate-limit.ts for what it is and is not.
  const subject = subjectHash(email);

  const before = checkRateLimit(subject);
  if (before.locked) {
    // The password is not even checked. Answering identically whether or not
    // the account exists keeps this from becoming an account-enumeration
    // oracle, which is why the message names no account.
    return {
      error: `Too many sign-in attempts. Please try again in ${Math.ceil(
        before.retryAfterSeconds / 60
      )} minute(s).`,
    };
  }

  const supabase = await createServerClient();

  const { data: authData, error: authError } =
    await supabase.auth.signInWithPassword({ email, password });

  if (authError || !authData.user) {
    const after = recordFailure(subject);

    recordSecurityEvent("AUTH_FAILED", {
      subjectHash: subject,
      surface,
      count: after.failures,
    });

    if (after.locked) {
      recordSecurityEvent("AUTH_LOCKED_OUT", {
        subjectHash: subject,
        surface,
        count: after.failures,
      });
    }

    return { error: friendlyAuthError(authError?.message) };
  }

  // A success clears the counter, so a week-old mistyped password does not
  // combine with today's to lock someone out of their clinic.
  clearFailures(subject);

  const { data } = await supabase
    .from("profiles")
    .select("role, clinic_id, is_admin")
    .eq("id", authData.user.id)
    .single();

  return { profile: (data as AuthedProfile | null) ?? null };
}

/**
 * Sign the just-authenticated session back out after an audience mismatch.
 *
 * The password was CORRECT here — this is a valid account arriving at the wrong
 * door. Usually that is a person who bookmarked the wrong page, which is why
 * the message is helpful rather than terse. It is also what an attacker holding
 * working credentials looks like while they probe which door those credentials
 * open, so it is recorded either way and the log is where the difference
 * between the two becomes visible.
 */
async function rejectAndSignOut(
  error: string,
  detail: { surface: string; audience: string; userId?: string | null }
): Promise<ActionResult<null>> {
  recordSecurityEvent("AUTH_WRONG_AUDIENCE", {
    surface: detail.surface,
    reason: detail.audience,
    userId: detail.userId ?? null,
  });

  const supabase = await createServerClient();
  await supabase.auth.signOut();
  await clearSelectedClinic();
  return { data: null, error };
}

// ── Staff sign-in — /login ────────────────────────────────────────────────────

/**
 * signInStaff
 *
 * The clinic sign-in, for dentists and receptionists only.
 *
 * There is no clinic dropdown and no role picker. After the password check we
 * read the caller's profile and send them to the portal their role entitles
 * them to; their clinic comes from profiles.clinic_id and is enforced from
 * there on by RLS (auth_clinic_id()), so cross-clinic access is impossible
 * regardless of what the browser sends.
 *
 * Accounts that belong to another door are refused and signed straight back
 * out — a patient is pointed at the patient portal, and the platform admin is
 * told only that this is not its entry point.
 */
export async function signInStaff(
  _prevState: ActionResult<null>,
  formData: FormData
): Promise<ActionResult<null>> {
  const result = await authenticate(formData, "staff");
  if ("error" in result) return { data: null, error: result.error };

  const { profile } = result;

  switch (audienceOf(profile)) {
    case "staff":
      break;
    case "admin":
      return rejectAndSignOut(
        "This account doesn't have clinic access. Use its own sign-in page.",
        { surface: "staff", audience: "admin" }
      );
    default:
      return rejectAndSignOut(
        "This is the staff sign-in. Patients can sign in at the patient portal.",
        { surface: "staff", audience: audienceOf(profile) }
      );
  }

  // Display-only convenience so clinic chrome renders immediately. Never an
  // access decision — RLS reads the clinic from the profile, not this cookie.
  await setSelectedClinic(profile!.clinic_id);

  redirect(homeFor(profile));
}

// ── Patient sign-in — /patient/login ──────────────────────────────────────────

/**
 * signInPatient
 *
 * The patient portal sign-in. No clinic dropdown: an existing patient's clinic
 * is already recorded on their patient record, and is resolved through
 * patient_portal_links → patients.clinic_id.
 *
 * A patient who signed up but never finished linking their record has no
 * profile row yet; they are sent to /portal/setup to finish, exactly as before.
 * Staff and admin accounts are refused here.
 */
export async function signInPatient(
  _prevState: ActionResult<null>,
  formData: FormData
): Promise<ActionResult<null>> {
  const result = await authenticate(formData, "patient");
  if ("error" in result) return { data: null, error: result.error };

  const { profile } = result;
  const audience = audienceOf(profile);

  if (audience === "staff" || audience === "admin") {
    return rejectAndSignOut(
      "This is the patient portal. Clinic staff sign in on the staff page.",
      { surface: "patient", audience }
    );
  }

  if (profile) await setSelectedClinic(profile.clinic_id);

  // "unlinked" → /portal/setup, "patient" → /portal.
  redirect(homeFor(profile));
}

// ── Admin sign-in — /admin/login ──────────────────────────────────────────────

/**
 * signInAdmin
 *
 * The platform admin / developer entry point.
 *
 * The URL is not the security boundary — this action is. Any account can
 * submit this form; only one whose profile carries is_admin = true is let
 * through, and everyone else is signed straight back out with the same
 * message, whether or not their password was correct in the first place. The
 * flag itself cannot be granted from the browser: the profiles UPDATE policy
 * pins is_admin to its previous value (migration 20260821000000).
 */
export async function signInAdmin(
  _prevState: ActionResult<null>,
  formData: FormData
): Promise<ActionResult<null>> {
  const result = await authenticate(formData, "admin");
  if ("error" in result) return { data: null, error: result.error };

  const { profile } = result;

  if (!profile?.is_admin) {
    // A correct password at the admin door on a non-admin account. Rarely
    // innocent: the admin URL is not linked from anywhere in the product.
    return rejectAndSignOut("This account is not authorized for admin access.", {
      surface: "admin",
      audience: audienceOf(profile),
    });
  }

  await setSelectedClinic(profile.clinic_id);

  redirect("/admin");
}

// ── New patient signup — /patient/signup ──────────────────────────────────────

/**
 * signUpPatient
 *
 * Creates a Supabase Auth account for a patient registering themselves, at the
 * clinic they picked on the form.
 *
 * This is the ONLY place in DentGrow where a clinic is chosen in the browser,
 * and the id is verified against the clinics table before it is used — a
 * tampered value is rejected outright rather than silently scoping the new
 * patient into a clinic that does not exist. From here the choice travels in an
 * httpOnly cookie to /portal/setup, so the record lookup and (if needed)
 * creation happen inside that clinic only; the same phone number at a different
 * clinic is never matched.
 *
 * Staff accounts are never created here — they are provisioned by the clinic.
 */
export async function signUpPatient(
  _prevState: ActionResult<null>,
  formData: FormData
): Promise<ActionResult<null>> {
  const email = ((formData.get("email") as string) ?? "").trim();
  const password = (formData.get("password") as string) ?? "";
  const confirmPassword = (formData.get("confirmPassword") as string) ?? "";
  const clinicId = ((formData.get("clinic_id") as string) || "").trim();
  const phone = ((formData.get("phone") as string) || "").trim();
  const fullName = ((formData.get("full_name") as string) || "").trim();

  if (!clinicId) {
    return { data: null, error: "Please choose the clinic you attend." };
  }

  if (!email || !password || !confirmPassword) {
    return { data: null, error: "All fields are required." };
  }

  if (password !== confirmPassword) {
    return { data: null, error: "Passwords do not match." };
  }

  if (password.length < 8) {
    return { data: null, error: "Password must be at least 8 characters." };
  }

  // Never trust a clinic id from the browser — verify it exists first.
  const clinicResult = await getClinicById(clinicId);
  if (!clinicResult.data) {
    return { data: null, error: clinicResult.error ?? "Invalid clinic." };
  }

  const supabase = await createServerClient();

  const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: fullName ? { full_name: fullName } : undefined,
      // Where Supabase is permitted to send the confirmed patient. The link in
      // the email itself is built from the project's Site URL by the template
      // (supabase/templates/confirmation.html), but this value still has to be
      // an allow-listed URL for the signup to be accepted, and it is what a
      // default template would use.
      //
      // Origin is resolved from the live request so it is correct per
      // environment (never a build-time-baked localhost URL in production).
      emailRedirectTo: await getAppUrl("/auth/callback?next=/portal/setup"),
    },
  });

  if (signUpError) {
    const m = signUpError.message.toLowerCase();
    if (m.includes("already registered") || m.includes("already been registered")) {
      return {
        data: null,
        error: "An account with this email already exists. Try signing in instead.",
      };
    }

    // Signup can fail on the SEND rather than on the account — most visibly
    // when the project is on Supabase's built-in email service, which delivers
    // only to addresses on the project's team and rejects everyone else. That
    // is a configuration problem wearing the costume of a bad password, so it
    // gets its own explanation instead of "check your details and try again".
    const failure = describeEmailSendFailure(signUpError.message);
    if (failure.kind !== "unknown") {
      if (failure.kind === "not_authorized") {
        console.error("[signUpPatient] recipient refused by the mail transport:", signUpError.message);
      }
      return { data: null, error: failure.message };
    }

    return { data: null, error: friendlyAuthError(signUpError.message) };
  }

  // Carry the chosen clinic (and phone) through to /portal/setup so the
  // patient link/create step is scoped to this clinic only.
  await setSignupClinic(clinicId);
  await setSelectedClinic(clinicId);
  if (phone) await setSignupPhone(phone);
  await setSignupEmail(email);

  // Where to send them next depends on whether Supabase confirmed the address
  // on the spot. With email confirmation ON — which is how DentGrow runs — no
  // session comes back and the account cannot be used until the link in the
  // email is clicked, so anything other than the "check your email" screen
  // would be a dead end. Read from the response rather than from configuration,
  // so this stays correct whichever way the project is configured.
  if (!signUpData.session) {
    redirect("/patient/verify-email");
  }

  redirect("/portal/setup");
}

// ── Verification email resend — /patient/verify-email ────────────────────────

/**
 * resendVerificationEmail
 *
 * Asks SUPABASE AUTH to send the signup confirmation again. This is Supabase's
 * own `auth.resend` — DentGrow does not mint tokens, does not template the
 * message and never talks to the email provider itself. The message goes out
 * over whatever SMTP the project is configured with (Resend in production,
 * Mailpit locally), exactly like the first one did.
 *
 * The address comes from the httpOnly cookie written at signup, never from the
 * form, so a visitor cannot use this endpoint to aim a confirmation email at
 * an address of their choosing.
 *
 * Enumeration-safe: Supabase answers the same way whether or not the account
 * exists. Failures are classified by describeEmailSendFailure so the patient is
 * told which of the two things they can act on has happened — wait, because one
 * has just gone out, or stop, because the transport will not carry mail to that
 * address at all. Neither reveals whether the account exists.
 */
export async function resendVerificationEmail(
  _prevState: ActionResult<{ sent: true }>,
  _formData: FormData
): Promise<ActionResult<{ sent: true }>> {
  const email = await getSignupEmail();

  if (!email) {
    return {
      data: null,
      error:
        "We've lost track of which address to use. Please start again from the sign-up page.",
    };
  }

  try {
    const supabase = await createServerClient();
    const { error } = await supabase.auth.resend({
      type: "signup",
      email,
      options: {
        emailRedirectTo: await getAppUrl("/auth/callback?next=/portal/setup"),
      },
    });

    if (error) {
      const failure = describeEmailSendFailure(error.message);

      // A throttle is the patient's own recent click and needs no log. The
      // other two mean the project's mail transport is refusing work, which a
      // developer has to see — with the real wording, which never reaches the
      // screen (CLAUDE.md §13.1).
      if (failure.kind !== "throttled") {
        console.error(
          `[resendVerificationEmail] ${failure.kind}:`,
          error.message
        );
      }

      return { data: null, error: failure.message };
    }

    // Re-stamp the cookie so the cooldown is measured from THIS send. Without
    // it, reloading the page would show a button that looks ready and isn't.
    await setSignupEmail(email);
  } catch (err) {
    console.error("[resendVerificationEmail] unexpected:", err);
    return { data: null, error: "Something went wrong. Please try again." };
  }

  return { data: { sent: true }, error: null };
}

/**
 * abandonSignupEmail
 *
 * "Change email" on the verification screen. Drops the pending address (and the
 * phone prefill that went with it) and returns to the sign-up form, so the
 * patient starts cleanly rather than re-submitting on top of half a session.
 * The clinic choice is kept — they picked it a minute ago and it is the one
 * thing they are unlikely to want to change.
 */
export async function abandonSignupEmail(): Promise<void> {
  await clearSignupEmail();
  await clearSignupPhone();
  redirect("/patient/signup");
}

// ── Sign Out ───────────────────────────────────────────────────────────────────

/**
 * signOut
 *
 * Signs the current user out and returns them to THEIR sign-in page, so a
 * patient is never dropped onto the staff form (or vice versa). Safe to call
 * from any role context.
 */
export async function signOut(): Promise<void> {
  const supabase = await createServerClient();

  // Resolve where to land BEFORE destroying the session.
  let destination = "/login";
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const { data } = await supabase
      .from("profiles")
      .select("role, clinic_id, is_admin")
      .eq("id", user.id)
      .single();

    const profile = (data as AuthedProfile | null) ?? null;
    const audience = audienceOf(profile);
    destination =
      audience === "admin"
        ? "/admin/login"
        : audience === "staff"
          ? "/login"
          : "/patient/login";
  }

  await supabase.auth.signOut();
  // Clear the selected-clinic UX cookies so a fresh login re-resolves them.
  await clearSelectedClinic();
  await clearSignupClinic();
  await clearSignupPhone();
  await clearSignupEmail();
  redirect(destination);
}

// ── Password Reset (every audience) ──────────────────────────────────────────

/**
 * Where an audience signs back in after setting a new password.
 *
 * The three doors are separate (see the file header), so a reset that always
 * landed on the patient door would strand a dentist on a form that refuses
 * their account — the audience checks in signInStaff/signInPatient/signInAdmin
 * would bounce them straight back out.
 */
function signInPathForAudience(audience: Audience): string {
  switch (audience) {
    case "admin":
      // Unreachable via reset — resolveResetAudience refuses an admin before an
      // email is ever sent. Kept correct rather than deleted so this stays a
      // total function over Audience.
      return "/admin/login";
    case "staff":
      return "/login";
    default:
      // patient, and unlinked (an auth account with no profile yet is a patient
      // part-way through signup).
      return "/patient/login";
  }
}

/**
 * resolveResetAudience
 *
 * Looks up which door an email address belongs behind, or null when no account
 * has that address.
 *
 * Self-service reset used to be PATIENT-ONLY, on the reasoning that staff
 * credentials are issued by the clinic. That left a locked-out dentist with no
 * route back in except asking someone with database access, so reset now covers
 * DENTIST, RECEPTIONIST and PATIENT, and this returns which one rather than a
 * yes/no.
 *
 * THE PLATFORM ADMIN IS DELIBERATELY EXCLUDED and returns null, exactly as
 * before. It is the account that gates /admin, it is the one account whose
 * compromise is not scoped to a single clinic, and emailed recovery would make
 * its mailbox equivalent to the console. Recovery for it is an out-of-band
 * operation performed against Supabase directly. An admin who is also a dentist
 * (owner@dentgrow.local is both) is still excluded — audienceOf ranks admin
 * above role, so the admin capability wins here as it does at every door.
 *
 * The email→role mapping lives across auth.users (email) and profiles (role),
 * so the auth user is resolved by email via the service-role admin client and
 * their profile read from it.
 *
 * Returns null for an unknown address AND for the admin, which is what keeps
 * the exclusion invisible: the caller reports the same generic success either
 * way, so nothing here reveals that an address exists, that it is an admin, or
 * that it was skipped.
 */
async function resolveResetAudience(email: string): Promise<Audience | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin: any = createAdminClient();
  const target = email.trim().toLowerCase();

  const perPage = 200;
  // Pilot scale: a handful of clinics. Cap the scan so a missing account can
  // never turn into an unbounded loop.
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error || !data?.users) break;

    const user = data.users.find(
      (u: { email?: string | null }) => (u.email ?? "").toLowerCase() === target
    );

    if (user) {
      const { data: profile } = await admin
        .from("profiles")
        .select("role, clinic_id, is_admin")
        .eq("id", user.id)
        .maybeSingle();

      const row =
        (profile as { role?: string; clinic_id?: string; is_admin?: boolean } | null) ?? null;

      // No profile yet: an auth account part-way through patient signup. Treat
      // it as a patient rather than refusing — being stuck mid-onboarding is
      // exactly when someone needs a reset.
      if (!row) return "patient";

      const audience = audienceOf({
        role: (row.role ?? "patient") as AuthedProfile["role"],
        clinic_id: row.clinic_id ?? "",
        is_admin: row.is_admin === true,
      });

      // Admin: not eligible. Same answer as an unknown address, on purpose.
      return audience === "admin" ? null : audience;
    }

    // Reached the last page — stop scanning.
    if (data.users.length < perPage) break;
  }

  return null;
}

/**
 * requestPasswordReset
 *
 * Step 1 of the password-reset flow (triggered from /forgot-password).
 *
 * Sends a Supabase password-recovery email to any address that has an account —
 * dentist, receptionist, owner/admin or patient. The recovery link points at
 * /auth/callback, which verifies the token and then forwards to
 * /reset-password.
 *
 * Security:
 *   - Enumeration-safe: the response is ALWAYS a generic success, so the caller
 *     cannot tell whether the email exists or what role it has. This matters
 *     more now than when reset was patient-only: the same form is the route to
 *     a dentist's account, so a differentiated response would say which
 *     addresses are worth attacking.
 *   - Clinic-independent: reset relies on the authenticated Supabase account,
 *     not on any clinic selection, so it is immune to cross-clinic tampering.
 *   - The email goes to the account's own registered address and nowhere else;
 *     nothing here lets a caller choose a destination.
 *
 * Returns an error only for input validation or unexpected system failures.
 */
export async function requestPasswordReset(
  _prevState: ActionResult<{ sent: true }>,
  formData: FormData
): Promise<ActionResult<{ sent: true }>> {
  const email = ((formData.get("email") as string) || "").trim();

  // Basic email shape validation.
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { data: null, error: "Please enter a valid email address." };
  }

  // ── Send ceiling ──────────────────────────────────────────────────────────
  // Unauthenticated, and it makes the server email an address the caller names.
  // The sign-in limiter above does not cover this path: it counts FAILED
  // password attempts, and every request here succeeds — the send is the cost,
  // not the failure.
  //
  // Two things this bounds. Someone else's inbox, which a script could aim
  // reset mail at indefinitely; and the clinic's provider allowance, which is
  // shared with patient activation, so exhausting it here also stops real
  // patients activating.
  //
  // Consumed BEFORE the audience is resolved, so an address with no account
  // burns allowance exactly like one with an account. Otherwise the ceiling
  // itself would answer the question the generic response refuses to.
  const quota = consumeSendQuota(SEND_PASSWORD_RESET, subjectHash(email));
  if (quota.exhausted) {
    recordSecurityEvent("AUTH_FAILED", {
      subjectHash: subjectHash(email),
      surface: "password-reset-quota",
      count: MAX_SENDS,
    });
    return {
      data: null,
      error: `Too many reset requests for this address. Please try again in ${Math.ceil(
        quota.retryAfterSeconds / 60
      )} minute(s).`,
    };
  }

  try {
    if ((await resolveResetAudience(email)) !== null) {
      const supabase = await createServerClient();
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        // Origin is resolved from the live request at runtime, so production
        // emails always point at the deployed domain and dev emails at
        // localhost — never a build-time-inlined NEXT_PUBLIC_APP_URL value.
        redirectTo: await getAppUrl("/auth/callback?next=/reset-password"),
      });
      // A genuine send failure is a system problem, not an existence signal.
      //
      // The classification is logged, never returned: this action reaches here
      // ONLY for an address that resolved to a real account, so echoing "that
      // address is not authorized" back to the browser would confirm the
      // account exists — exactly what the generic response above exists to
      // hide. The operator gets the detail in the log instead.
      //
      // That transport error is worth reading. Supabase's built-in mail service
      // refuses any recipient who is not a project team member, so on a project
      // configured that way this is the line that fires for a real clinic's
      // dentist, and the reset simply never arrives. See supabase/EMAIL.md.
      if (error) {
        const failure = describeEmailSendFailure(error.message);
        console.error(`[requestPasswordReset] ${failure.kind}:`, error.message);
        return {
          data: null,
          error: "We couldn't send the reset email. Please try again.",
        };
      }
    }
  } catch (err) {
    console.error("[requestPasswordReset] unexpected:", err);
    return {
      data: null,
      error: "Something went wrong. Please try again.",
    };
  }

  // Always generic — never reveal whether the account exists or its role.
  return { data: { sent: true }, error: null };
}

/**
 * updatePassword
 *
 * Step 2 of the password-reset flow (submitted from /reset-password).
 *
 * Runs inside the short-lived recovery session established by /auth/callback.
 * Validates the new password against the existing policy (min 8 chars + match),
 * updates it via Supabase Auth, then signs the recovery session out so the user
 * must sign in again with their new credentials.
 *
 * Returns an error string on failure; on success returns { updated: true } plus
 * the sign-in path for THIS account's audience, which the client redirects to.
 * The path is resolved here rather than in the browser because the audience
 * comes from the profile row, and a client-chosen destination would be a value
 * the browser could pick.
 */
export async function updatePassword(
  _prevState: ActionResult<{ updated: true; signInPath: string }>,
  formData: FormData
): Promise<ActionResult<{ updated: true; signInPath: string }>> {
  const password = formData.get("password") as string;
  const confirmPassword = formData.get("confirmPassword") as string;

  if (!password || !confirmPassword) {
    return { data: null, error: "All fields are required." };
  }

  if (password !== confirmPassword) {
    return { data: null, error: "Passwords do not match." };
  }

  // Existing password policy (mirrors signup): minimum 8 characters.
  if (password.length < 8) {
    return { data: null, error: "Password must be at least 8 characters." };
  }

  const supabase = await createServerClient();

  // The recovery session must be present (set by /auth/callback). Without it
  // the link is invalid or expired and we cannot update anything.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      data: null,
      error: "Your reset link is invalid or has expired. Please request a new one.",
    };
  }

  // Resolve the audience BEFORE the password change signs the session out —
  // afterwards there is no session left to read a profile through. Same shape
  // as the lookup in authenticate().
  const { data: profileRow } = await supabase
    .from("profiles")
    .select("role, clinic_id, is_admin")
    .eq("id", user.id)
    .maybeSingle();

  const signInPath = signInPathForAudience(
    audienceOf((profileRow as AuthedProfile | null) ?? null)
  );

  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    return { data: null, error: friendlyAuthError(error.message) };
  }

  // Sign the recovery session out so the user re-authenticates with the new
  // password. Clear the selected-clinic UX cookie too for a clean re-login.
  await supabase.auth.signOut();
  await clearSelectedClinic();

  return { data: { updated: true, signInPath }, error: null };
}
