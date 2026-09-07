import { cookies } from "next/headers";

/**
 * lib/clinic-session.ts
 *
 * Cookie helpers for the selected-clinic UX layer.
 *
 * IMPORTANT — security model:
 *   These cookies are a UX/display convenience only. They are NEVER trusted
 *   for data access decisions. All clinic-scoped data access is authorised by
 *   the authenticated user's profiles.clinic_id and enforced by Supabase RLS
 *   (auth_clinic_id()). A tampered cookie cannot expose another clinic's data.
 *
 * Two cookies are used:
 *   - SELECTED_CLINIC_COOKIE: the clinic the logged-in session is operating in.
 *       Set on successful login, cleared on logout.
 *   - SIGNUP_EMAIL_COOKIE: the address signed up with, so
 *       /patient/verify-email can show it masked and resend its confirmation
 *       without asking for it again.
 *
 * There were four. SIGNUP_CLINIC_COOKIE and SIGNUP_PHONE_COOKIE carried a
 * browser-chosen clinic and phone from the old self-registration form through
 * to /portal/setup, and both were deleted with signUpPatient and
 * linkPortalAccount. Nothing reads a clinic from a cookie any more, anywhere.
 *
 * These helpers may only be called from Server Actions / Route Handlers
 * (where cookies can be written) or Server Components (read-only).
 */

export const SELECTED_CLINIC_COOKIE = "dg_selected_clinic";
export const SIGNUP_EMAIL_COOKIE = "dg_signup_email";

const COMMON_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

/** Persist the selected clinic for the logged-in session. */
export async function setSelectedClinic(clinicId: string): Promise<void> {
  const store = await cookies();
  store.set(SELECTED_CLINIC_COOKIE, clinicId, {
    ...COMMON_OPTIONS,
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
}

/** Read the selected clinic for the current session (display only). */
export async function getSelectedClinic(): Promise<string | null> {
  const store = await cookies();
  return store.get(SELECTED_CLINIC_COOKIE)?.value ?? null;
}

/** Clear the selected clinic — called on logout. */
export async function clearSelectedClinic(): Promise<void> {
  const store = await cookies();
  store.delete(SELECTED_CLINIC_COOKIE);
}







/**
 * Carry the address just signed up with through to /patient/verify-email.
 *
 * The verification screen needs it for two things: showing a masked version so
 * the patient can spot a typo, and asking Supabase Auth to resend the
 * confirmation. It is httpOnly and server-read for the same reason the clinic
 * cookie is — the browser must not be able to nominate which address gets a
 * confirmation email sent to it. A tampered value can still only ever trigger
 * Supabase's own resend for an unconfirmed account, and Supabase answers
 * identically whether or not that account exists (see resendVerificationEmail).
 */
export async function setSignupEmail(email: string): Promise<void> {
  const store = await cookies();
  // `<millis>|<address>`. The timestamp is when a confirmation was last sent
  // for this address — see getSignupEmailState for why the screen needs it.
  store.set(SIGNUP_EMAIL_COOKIE, `${Date.now()}|${email}`, {
    ...COMMON_OPTIONS,
    maxAge: 60 * 60, // 1 hour — the confirmation link's own lifetime
  });
}

/** Read the address signed up with (used by /patient/verify-email). */
export async function getSignupEmail(): Promise<string | null> {
  return (await getSignupEmailState())?.email ?? null;
}

/**
 * The pending signup address together with when its confirmation was last sent.
 *
 * The timestamp exists because Supabase refuses a second confirmation email
 * inside `auth.email.max_frequency`, counted from the FIRST one — the one
 * signup itself triggered. Without knowing when that happened, the verification
 * screen renders an enabled "Resend email" button that is guaranteed to be
 * rejected for the next minute, and the patient reads a throttle response as a
 * failure. With it, the button opens already counting down.
 *
 * `sentAt` is null for a cookie written before this format existed, in which
 * case the caller should assume the window has passed rather than lock a button
 * for no reason.
 */
export async function getSignupEmailState(): Promise<{
  email: string;
  sentAt: number | null;
} | null> {
  const store = await cookies();
  const raw = store.get(SIGNUP_EMAIL_COOKIE)?.value;
  if (!raw) return null;

  const separator = raw.indexOf("|");
  if (separator < 0) return { email: raw, sentAt: null };

  const millis = Number(raw.slice(0, separator));
  const email = raw.slice(separator + 1);
  if (!email) return null;

  return { email, sentAt: Number.isFinite(millis) ? millis : null };
}

/** Clear the signup email cookie once the account is confirmed or abandoned. */
export async function clearSignupEmail(): Promise<void> {
  const store = await cookies();
  store.delete(SIGNUP_EMAIL_COOKIE);
}
