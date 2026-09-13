/**
 * Integration specs for action completion persistence and verification.
 *
 * These run against the LOCAL Supabase stack (`npm run db:start`) and skip,
 * loudly, when it is not reachable — so `npm test` still passes for someone
 * without Docker while a skipped suite stays visible in the report.
 *
 * Real Postgres rather than a mock, because everything worth checking here is a
 * property a mock cannot have:
 *
 *   - the append-only trigger, which binds the service role and therefore cannot
 *     be observed through any client that RLS already constrains;
 *   - the RLS policies, including that a second clinic's dentist sees nothing;
 *   - the check constraints on `source`, the note and the metric pair;
 *   - and entity verification, whose whole correctness is in the clinic
 *     predicates and the soft-delete filter on real rows.
 *
 * Isolation: every run generates its own clinic and patients (users are fixed
 * and reused — see the note on their ids), so the
 * suite is re-runnable and never touches the seeded clinic. It does NOT clean up
 * after itself completely, and cannot — the completions are append-only by
 * design. See cleanupWorkTables.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/types/database.types";
import { buildMetric, MetricKey } from "@/business-brain/engines/metrics/metric-ids";
import { OutcomeAttribution } from "@/business-brain";
import {
  loadActionOutcomes,
  readActionCompletions,
  verifyCompletions,
} from "../action-outcomes";

const URL = process.env.SUPABASE_TEST_URL ?? "http://127.0.0.1:55321";
const KEY =
  process.env.SUPABASE_TEST_SERVICE_KEY ??
  // Standard local-development service key — published in Supabase's own docs,
  // identical on every local stack, and worthless against any hosted project.
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
  console.warn(
    `\n[action-completions] SKIPPED — local Supabase not reachable at ${URL}.` +
      `\n                     Start it with: npm run db:start\n`,
  );
}

// ── Fixture identifiers ──────────────────────────────────────────────────────
//
// Generated fresh for every run, which is a consequence of the table being
// append-only: completions cannot be deleted, so a fixed clinic id would
// accumulate rows across runs until they overflowed the reader's row limit and
// tests began failing for reasons unrelated to the code. A new clinic per run
// keeps each execution isolated from every previous one. The leftovers live only
// in the local development database and go away with `npm run db:reset`.
const CLINIC = crypto.randomUUID();
const OTHER_CLINIC = crypto.randomUUID();
/**
 * Auth users are FIXED per spec and reused across runs, not created per run.
 *
 * Each run's clinic is new (the append-only audit tables refuse a clinic delete),
 * and a dentist whose profile those rows reference cannot be deleted either — so
 * per-run users could never be cleaned up, and they accumulated until specs that
 * look users up on the first page of `auth.admin.listUsers()` stopped finding
 * theirs. A fixed user's profile is simply upserted onto the new clinic.
 */
const DENTIST = "ac000000-0000-4000-8000-0000000000d1";
const OTHER_DENTIST = "ac000000-0000-4000-8000-0000000000d2";
const RECEPTIONIST = "ac000000-0000-4000-8000-0000000000e1";

const P1 = crypto.randomUUID();
const P2 = crypto.randomUUID();
const P3 = crypto.randomUUID();
/** Soft-deleted since the action was completed. */
const P_GONE = crypto.randomUUID();
/** Belongs to the OTHER clinic. Must never resolve or confirm. */
const P_FOREIGN = crypto.randomUUID();

const DENTIST_EMAIL = "ac-dentist@test.local";
const OTHER_DENTIST_EMAIL = "ac-other@test.local";
const RECEPTIONIST_EMAIL = "ac-recept@test.local";

const DATE = "2026-09-12";
const COMPLETED_AT = "2026-09-12T09:00:00.000Z";
const NOW = "2026-09-12T15:00:00.000Z";

