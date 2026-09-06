import { type NextRequest, NextResponse } from "next/server";
import { createMiddlewareClient } from "@/lib/supabase/middleware-client";
import { adminMfaRequired, readMfaStatus } from "@/lib/auth/mfa";

/**
 * updateSession
 *
 * Called from middleware.ts on every matched request.
 *
 * Responsibilities:
 * 1. Refresh the Supabase session cookie.
 * 2. Resolve the authenticated user's role + admin capability from `profiles`.
 * 3. Enforce route-to-audience access rules:
 *    - /admin/*         → requires profiles.is_admin
 *    - /dentist/*       → requires role === 'dentist'
 *    - /receptionist/*  → requires role === 'receptionist'
 *    - /portal/*        → patients only (staff are bounced to their dashboard)
 *    - / (root)         → redirect based on audience
 *    - sign-in pages    → redirect to home if already authenticated
 * 4. For /portal/*: redirect to /portal/setup if no portal link exists.
 * 5. Send unauthenticated visitors to the sign-in page for the area they asked
 *    for, so a patient deep link never dumps them on the staff form.
 * 6. Hold a session at assurance level aal1 on /mfa when the account has an
 *    authenticator enrolled. This one is NOT merely a UX redirect: it is what
 *    stops a half-completed sign-in reaching clinical data by navigating away
 *    from the challenge screen.
 *
 * Security note: this is a UX redirect layer. Supabase RLS is the
 * authoritative security boundary, and every /admin page additionally calls
 * requireAdmin() server-side — visiting /admin/login or /admin directly can
 * never bypass authorisation, because nothing here is what grants access.
 */
