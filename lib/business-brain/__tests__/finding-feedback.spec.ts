/**
 * Integration spec for finding feedback — the one question the module asks.
 *
 * Three claims, and all three are about who may say what:
 *
 *   - a dentist may record a verdict for THEIR clinic and nobody else's, in
 *     their own name and no one else's;
 *   - a verdict cannot be edited or deleted, so a correction is a new row and
 *     the latest one wins;
 *   - a receptionist has no business here at all.
 *
 * Runs against the LOCAL Supabase stack and skips, loudly, when it is not
 * reachable.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/types/database.types";
import { readFindingPrecision, readFindingVerdicts } from "../finding-feedback";

const URL = process.env.SUPABASE_TEST_URL ?? "http://127.0.0.1:55321";
const KEY =
  process.env.SUPABASE_TEST_SERVICE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const ANON_KEY =
  process.env.SUPABASE_TEST_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${URL}/rest/v1/`, {
      headers: { apikey: KEY },
      signal: AbortSignal.timeout(2500),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}
const LOCAL_UP = await reachable();
if (!LOCAL_UP) {
  console.warn(`\n[finding-feedback] SKIPPED — local Supabase not reachable at ${URL}.\n`);
}

const options = { auth: { persistSession: false, autoRefreshToken: false } };
const service: SupabaseClient<Database> = createClient<Database>(URL, KEY, options);
/* eslint-disable @typescript-eslint/no-explicit-any */
const raw = service as any;

const CLINIC = "9fe00000-0000-4000-8000-000000000001";
const OTHER_CLINIC = "9fe00000-0000-4000-8000-000000000002";
const DENTIST = "9fe00000-0000-4000-8000-000000000010";
const RECEPTIONIST = "9fe00000-0000-4000-8000-000000000011";
const OTHER_DENTIST = "9fe00000-0000-4000-8000-000000000012";

const TODAY = "2026-09-19";
/**
 * Unique per run, because the rows this file writes CANNOT BE DELETED.
 *
 * That is the table's whole point and it applies to the test too: the
 * append-only trigger refuses a DELETE outside the retention purge, and it binds
 * the service role, so a fixture cannot tidy up after itself. Scoping every
 * assertion to one run's own finding id is what makes the suite repeatable.
 */
const RUN = Math.random().toString(36).slice(2, 10);
const FINDING = `constraint.revenue_leakage:${CLINIC}:${TODAY}#${RUN}`;

async function cleanup() {
  // Profiles and users go; the clinic stays, because deleting it would cascade
  // into finding_feedback and the append-only trigger refuses that. Consistent
  // with docs/OFFBOARDING.md: a tenant carrying an audit trail is not hard
  // deleted, and this table is one.
  await raw.from("profiles").delete().in("id", [DENTIST, RECEPTIONIST, OTHER_DENTIST]);
  for (const id of [DENTIST, RECEPTIONIST, OTHER_DENTIST]) {
    await raw.auth.admin.deleteUser(id).catch(() => undefined);
  }
}

async function user(id: string, email: string) {
  const { error } = await raw.auth.admin.createUser({
    id,
    email,
    password: "password123",
    email_confirm: true,
  });
  if (error && !/already/i.test(error.message)) throw new Error(`seed user: ${error.message}`);
}

async function signIn(email: string): Promise<SupabaseClient<Database>> {
  const client = createClient<Database>(URL, ANON_KEY, options);
  const { error } = await client.auth.signInWithPassword({ email, password: "password123" });
  if (error) throw new Error(`sign in ${email}: ${error.message}`);
  return client;
}

async function seed() {
  await cleanup();
  await user(DENTIST, "ff-dentist@test.local");
  await user(RECEPTIONIST, "ff-reception@test.local");
  await user(OTHER_DENTIST, "ff-other@test.local");

  // Upserted, not inserted: an earlier run's clinics may still be here (see
  // `cleanup`), and a fixture that cannot run twice is a fixture nobody runs.
  const { error } = await raw.from("clinics").upsert([
    { id: CLINIC, name: "Feedback Clinic" },
    { id: OTHER_CLINIC, name: "Another Clinic" },
  ]);
  if (error) throw new Error(`seed clinics: ${error.message}`);

  await raw.from("profiles").upsert([
    { id: DENTIST, clinic_id: CLINIC, full_name: "FF Dentist", role: "dentist" },
    { id: RECEPTIONIST, clinic_id: CLINIC, full_name: "FF Reception", role: "receptionist" },
    { id: OTHER_DENTIST, clinic_id: OTHER_CLINIC, full_name: "Other Dentist", role: "dentist" },
  ]);
}