const db: SupabaseClient<Database> = createClient<Database>(URL, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/* eslint-disable @typescript-eslint/no-explicit-any */
const raw = db as any;

async function insert(table: string, values: unknown) {
  const { error } = await raw.from(table).insert(values);
  if (error) throw new Error(`seed ${table}: ${error.message}`);
}

async function upsert(table: string, values: unknown) {
  const { error } = await raw.from(table).upsert(values);
  if (error) throw new Error(`seed ${table}: ${error.message}`);
}

/**
 * Clear the tables this suite CAN clear.
 *
 * `action_completions` is deliberately absent, and so is `clinics`. Both are
 * refused by the append-only trigger — a clinic delete cascades into the
 * completions and the cascade fires the same trigger. That is the intended
 * behaviour and it predates this table: `phi_access_log` carries the identical
 * FK and trigger, and docs/OFFBOARDING.md argues at length that a clinic with
 * audit records should not be deletable.
 *
 * So the suite is written to tolerate rows accumulating: fixtures are upserted
 * rather than inserted, and every assertion is scoped to the specific completion
 * ids the test created rather than to a table-wide count.
 */
async function cleanupWorkTables() {
  for (const table of ["follow_ups", "payments", "appointments"]) {
    await raw.from(table).delete().in("clinic_id", [CLINIC, OTHER_CLINIC]);
  }
}

async function seed() {
  for (const [id, email] of [
    [DENTIST, DENTIST_EMAIL],
    [OTHER_DENTIST, OTHER_DENTIST_EMAIL],
    [RECEPTIONIST, RECEPTIONIST_EMAIL],
  ] as const) {
    const { error } = await raw.auth.admin.createUser({
      id,
      email,
      password: "password123",
      email_confirm: true,
    });
    if (error && !/already/i.test(error.message)) {
      throw new Error(`seed auth user: ${error.message}`);
    }
  }

  await upsert("clinics", [
    { id: CLINIC, name: "AC Test Clinic" },
    { id: OTHER_CLINIC, name: "AC Other Clinic" },
  ]);
  await upsert("clinic_settings", [
    { clinic_id: CLINIC, clinic_name: "AC Test Clinic", average_appointment_duration: 30 },
    { clinic_id: OTHER_CLINIC, clinic_name: "AC Other Clinic", average_appointment_duration: 30 },
  ]);
  await upsert("profiles", [
    { id: DENTIST, clinic_id: CLINIC, full_name: "AC Dentist", role: "dentist" },
    { id: OTHER_DENTIST, clinic_id: OTHER_CLINIC, full_name: "Other Dentist", role: "dentist" },
    { id: RECEPTIONIST, clinic_id: CLINIC, full_name: "AC Receptionist", role: "receptionist" },
  ]);

  await upsert("patients", [
    { id: P1, clinic_id: CLINIC, name: "Alpha" },
    { id: P2, clinic_id: CLINIC, name: "Beta" },
    { id: P3, clinic_id: CLINIC, name: "Gamma" },
    // Deleted AFTER the completion: excluded from today's denominator, while the
    // record of having been targeted survives on the row.
    { id: P_GONE, clinic_id: CLINIC, name: "Gone", deleted_at: "2026-09-12T12:00:00.000Z" },
    { id: P_FOREIGN, clinic_id: OTHER_CLINIC, name: "Foreign" },
  ]);

  await cleanupWorkTables();
}

/** Insert one completion as the service role and return its id. */
async function completion(over: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await raw
    .from("action_completions")
    .insert({
      clinic_id: CLINIC,
      category: "retention",
      constraint_id: `constraint.retention:${CLINIC}:${DATE}`,
      completed_at: COMPLETED_AT,
      completed_by: DENTIST,
      source: "declared",
      target_patient_ids: [P1, P2, P3],
      metric_key: MetricKey.FOLLOWUPS_OVERDUE,
      metric_value: 12,
      ...over,
    })
    .select("id")
    .single();
  if (error) throw new Error(`completion: ${error.message}`);
  return (data as { id: string }).id;
}

/** A signed-in client for one of the seeded users, subject to RLS. */
async function clientFor(email: string): Promise<SupabaseClient<Database>> {
  const client = createClient<Database>(URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password: "password123" });
  if (error) throw new Error(`sign in ${email}: ${error.message}`);
  return client;
}

function metrics(values: Partial<Record<string, number>>) {
  return Object.entries(values).map(([key, value]) =>
    buildMetric(key as MetricKey, value as number, CLINIC, DATE, `${DATE}T15:00:00.000Z`),
  );
}

beforeAll(async () => {
  if (LOCAL_UP) await seed();
}, 60_000);

afterAll(async () => {
  if (!LOCAL_UP) return;
  // Only what can actually be removed. The completions and their clinics are
  // append-only and stay behind by design; see cleanupWorkTables. Auth users are
  // fixed and reused rather than deleted; see the note on their ids.
  await cleanupWorkTables();
}, 60_000);