export async function updateSession(
  request: NextRequest,
  /**
   * Headers to make visible to the downstream render (not just the browser).
   * middleware.ts passes the CSP nonce here so the root layout can stamp its
   * inline theme script with it — a response header would not be readable from
   * a Server Component.
   */
  extraRequestHeaders?: Record<string, string>
) {
  const { supabase, response } = createMiddlewareClient(request, extraRequestHeaders);

  // IMPORTANT: do not remove this call — it refreshes the session cookie
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // ── Server Action POSTs — skip the role/profile lookups ───────────────────
  // A Server Action posts to the page's own route, so this middleware runs on
  // every mutation as well as every navigation. The role lookups below exist
  // only to REDIRECT a browser that navigated to the wrong dashboard; a Server
  // Action never navigates, so their result is discarded — but the request
  // still waited on them. That put one `profiles` query (two on /portal/*, via
  // patient_portal_links) in the critical path of every button in the app, and
  // React `cache()` cannot dedupe it because middleware runs in a different
  // execution context from the action it precedes.
  //
  // Authorisation is NOT weakened by skipping them. Every Server Action
  // re-resolves the caller's profile server-side and re-checks role itself
  // (CLAUDE.md §13.4), and RLS remains the authoritative boundary (§13.10).
  // The unauthenticated redirect below is deliberately still applied.
  const isServerAction =
    request.method === "POST" && request.headers.has("next-action");

  // ── Public auth-recovery routes ────────────────────────────────────────────
  // The patient password-reset flow must be reachable without an existing app
  // session: /forgot-password (logged-out patient requesting a link),
  // /auth/callback (exchanges the recovery code → sets the recovery session),
  // and /reset-password (renders within that recovery session). Skipping the
  // auth gate here prevents the "unauthenticated → sign-in" redirect from
  // breaking the flow. Reset itself still relies on the authenticated Supabase
  // account, never on any clinic selection.
  //
  // /patient/verify-email joins them for the same reason. With email
  // confirmation on, `signUp` returns NO session — the account exists but
  // cannot be used until the link is opened. So the one screen that explains
  // that is reached by a visitor the middleware would otherwise class as
  // unauthenticated and bounce to /patient/login, which is exactly the page
  // that cannot help them yet. The page is not left ungated: it renders only
  // while the httpOnly signup cookie is present, and redirects to sign-in
  // otherwise.
  // /.well-known is here for a different reason than the rest of this list.
  // RFC 9116 fixes where security.txt lives, and its entire audience is people
  // with no account — a researcher who has found a way into a clinic's data and
  // is trying to tell someone. Redirecting them to /login means the file cannot
  // be read by the only people it is for, which is the same as not publishing
  // it. Nothing under this prefix reads the session or returns clinic data; the
  // route serves a static contact block or 404s.
  const PUBLIC_AUTH_PATHS = [
    "/forgot-password",
    "/reset-password",
    "/auth/callback",
    "/patient/verify-email",
    "/.well-known",
  ];
  if (PUBLIC_AUTH_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return response();
  }

  // ── Root redirect ──────────────────────────────────────────────────────────
  if (pathname === "/") {
    if (!user) {
      return NextResponse.redirect(new URL("/login", request.url));
    }
    const profile = await resolveProfile(supabase, user.id);
    if (profile === null) {
      // Authenticated but no profile row — mid-onboarding new patient.
      // redirectHome(null) would send to a sign-in page → infinite loop.
      return NextResponse.redirect(new URL("/portal/setup", request.url));
    }
    return redirectHome(profile, request);
  }

  // ── Sign-in / sign-up pages ───────────────────────────────────────────────
  // Three separate doors, plus the legacy /signup alias. An already
  // authenticated visitor is sent to their own home rather than being shown a
  // form they don't need — including on /admin/login, where a non-admin is
  // bounced to their dashboard instead of being invited to try.
  if (SIGN_IN_PATHS.has(pathname)) {
    if (user) {
      const profile = await resolveProfile(supabase, user.id);
      if (profile === null) {
        /*
         * Authenticated with no profile row. That is what a session looks like
         * PART-WAY THROUGH portal activation: step 2 verifies the emailed code,
         * which creates a session, and step 3 then sets the password and writes
         * the profile + portal link (actions/portal-activation.ts).
         *
         * So /patient/signup has to stay reachable here. Redirecting away from
         * it bounced the patient to /portal/setup the instant their code was
         * accepted — after the session existed but before they could choose a
         * password — and the account could never be finished. The flow looked
         * like it worked right up to the last step.
         *
         * Any OTHER sign-in door with a profile-less session is genuinely
         * stranded and still goes to /portal/setup, which explains the state
         * rather than looping.
         */
        if (pathname === "/patient/signup" || pathname === "/signup") {
          return response();
        }
        return NextResponse.redirect(new URL("/portal/setup", request.url));
      }
      return redirectHome(profile, request);
    }
    return response();
  }

  // ── All protected routes — unauthenticated visitors go to the right door ──
  if (!user) {
    const loginUrl = new URL(signInPathFor(pathname), request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // ── Two-step verification ─────────────────────────────────────────────────
  //
  // A password check leaves the session at aal1. If the account has an
  // authenticator enrolled, Supabase reports that it SHOULD be at aal2, and
  // until it is this request is treated as not-yet-signed-in for every
  // protected route. That is what makes the challenge unskippable: navigating
  // away from /mfa lands back here.
  //
  // Skipped for the challenge page itself (or nothing could ever satisfy it)
  // and for Server Actions, which is handled below by the same reasoning as the
  // role lookups — an action re-resolves its own authorisation and a redirect
  // computed here would be discarded.
  if (pathname !== MFA_PATH && !isServerAction) {
    const mfa = await readMfaStatus(supabase);

    if (mfa.challengeRequired) {
      return NextResponse.redirect(new URL(MFA_PATH, request.url));
    }

    // Admin MFA, when the deployment requires it: an admin with NO factor is
    // sent to enrol rather than to a code box it could never satisfy. Scoped to
    // /admin so turning the flag on cannot lock an admin out of the ordinary
    // clinic screens they also use as a dentist.
    if (adminMfaRequired() && !mfa.enrolled && pathname.startsWith("/admin")) {
      const profile = await resolveProfile(supabase, user.id);
      if (profile?.is_admin) {
        return NextResponse.redirect(new URL(MFA_ENROL_PATH, request.url));
      }
    }
  }

  // Authenticated Server Action: the session is refreshed and the caller is
  // known — everything below only computes a redirect this request will never
  // use. See the note above `isServerAction`.
  if (isServerAction) {
    return response();
  }

  // ── /admin/* — requires the platform admin capability ─────────────────────
  // Checked before the role routes because an admin also holds an ordinary
  // role, and because a non-admin must never fall through into this area.
  if (pathname.startsWith("/admin")) {
    const profile = await resolveProfile(supabase, user.id);
    if (!profile?.is_admin) {
      return redirectHome(profile, request);
    }
    return response();
  }

  // ── /dentist/* — requires role === 'dentist' ───────────────────────────────
  if (pathname.startsWith("/dentist")) {
    const profile = await resolveProfile(supabase, user.id);
    if (profile?.role !== "dentist") {
      return redirectHome(profile, request);
    }
    return response();
  }

  // ── /receptionist/* — requires role === 'receptionist' ────────────────────
  if (pathname.startsWith("/receptionist")) {
    const profile = await resolveProfile(supabase, user.id);
    if (profile?.role !== "receptionist") {
      return redirectHome(profile, request);
    }
    return response();
  }

  // ── /portal/* — patient portal; staff are redirected to their dashboard ───
  if (pathname.startsWith("/portal")) {
    // Staff (dentist/receptionist, admin included) must not enter the portal
    // flow — sending them to /portal/setup would invite them to overwrite their
    // own profile (the linking action upserts role = 'patient'). Bounce them to
    // their dashboard instead.
    const profile = await resolveProfile(supabase, user.id);
    if (
      profile &&
      (profile.is_admin ||
        profile.role === "dentist" ||
        profile.role === "receptionist")
    ) {
      return redirectHome(profile, request);
    }

    // /portal/setup is always accessible to authenticated non-staff users
    if (pathname === "/portal/setup") {
      return response();
    }

    const { data: portalLink } = await supabase
      .from("patient_portal_links")
      .select("patient_id")
      .eq("user_id", user.id)
      .single();

    if (!portalLink) {
      return NextResponse.redirect(new URL("/portal/setup", request.url));
    }

    return response();
  }

  return response();
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** The two-step verification challenge. */
const MFA_PATH = "/mfa";

/** Where an admin is sent to add a factor when the deployment requires one. */
const MFA_ENROL_PATH = "/dentist/settings";

/**
 * The three sign-in doors, plus /signup which redirects to /patient/signup.
 * Listed as a Set so the check stays a single exact-match lookup.
 *
 * /mfa is deliberately NOT here. These are pages an already-authenticated
 * visitor should be redirected AWAY from; /mfa is the opposite — it is where a
 * half-authenticated session belongs until it finishes.
 */
const SIGN_IN_PATHS = new Set([
  "/login",
  "/patient/login",
  "/patient/signup",
  "/signup",
  "/admin/login",
]);

// The middleware supabase client is synchronous (not async)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

type MiddlewareProfile = {
  role: "dentist" | "receptionist" | "patient";
  is_admin: boolean;
};

/** Resolve role + admin capability from profiles. Null if there is no row. */
async function resolveProfile(
  supabase: SupabaseClient,
  userId: string
): Promise<MiddlewareProfile | null> {
  const { data } = await supabase
    .from("profiles")
    .select("role, is_admin")
    .eq("id", userId)
    .single();

  const row = data as MiddlewareProfile | null;
  if (!row) return null;
  return { role: row.role, is_admin: row.is_admin === true };
}

/**
 * Which sign-in page a logged-out visitor should land on, based on where they
 * were trying to go. Keeps a bookmarked portal link out of the staff form.
 */
function signInPathFor(pathname: string): string {
  if (pathname.startsWith("/admin")) return "/admin/login";
  if (pathname.startsWith("/portal") || pathname.startsWith("/patient")) {
    return "/patient/login";
  }
  return "/login";
}

/** Send a known profile to its home route. */
function redirectHome(
  profile: MiddlewareProfile | null,
  request: NextRequest
): NextResponse {
  if (profile?.is_admin) {
    return NextResponse.redirect(new URL("/admin", request.url));
  }

  switch (profile?.role) {
    case "dentist":
      return NextResponse.redirect(new URL("/dentist", request.url));
    case "receptionist":
      return NextResponse.redirect(new URL("/receptionist", request.url));
    case "patient":
      return NextResponse.redirect(new URL("/portal", request.url));
    default:
      // No profile row yet — user is mid-onboarding (signed up but hasn't
      // completed portal linking). Send to /portal/setup rather than a sign-in
      // page to avoid a redirect loop: /login → redirectHome(null) → /login → ∞
      return NextResponse.redirect(new URL("/portal/setup", request.url));
  }
}