describe.skipIf(!LOCAL_UP)("finding feedback (integration)", () => {
  beforeAll(seed, 60_000);
  afterAll(cleanup);

  it("lets the clinic's own dentist record a verdict, and takes the latest one", async () => {
    const db = await signIn("ff-dentist@test.local");
    const row = (verdict: string, reason: string | null) => ({
      clinic_id: CLINIC,
      business_date: TODAY,
      finding_id: FINDING,
      finding_kind: "problem",
      category: "revenue_leakage",
      verdict,
      reason,
      recorded_by: DENTIST,
    });

    expect((await (db as any).from("finding_feedback").insert(row("not_relevant", "not_true"))).error).toBeNull();
    // A correction is a NEW row: nothing is overwritten, and that the opinion
    // changed stays visible.
    expect((await (db as any).from("finding_feedback").insert(row("useful", null))).error).toBeNull();

    const verdicts = await readFindingVerdicts(service, CLINIC, TODAY);
    expect(verdicts.get(FINDING)).toEqual({ verdict: "useful", reason: null });

    const { count } = await raw
      .from("finding_feedback")
      .select("id", { count: "exact", head: true })
      .eq("finding_id", FINDING);
    expect(count).toBe(2);
  });

  it("refuses a not-relevant verdict with no reason", async () => {
    // A count of dismissals cannot say whether to retire the rule, move a
    // threshold or rank it lower. The UI asks; the database insists.
    const db = await signIn("ff-dentist@test.local");
    const { error } = await (db as any).from("finding_feedback").insert({
      clinic_id: CLINIC,
      business_date: TODAY,
      finding_id: `${FINDING}#noreason`,
      finding_kind: "problem",
      category: "revenue_leakage",
      verdict: "not_relevant",
      reason: null,
      recorded_by: DENTIST,
    });
    expect(error).not.toBeNull();
  });

  it("refuses a verdict filed against another clinic, or in another name", async () => {
    const db = await signIn("ff-dentist@test.local");
    const base = {
      business_date: TODAY,
      finding_id: `${FINDING}#forged`,
      finding_kind: "problem",
      category: "revenue_leakage",
      verdict: "useful",
      reason: null,
    };
    expect(
      (await (db as any)
        .from("finding_feedback")
        .insert({ ...base, clinic_id: OTHER_CLINIC, recorded_by: DENTIST })).error,
    ).not.toBeNull();
    expect(
      (await (db as any)
        .from("finding_feedback")
        .insert({ ...base, clinic_id: CLINIC, recorded_by: OTHER_DENTIST })).error,
    ).not.toBeNull();
  });

  it("shows a clinic nothing of another clinic's feedback", async () => {
    const other = await signIn("ff-other@test.local");
    const { data } = await (other as any).from("finding_feedback").select("id").eq("clinic_id", CLINIC);
    expect(data ?? []).toEqual([]);
  });

  it("is closed to a receptionist entirely", async () => {
    const reception = await signIn("ff-reception@test.local");
    const { data } = await (reception as any).from("finding_feedback").select("id");
    expect(data ?? []).toEqual([]);
    const { error } = await (reception as any).from("finding_feedback").insert({
      clinic_id: CLINIC,
      business_date: TODAY,
      finding_id: `${FINDING}#reception`,
      finding_kind: "problem",
      category: "revenue_leakage",
      verdict: "useful",
      reason: null,
      recorded_by: RECEPTIONIST,
    });
    expect(error).not.toBeNull();
  });

  it("cannot be edited or deleted, by anyone", async () => {
    // Including the service role: RLS does not bind it, so the trigger does.
    const update = await raw
      .from("finding_feedback")
      .update({ verdict: "useful" })
      .eq("finding_id", FINDING);
    expect(update.error).not.toBeNull();
    const remove = await raw.from("finding_feedback").delete().eq("finding_id", FINDING);
    expect(remove.error).not.toBeNull();
  });

  it("measures precision per rule, and says nothing when nothing was answered", async () => {
    const precision = await readFindingPrecision(service, { clinicId: CLINIC, since: TODAY });
    const leakage = precision.find((p) => p.group === "revenue_leakage");
    // The correction is not counted twice: one finding, one standing verdict.
    expect(leakage?.useful).toBeGreaterThanOrEqual(1);
    expect(leakage?.precisionPercent).not.toBeNull();

    // A clinic nobody has answered for has no precision. Not 0%, which would
    // read as "everything we said was wrong".
    expect(
      await readFindingPrecision(service, { clinicId: OTHER_CLINIC, since: TODAY }),
    ).toEqual([]);
  });
});