// ── Persistence ──────────────────────────────────────────────────────────────

describe.skipIf(!LOCAL_UP)("action completion persistence", () => {
  it("stores a completion and reads it back", async () => {
    const id = await completion({ note: "called everyone" });

    const records = await readActionCompletions(db, CLINIC, NOW);
    const mine = records.find((r) => r.id === id);
    expect(mine).toBeDefined();
    expect(mine).toMatchObject({
      id,
      category: "retention",
      source: "declared",
      targetPatientIds: [P1, P2, P3],
      metricKey: MetricKey.FOLLOWUPS_OVERDUE,
      metricValueAtCompletion: 12,
    });
  });

  it("records who completed it", async () => {
    const id = await completion();
    const { data } = await raw
      .from("action_completions")
      .select("completed_by")
      .eq("id", id)
      .single();
    expect(data.completed_by).toBe(DENTIST);
  });

  it("keeps declared and inferred apart", async () => {
    const declaredId = await completion({ source: "declared" });
    // An inferred completion has no human author, and recording one would be a
    // small lie about provenance - hence the null actor.
    const inferredId = await completion({ source: "inferred", completed_by: null });

    const records = await readActionCompletions(db, CLINIC, NOW);
    expect(records.find((r) => r.id === declaredId)?.source).toBe("declared");
    expect(records.find((r) => r.id === inferredId)?.source).toBe("inferred");
  });

  it("rejects a source that is neither", async () => {
    // The two carry different evidential weight; a third value would be a claim
    // nothing downstream knows how to read.
    const { error } = await raw.from("action_completions").insert({
      clinic_id: CLINIC,
      category: "retention",
      constraint_id: "c",
      source: "guessed",
    });
    expect(error?.message ?? "").toMatch(/chk_action_completions_source|violates check/i);
  });

  it("rejects an empty note but allows none at all", async () => {
    const { error: blank } = await raw.from("action_completions").insert({
      clinic_id: CLINIC,
      category: "retention",
      constraint_id: "c",
      source: "declared",
      note: "   ",
    });
    expect(blank?.message ?? "").toMatch(/chk_action_completions_note|violates check/i);

    await expect(completion({ note: null })).resolves.toBeTruthy();
  });

  it("rejects half a metric reading", async () => {
    // "Fell from X to Y" needs both halves; one alone cannot support the sentence
    // it exists for.
    const { error } = await raw.from("action_completions").insert({
      clinic_id: CLINIC,
      category: "retention",
      constraint_id: "c",
      source: "declared",
      metric_key: MetricKey.FOLLOWUPS_OVERDUE,
      metric_value: null,
    });
    expect(error?.message ?? "").toMatch(/chk_action_completions_metric_pair|violates check/i);
  });

  it("ignores completions older than the lookback window", async () => {
    const oldId = await completion({ completed_at: "2026-06-01T09:00:00.000Z" });
    const recentId = await completion({ completed_at: COMPLETED_AT });

    const ids = (await readActionCompletions(db, CLINIC, NOW)).map((r) => r.id);
    expect(ids).toContain(recentId);
    expect(ids).not.toContain(oldId);
  });
});

// ── Append-only ──────────────────────────────────────────────────────────────

describe.skipIf(!LOCAL_UP)("append-only", () => {
  it("refuses an update, even as the service role", async () => {
    // RLS cannot constrain the service role — BYPASSRLS — so the trigger is the
    // only thing standing between the record and a silent rewrite. A completion
    // the application can edit is not evidence.
    const id = await completion({ note: "original" });

    const { error } = await raw
      .from("action_completions")
      .update({ note: "rewritten" })
      .eq("id", id);
    expect(error?.message ?? "").toMatch(/append-only/i);

    // And the row is unchanged, which is the property that actually matters.
    const { data } = await raw.from("action_completions").select("note").eq("id", id).single();
    expect(data.note).toBe("original");
  });

  it("refuses a delete outside a declared retention purge", async () => {
    const id = await completion();

    const { error } = await raw.from("action_completions").delete().eq("id", id);
    expect(error?.message ?? "").toMatch(/retention purge/i);

    // And the row is still there — the delete was refused, not silently ignored.
    const { data } = await raw.from("action_completions").select("id").eq("id", id);
    expect(data).toHaveLength(1);
  });
});

