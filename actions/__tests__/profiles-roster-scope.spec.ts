/**
 * actions/__tests__/profiles-roster-scope.spec.ts
 *
 * Regression guard for 20260905090000_profiles_patient_roster_scope.sql.
 *
 * THE DEFECT THIS LOCKS SHUT
 *   `profiles: read own clinic members` was `using (clinic_id =
 *   auth_clinic_id())` with no role predicate. It was written when only staff
 *   had a profiles row; portal patients later got one too, and the policy
 *   quietly started handing every activated patient the whole clinic:
 *
 *     - each staff member's auth.users id, role, and `is_admin` — the flag that
 *       names which account gates /admin;
 *     - `signature_url`, the object path of a dentist's stored signature;
 *     - every OTHER portal patient in the clinic, by name.
 *
 *   The second half is the one that is easy to walk past. Attending a dental
 *   practice is health information, and a patient learning who else attends
 *   theirs is a disclosure with no product purpose at all.
 *
 * WHY THESE ASSERTIONS ARE SHAPED THIS WAY
 *   Every case runs as a REAL session against a REAL database, because the bug
 *   was in a policy and a policy is only observable by executing it. Asserting
 *   on the returned ROWS rather than on the catalog is deliberate for the same
 *   reason `view-security-invoker.spec.ts` does it: the question is what a
 *   caller can retrieve, not what the definition says it should be.
 *
 *   The patient cases assert the row COUNT, not merely that `is_admin` is
 *   absent from some projection. A column-absence test passes trivially against
 *   a `select=full_name`, and would have passed against the broken policy.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_TEST_URL ?? "http://127.0.0.1:55321";
const ANON =
  process.env.SUPABASE_TEST_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const SERVICE =
  process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

/** Dr. Liying's Dental Care — the seeded clinic all three accounts belong to. */
const PATIENT = "patient@dentgrow.test";
const DENTIST = "dentist@dentgrow.test";
const RECEPTIONIST = "receptionist@dentgrow.test";
/** My Dental Clinic — a different tenant entirely. */
const OTHER_CLINIC_DENTIST = "brain@dentgrow.test";

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${URL}/rest/v1/`, { headers: { apikey: ANON } });
    return res.ok || res.status === 404 || res.status === 400;
  } catch {
    return false;
  }
}
const LOCAL_UP = await reachable();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const service = createClient(URL, SERVICE, {
  auth: { persistSession: false, autoRefreshToken: false },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

async function tokenFor(email: string): Promise<string> {
  const res = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const body = await res.json();
  if (!body.access_token) throw new Error(`sign-in failed for ${email}`);
  return body.access_token as string;
}

type ProfileRow = {
  id: string;
  full_name: string | null;
  role: string;
  clinic_id: string;
  is_admin: boolean | null;
};

/**
 * Every profiles row the given session can retrieve.
 *
 * `select=*` on purpose: the point is what the caller can get when they ask for
 * everything, which is what an attacker asks for. A 401/403 counts as zero
 * rows — an error is a stronger refusal than an empty result, not a weaker one.
 */
async function profilesVisibleTo(token: string, query = "*"): Promise<ProfileRow[]> {
  const res = await fetch(`${URL}/rest/v1/profiles?select=${query}`, {
    headers: { apikey: ANON, Authorization: `Bearer ${token}` },
  });
  if (res.status === 401 || res.status === 403) return [];
  if (!res.ok) throw new Error(`profiles read failed: HTTP ${res.status}`);
  return (await res.json()) as ProfileRow[];
}

describe.skipIf(!LOCAL_UP)("profiles: a patient sees only themselves", () => {
  let patientToken = "";
  let patientUserId = "";
  /** Everyone in the seeded clinic, read past RLS, as the ground truth. */
  let clinicRoster: ProfileRow[] = [];
  /**
   * A SECOND portal patient in the same clinic, created here.
   *
   * The seed carries exactly one, so without this the patient-to-patient case
   * passes against the broken policy too — there is simply nobody else to
   * disclose. Verified by restoring the old policy and watching that one test
   * stay green while five others went red. A fixture that cannot fail is not a
   * test, so the neighbour is built rather than assumed.
   */
  let neighbourUserId = "";

  beforeAll(async () => {
    patientToken = await tokenFor(PATIENT);

    const { data: users } = await service.auth.admin.listUsers();
    const user = (users?.users ?? []).find(
      (u: { email?: string }) => u.email === PATIENT
    );
    if (!user) throw new Error("seeded portal patient not found");
    patientUserId = user.id;

    const { data: self } = await service
      .from("profiles")
      .select("clinic_id")
      .eq("id", patientUserId)
      .single();

    const { data: created, error: createErr } = await service.auth.admin.createUser({
      email: `roster-neighbour-${Date.now()}@dentgrow.test`,
      password: "password123",
      email_confirm: true,
    });
    if (createErr) throw createErr;
    neighbourUserId = created.user.id;

    await service.from("profiles").upsert({
      id: neighbourUserId,
      clinic_id: self.clinic_id,
      full_name: "Roster Neighbour",
      role: "patient",
    });

    const { data: roster } = await service
      .from("profiles")
      .select("id, full_name, role, clinic_id, is_admin")
      .eq("clinic_id", self.clinic_id);
    clinicRoster = roster as ProfileRow[];
  });

  afterAll(async () => {
    if (!LOCAL_UP || !neighbourUserId) return;
    // profiles cascades from auth.users, so this clears both.
    await service.auth.admin.deleteUser(neighbourUserId);
  });

  it("the seeded clinic really does have staff to leak — otherwise this suite proves nothing", () => {
    // Guards against the whole file passing because the fixture is empty. If a
    // future seed drops the receptionist, these tests must fail loudly rather
    // than quietly assert that nothing was disclosed from nothing.
    expect(clinicRoster.length).toBeGreaterThan(1);
    expect(clinicRoster.some((r) => r.role === "dentist")).toBe(true);
    expect(clinicRoster.some((r) => r.role === "receptionist")).toBe(true);
    // And a second patient, so the enumeration case below has someone to find.
    expect(
      clinicRoster.filter((r) => r.role === "patient").length
    ).toBeGreaterThan(1);
  });

  it("returns exactly one row, and it is the patient's own", async () => {
    const rows = await profilesVisibleTo(patientToken);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(patientUserId);
  });

  it("no staff row of any kind comes back", async () => {
    const rows = await profilesVisibleTo(patientToken);
    expect(rows.filter((r) => r.role === "dentist")).toHaveLength(0);
    expect(rows.filter((r) => r.role === "receptionist")).toHaveLength(0);
  });

  it("cannot retrieve is_admin for anyone but themselves", async () => {
    // The flag naming the platform-admin account. Asking for it directly, the
    // way someone looking for it would.
    const rows = await profilesVisibleTo(patientToken, "id,is_admin");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(patientUserId);
  });

  it("cannot retrieve another profile by filtering for it", async () => {
    // A row limit is not the control; the policy is. Name a staff id outright.
    const staff = clinicRoster.find((r) => r.role === "dentist");
    const res = await fetch(
      `${URL}/rest/v1/profiles?select=*&id=eq.${staff!.id}`,
      { headers: { apikey: ANON, Authorization: `Bearer ${patientToken}` } }
    );
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual([]);
  });

  it("cannot enumerate other patients of the same clinic", async () => {
    // The half that is easy to miss. Attending a dental practice is health
    // information; who else attends is not this patient's to read.
    const rows = await profilesVisibleTo(patientToken, "id,role");
    const otherPatients = rows.filter(
      (r) => r.role === "patient" && r.id !== patientUserId
    );
    expect(otherPatients).toHaveLength(0);
  });

  it("cannot read a signature_url belonging to a dentist", async () => {
    const rows = await profilesVisibleTo(patientToken, "id,signature_url");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(patientUserId);
  });
});

describe.skipIf(!LOCAL_UP)("profiles: staff access is unchanged", () => {
  it("a dentist still reads every member of their own clinic", async () => {
    const token = await tokenFor(DENTIST);
    const rows = await profilesVisibleTo(token);

    // The dentist dropdowns depend on this, which is why the original policy
    // existed at all. Narrowing the patient case must not narrow this one.
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.some((r) => r.role === "dentist")).toBe(true);
    expect(rows.some((r) => r.role === "receptionist")).toBe(true);

    const clinics = new Set(rows.map((r) => r.clinic_id));
    expect(clinics.size).toBe(1);
  });

  it("a receptionist still reads every member of their own clinic", async () => {
    const token = await tokenFor(RECEPTIONIST);
    const rows = await profilesVisibleTo(token);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.some((r) => r.role === "dentist")).toBe(true);
  });

  it("staff still read their own row", async () => {
    // Served by the other policy now. resolveSession() depends on it, so if
    // this breaks nothing in the app can resolve a session at all.
    const token = await tokenFor(DENTIST);
    const rows = await profilesVisibleTo(token, "id,full_name,role");
    const { data: users } = await service.auth.admin.listUsers();
    const self = (users?.users ?? []).find(
      (u: { email?: string }) => u.email === DENTIST
    );
    expect(rows.some((r) => r.id === self.id)).toBe(true);
  });
});

describe.skipIf(!LOCAL_UP)("profiles: tenant isolation is unchanged", () => {
  it("a dentist reads nothing belonging to another clinic", async () => {
    const [mine, theirs] = await Promise.all([
      tokenFor(DENTIST).then((t) => profilesVisibleTo(t)),
      tokenFor(OTHER_CLINIC_DENTIST).then((t) => profilesVisibleTo(t)),
    ]);

    const myClinic = mine[0].clinic_id;
    const theirClinic = theirs[0].clinic_id;
    expect(myClinic).not.toBe(theirClinic);

    // Neither side's rows appear on the other's.
    expect(mine.every((r) => r.clinic_id === myClinic)).toBe(true);
    expect(theirs.every((r) => r.clinic_id === theirClinic)).toBe(true);

    const theirIds = new Set(theirs.map((r) => r.id));
    expect(mine.some((r) => theirIds.has(r.id))).toBe(false);
  });

  it("an unauthenticated caller reads no profile at all", async () => {
    const res = await fetch(`${URL}/rest/v1/profiles?select=*`, {
      headers: { apikey: ANON },
    });
    const rows = res.ok ? await res.json() : [];
    expect(rows).toEqual([]);
  });
});
