/**
 * lib/staff/dentist-directory.ts
 *
 * The narrow, server-side way to learn a dentist's identity.
 *
 * WHY THIS EXISTS
 *   `profiles` used to be readable by any authenticated user in the clinic,
 *   patients included. That handed every portal patient the full staff roster —
 *   auth user ids, roles, `is_admin`, and the names of the clinic's other
 *   portal patients (migration 20260905090000 closes it; the header there has
 *   the detail). Patients now read only their own profiles row.
 *
 *   But some of what that policy was carrying is legitimate. A prescription has
 *   the prescribing dentist's name and signature on it — of course it does; a
 *   bill names who treated you; a treatment record says who performed it. Those
 *   documents belong to the patient and the dentist's name is part of them.
 *
 *   So the entitlement is not "read the profiles table"; it is "learn the name
 *   attached to a record you already hold". These helpers are that, and only
 *   that: service-role reads returning `full_name` and `signature_url` for
 *   dentist ids the caller has already derived from their OWN rows. Nothing
 *   here answers a clinic-wide "list the staff" question, and nothing here
 *   returns `role`, `is_admin` or `clinic_id`.
 *
 * WHY SERVICE ROLE AND NOT A LOOSER POLICY
 *   RLS is row-level. It cannot say "this caller sees these two columns", and
 *   column GRANTs apply per database role (`authenticated`) rather than per
 *   user, so they cannot separate a patient from a dentist either. A policy
 *   permissive enough to serve the legitimate case is necessarily permissive
 *   enough to serve the roster. Doing the projection here, in code, on ids the
 *   caller has already been authorised for, is the version that can express the
 *   distinction.
 *
 * CALLERS MUST HAVE AUTHORISED THE IDS ALREADY. Every current caller derives
 * them from rows RLS has already scoped to the caller — their own appointments,
 * their own treatments, their own bill — or from a clinic id resolved
 * server-side from the portal link. Do not pass an id straight from a request.
 */

import { createAdminClient } from "@/lib/supabase/admin";

/** Exactly what a patient-facing document needs, and nothing else. */
export type DentistIdentity = {
  id: string;
  full_name: string | null;
  signature_url: string | null;
};

// The @supabase/ssr client infers `never` for some table types under strict
// mode; the same escape hatch the action files use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

/**
 * Names (and signatures) for a set of dentist ids.
 *
 * Returns a Map so callers can look up per row without a second pass. Ids with
 * no matching profile are simply absent — a dentist whose account was removed
 * should not blank out the treatment they performed.
 */
export async function resolveDentistIdentities(
  dentistIds: readonly string[]
): Promise<Map<string, DentistIdentity>> {
  const ids = Array.from(new Set(dentistIds.filter(Boolean)));
  if (ids.length === 0) return new Map();

  const admin: AnyClient = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .select("id, full_name, signature_url")
    .in("id", ids);

  if (error) {
    // Non-fatal by design: a missing name degrades a document's presentation,
    // it does not make the document wrong. The caller renders without it.
    console.error("[resolveDentistIdentities]", error);
    return new Map();
  }

  return new Map(
    ((data ?? []) as DentistIdentity[]).map((row) => [row.id, row])
  );
}

/**
 * The id of a clinic's dentist, for the single-dentist MVP.
 *
 * Used when a booking made by a patient has to be assigned to somebody. The
 * clinic id MUST already have been resolved server-side (from the portal link),
 * never taken from the request — see section 10 of CLAUDE.md.
 */
export async function resolveClinicDentistId(
  clinicId: string
): Promise<string | null> {
  if (!clinicId) return null;

  const admin: AnyClient = createAdminClient();
  const { data } = await admin
    .from("profiles")
    .select("id")
    .eq("clinic_id", clinicId)
    .eq("role", "dentist")
    .limit(1)
    .maybeSingle();

  return (data as { id: string } | null)?.id ?? null;
}