// ── RLS and tenant isolation ─────────────────────────────────────────────────

describe.skipIf(!LOCAL_UP)("row level security", () => {
  it("lets this clinic's dentist read their own completions, and only those", async () => {
    const id = await completion();

    const client = await clientFor(DENTIST_EMAIL);
    const { data } = await (client as any)
      .from("action_completions")
      .select("id, clinic_id");
    expect(data.map((r: { id: string }) => r.id)).toContain(id);
    // Every visible row belongs to this dentist's own clinic. The count is not
    // the assertion - the scoping is.
    expect(data.every((r: { clinic_id: string }) => r.clinic_id === CLINIC)).toBe(true);
  });

  it("never shows another clinic's dentist this clinic's completions", async () => {
    // The isolation that matters. Asserted as "cannot see MINE" rather than
    // "sees nothing", because the other clinic legitimately has completions of
    // its own elsewhere in this suite — and a zero-count assertion would pass or
    // fail depending on test order rather than on the policy.
    //
    // Note it is not an error either: RLS withholds rows silently, which is what
    // any caller must be able to rely on.
    const id = await completion();

    const client = await clientFor(OTHER_DENTIST_EMAIL);
    const { data, error } = await (client as any)
      .from("action_completions")
      .select("id, clinic_id");
    expect(error).toBeNull();
    expect(data.map((r: { id: string }) => r.id)).not.toContain(id);
    expect(data.every((r: { clinic_id: string }) => r.clinic_id === OTHER_CLINIC)).toBe(true);
  });

  it("shows a receptionist nothing — the briefing is a dentist surface", async () => {
    // Scoped by role as well as tenant. A policy scoped only by clinic is a
    // policy that will be wrong the day another role joins the clinic.
    const client = await clientFor(RECEPTIONIST_EMAIL);
    const { data } = await (client as any).from("action_completions").select("id");
    expect(data).toHaveLength(0);
  });

  it("refuses a completion written against another clinic", async () => {
    // WITH CHECK pins clinic_id to the actor's own clinic, so a crafted request
    // body cannot plant a row in someone else's tenant.
    const client = await clientFor(DENTIST_EMAIL);
    const { error } = await (client as any).from("action_completions").insert({
      clinic_id: OTHER_CLINIC,
      category: "retention",
      constraint_id: "c",
      source: "declared",
    });
    expect(error).not.toBeNull();
  });

  it("gives a client no way to change or erase a completion", async () => {
    const id = await completion({ note: "as recorded" });
    const client = await clientFor(DENTIST_EMAIL);

    await (client as any).from("action_completions").update({ note: "nope" }).eq("id", id);
    await (client as any).from("action_completions").delete().eq("id", id);

    // Asserted on the OUTCOME rather than on an error object: a missing policy
    // denies by matching no rows, which can surface as success with nothing
    // changed. What has to be true is that the record still says what it said,
    // and still exists.
    const { data } = await raw
      .from("action_completions")
      .select("note")
      .eq("id", id)
      .maybeSingle();
    expect(data?.note).toBe("as recorded");
  });
});

// ── Entity verification ──────────────────────────────────────────────────────

describe.skipIf(!LOCAL_UP)("verified completion", () => {
  it("counts targets whose follow-up completed after the action", async () => {
    await cleanupWorkTables();
    const id = await completion();

    await insert("follow_ups", [
      // Two of the three targets: completed since.
      { clinic_id: CLINIC, patient_id: P1, due_date: DATE, status: "completed", updated_at: "2026-09-12T11:00:00.000Z" },
      { clinic_id: CLINIC, patient_id: P2, due_date: DATE, status: "completed", updated_at: "2026-09-12T12:00:00.000Z" },
      // Third target still pending.
      { clinic_id: CLINIC, patient_id: P3, due_date: DATE, status: "pending", updated_at: "2026-09-12T11:00:00.000Z" },
    ]);

    const records = await readActionCompletions(db, CLINIC, NOW);
    const verified = await verifyCompletions(db, CLINIC, records);
    expect(verified.get(id)).toMatchObject({
      targeted: 3,
      resolvable: 3,
      confirmed: 2,
      verifiable: true,
    });
  });

  it("ignores work recorded BEFORE the action was completed", async () => {
    // The `since` bound is what makes this evidence rather than coincidence: a
    // follow-up closed last week does not confirm work reported this morning.
    await cleanupWorkTables();
    const id = await completion();
    await insert("follow_ups", [
      { clinic_id: CLINIC, patient_id: P1, due_date: DATE, status: "completed", updated_at: "2026-09-01T10:00:00.000Z" },
    ]);

    const records = await readActionCompletions(db, CLINIC, NOW);
    const verified = await verifyCompletions(db, CLINIC, records);
    expect(verified.get(id)?.confirmed).toBe(0);
  });

  it("excludes a patient deleted since, without rewriting the record", async () => {
    // The audit fact keeps every id it targeted; today's denominator does not.
    await cleanupWorkTables();
    const id = await completion({ target_patient_ids: [P1, P2, P_GONE] });
    await insert("follow_ups", [
      { clinic_id: CLINIC, patient_id: P1, due_date: DATE, status: "completed", updated_at: "2026-09-12T11:00:00.000Z" },
    ]);

    const records = await readActionCompletions(db, CLINIC, NOW);
    // The row still remembers all three.
    expect(records[0]?.targetPatientIds).toHaveLength(3);

    const verified = await verifyCompletions(db, CLINIC, records);
    expect(verified.get(id)).toMatchObject({ targeted: 3, resolvable: 2, confirmed: 1 });
  });

  it("never resolves or confirms a patient from another clinic", async () => {
    // The cross-tenant case. Even with a foreign id planted on the row, the
    // clinic predicate means it resolves to nothing and confirms nothing.
    await cleanupWorkTables();
    const id = await completion({ target_patient_ids: [P1, P_FOREIGN] });
    await insert("follow_ups", [
      { clinic_id: OTHER_CLINIC, patient_id: P_FOREIGN, due_date: DATE, status: "completed", updated_at: "2026-09-12T11:00:00.000Z" },
    ]);

    const records = await readActionCompletions(db, CLINIC, NOW);
    const verified = await verifyCompletions(db, CLINIC, records);
    expect(verified.get(id)).toMatchObject({ targeted: 2, resolvable: 1, confirmed: 0 });
  });

  it("confirms a recorded payment for a revenue action", async () => {
    await cleanupWorkTables();
    const id = await completion({
      category: "revenue_leakage",
      constraint_id: `constraint.revenue_leakage:${CLINIC}:${DATE}`,
      metric_key: MetricKey.REVENUE_OUTSTANDING,
      metric_value: 40000,
    });
    await insert("payments", [
      { clinic_id: CLINIC, patient_id: P1, amount: 2500, method: "cash", created_at: "2026-09-12T11:00:00.000Z" },
      { clinic_id: CLINIC, patient_id: P2, amount: 1500, method: "upi", created_at: "2026-09-12T11:30:00.000Z" },
    ]);

    const records = await readActionCompletions(db, CLINIC, NOW);
    const verified = await verifyCompletions(db, CLINIC, records);
    expect(verified.get(id)).toMatchObject({ resolvable: 3, confirmed: 2 });
  });

  it("counts a patient once however many payments they made", async () => {
    // Distinct patients, never rows — two payments from one patient must not
    // report 4 of 3 confirmed.
    await cleanupWorkTables();
    const id = await completion({ category: "revenue_leakage", metric_key: MetricKey.REVENUE_OUTSTANDING, metric_value: 40000 });
    await insert("payments", [
      { clinic_id: CLINIC, patient_id: P1, amount: 100, method: "cash", created_at: "2026-09-12T11:00:00.000Z" },
      { clinic_id: CLINIC, patient_id: P1, amount: 200, method: "cash", created_at: "2026-09-12T11:10:00.000Z" },
    ]);

    const records = await readActionCompletions(db, CLINIC, NOW);
    const verified = await verifyCompletions(db, CLINIC, records);
    expect(verified.get(id)?.confirmed).toBe(1);
  });

  it("does not count an appointment that was cancelled again", async () => {
    await cleanupWorkTables();
    const id = await completion({
      category: "treatment_acceptance",
      metric_key: MetricKey.TREATMENT_ACCEPTED_PENDING_SCHEDULING,
      metric_value: 9,
    });
    await insert("appointments", [
      { clinic_id: CLINIC, patient_id: P1, dentist_id: DENTIST, scheduled_at: "2026-09-20T09:00:00.000Z", source: "phone_call", status: "scheduled", created_at: "2026-09-12T11:00:00.000Z" },
      { clinic_id: CLINIC, patient_id: P2, dentist_id: DENTIST, scheduled_at: "2026-09-21T09:00:00.000Z", source: "phone_call", status: "cancelled", created_at: "2026-09-12T11:00:00.000Z" },
    ]);

    const records = await readActionCompletions(db, CLINIC, NOW);
    const verified = await verifyCompletions(db, CLINIC, records);
    expect(verified.get(id)?.confirmed).toBe(1);
  });

  it("reports an unverifiable category as unverifiable, never as zero", async () => {
    // "0 of 3 confirmed" and "this cannot be checked" read the same and mean
    // opposite things.
    await cleanupWorkTables();
    const id = await completion({
      category: "capacity",
      constraint_id: `constraint.capacity:${CLINIC}:${DATE}`,
      metric_key: null,
      metric_value: null,
    });

    const records = await readActionCompletions(db, CLINIC, NOW);
    const verified = await verifyCompletions(db, CLINIC, records);
    expect(verified.get(id)).toMatchObject({ verifiable: false, confirmed: 0 });
  });

  it("reports a completion with no targets as verifiable with nothing to confirm", async () => {
    await cleanupWorkTables();
    const id = await completion({ target_patient_ids: [] });
    const records = await readActionCompletions(db, CLINIC, NOW);
    const verified = await verifyCompletions(db, CLINIC, records);
    expect(verified.get(id)).toMatchObject({ targeted: 0, resolvable: 0, confirmed: 0, verifiable: true });
  });
});

// ── End to end ───────────────────────────────────────────────────────────────

describe.skipIf(!LOCAL_UP)("loadActionOutcomes", () => {
  it("reaches observed_after when the metric moved, carrying the entity facts", async () => {
    await cleanupWorkTables();
    const id = await completion();
    await insert("follow_ups", [
      { clinic_id: CLINIC, patient_id: P1, due_date: DATE, status: "completed", updated_at: "2026-09-12T11:00:00.000Z" },
      { clinic_id: CLINIC, patient_id: P2, due_date: DATE, status: "completed", updated_at: "2026-09-12T11:00:00.000Z" },
    ]);

    const outcomes = await loadActionOutcomes(
      db,
      CLINIC,
      metrics({ [MetricKey.FOLLOWUPS_OVERDUE]: 3 }),
      NOW,
    );

    const mine = outcomes.find((o) => o.completionId === id);
    expect(mine).toBeDefined();
    expect(mine).toMatchObject({
      attribution: OutcomeAttribution.OBSERVED_AFTER,
      metric: { before: 12, after: 3, improved: true },
      targets: { targeted: 3, resolvable: 3, confirmed: 2 },
    });
  });

  it("stays at insufficient_evidence when the metric cannot be read now", async () => {
    const id = await completion();

    const outcomes = await loadActionOutcomes(db, CLINIC, metrics({}), NOW);
    expect(outcomes.find((o) => o.completionId === id)?.attribution).toBe(
      OutcomeAttribution.INSUFFICIENT_EVIDENCE,
    );
  });

  it("never returns one clinic's completions to another", async () => {
    const mineId = await completion();
    const theirsId = await completion({
      clinic_id: OTHER_CLINIC,
      completed_by: OTHER_DENTIST,
      constraint_id: `constraint.retention:${OTHER_CLINIC}:${DATE}`,
      target_patient_ids: [P_FOREIGN],
    });

    const mine = await loadActionOutcomes(db, CLINIC, metrics({}), NOW);
    const theirs = await loadActionOutcomes(db, OTHER_CLINIC, metrics({}), NOW);

    expect(mine.map((o) => o.completionId)).toContain(mineId);
    expect(mine.map((o) => o.completionId)).not.toContain(theirsId);
    expect(theirs.map((o) => o.completionId)).toContain(theirsId);
    expect(theirs.map((o) => o.completionId)).not.toContain(mineId);
    // And every row each clinic sees is scoped to itself.
    expect(mine.every((o) => o.constraintId.includes(CLINIC))).toBe(true);
    expect(theirs.every((o) => o.constraintId.includes(OTHER_CLINIC))).toBe(true);
  });
});
