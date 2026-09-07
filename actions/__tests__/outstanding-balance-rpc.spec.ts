/**
 * actions/__tests__/outstanding-balance-rpc.spec.ts
 *
 * Pins clinic_outstanding_balances() (20260907000200) against
 * lib/billing/balance.ts, which is the only definition of what a patient owes.
 *
 * WHY THIS EXISTS
 *   getPatientsWithOutstandingBalance used to fetch every patient, treatment
 *   and payment in the clinic and reduce them in JavaScript. PostgREST caps a
 *   response at max_rows (1000) and truncates SILENTLY past it, so the balances
 *   quietly went wrong once a clinic got busy — and actions/messaging.ts builds
 *   the payment-reminder list from the same function, so the visible symptom
 *   would have been dunning patients who had already paid.
 *
 *   Moving the aggregate into SQL removes the cap. It also creates a NEW risk
 *   that did not exist before: two implementations of the same money rule, in
 *   two languages, that can drift. This spec is what stops that — it computes
 *   the expected figure with the JS helpers and asserts the database agrees,
 *   over a fixture built to exercise every term:
 *
 *     - a completed treatment          → cost counts
 *     - a planned treatment            → cost does NOT count …
 *     - …but its OPD fee DOES          → opdChargeFor ignores status
 *     - an X-ray on a cancelled visit  → xrayChargeFor ignores status too
 *     - a part payment                 → subtracted
 *     - a second patient who overpaid  → clamped to 0, and must not appear,
 *                                        and must not offset the first patient
 *
 *   The last one is the audit-A5 rule: clamping per patient, not per clinic.
 *
 * Skips loudly when the local stack is down, same contract as the sibling
 * specs. CI starts the stack and fails on any skip.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/types/database.types";
import { computeOutstandingBalance } from "@/lib/billing/balance";

const URL = process.env.SUPABASE_TEST_URL ?? "http://127.0.0.1:55321";
const ANON =
  process.env.SUPABASE_TEST_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const KEY =
  process.env.SUPABASE_TEST_SERVICE_KEY ??
  process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

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
    `\n[outstanding-balance-rpc] SKIPPED — local Supabase not reachable at ${URL}.` +
      `\n                          Start it with: npm run db:start\n`,
  );
}

const db: SupabaseClient<Database> = createClient<Database>(URL, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
/* eslint-disable @typescript-eslint/no-explicit-any */
const raw = db as any;

const CLINIC = "9fd00000-0000-4000-8000-0000000009a0";
const DENTIST = "9fd00000-0000-4000-8000-0000000009a1";
const RECEPTION = "9fd00000-0000-4000-8000-0000000009a2";
const OWES = "9fd00000-0000-4000-8000-0000000009b1";
const OVERPAID = "9fd00000-0000-4000-8000-0000000009b2";
const APPT = "9fd00000-0000-4000-8000-0000000009c1";

/** The fixture, expressed the way lib/billing/balance.ts consumes it. */
const OWES_TREATMENTS = [
  // Completed: cost counts, plus OPD and X-ray.
  { cost: 5000, status: "completed", opd_charged: true, opd_fee: 300, xray_taken: true, xray_cost: 700 },
  // Planned: cost must NOT count, but the consultation still happened.
  { cost: 9000, status: "planned", opd_charged: true, opd_fee: 300, xray_taken: false, xray_cost: null },
  // Cancelled: cost must NOT count, but the film was still used.
  // opd_fee is NOT NULL with a 0 default in the schema; opdChargeFor short-
  // circuits on opd_charged, so 0 and NULL are the same figure either way.
  { cost: 4000, status: "cancelled", opd_charged: false, opd_fee: 0, xray_taken: true, xray_cost: 450 },
];
const OWES_PAYMENTS = [{ amount: 2000 }];

const OVERPAID_TREATMENTS = [
  { cost: 1000, status: "completed", opd_charged: false, opd_fee: 0, xray_taken: false, xray_cost: null },
];
const OVERPAID_PAYMENTS = [{ amount: 4000 }];

async function insert(table: string, values: unknown) {
  const { error } = await raw.from(table).insert(values);
  if (error) throw new Error(`seed ${table}: ${error.message}`);
}

async function cleanup() {
  await raw.from("clinics").delete().eq("id", CLINIC);
  await raw.auth.admin.deleteUser(DENTIST).catch(() => undefined);
  await raw.auth.admin.deleteUser(RECEPTION).catch(() => undefined);
}

/** A session token for a seeded account, so the RPC runs under a real role. */
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

async function balancesAs(token: string) {
  const res = await fetch(`${URL}/rest/v1/rpc/clinic_outstanding_balances`, {
    method: "POST",
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!res.ok) throw new Error(`rpc failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as Array<{
    patient_id: string;
    name: string;
    balance: string | number;
  }>;
}

describe.skipIf(!LOCAL_UP)("clinic_outstanding_balances", () => {
  let dentistToken = "";
  let receptionToken = "";

  beforeAll(async () => {
    await cleanup();

    await insert("clinics", { id: CLINIC, name: "Balance RPC Clinic" });

    for (const [id, email, role] of [
      [DENTIST, "balance-rpc-dentist@dentgrow.test", "dentist"],
      [RECEPTION, "balance-rpc-reception@dentgrow.test", "receptionist"],
    ] as const) {
      const { error } = await raw.auth.admin.createUser({
        id,
        email,
        password: "password123",
        email_confirm: true,
      });
      if (error && !/already/i.test(error.message)) throw error;
      await insert("profiles", {
        id,
        clinic_id: CLINIC,
        full_name: email,
        role,
      });
    }

    await insert("patients", [
      { id: OWES, clinic_id: CLINIC, name: "Owes Money", phone: "9000000101" },
      { id: OVERPAID, clinic_id: CLINIC, name: "Paid Too Much", phone: "9000000102" },
    ]);

    await insert("appointments", {
      id: APPT,
      clinic_id: CLINIC,
      patient_id: OWES,
      dentist_id: DENTIST,
      scheduled_at: new Date().toISOString(),
      duration_minutes: 30,
      source: "walk_in",
      status: "completed",
    });

    await insert(
      "treatments",
      OWES_TREATMENTS.map((t) => ({
        ...t,
        clinic_id: CLINIC,
        appointment_id: APPT,
        patient_id: OWES,
        treatment_type: "Fixture",
      })),
    );
    await insert(
      "treatments",
      OVERPAID_TREATMENTS.map((t) => ({
        ...t,
        clinic_id: CLINIC,
        appointment_id: APPT,
        patient_id: OVERPAID,
        treatment_type: "Fixture",
      })),
    );

    const today = new Date().toISOString().slice(0, 10);
    await insert(
      "payments",
      [
        ...OWES_PAYMENTS.map((p) => ({ ...p, patient_id: OWES })),
        ...OVERPAID_PAYMENTS.map((p) => ({ ...p, patient_id: OVERPAID })),
      ].map((p) => ({ ...p, clinic_id: CLINIC, method: "cash", payment_date: today })),
    );

    [dentistToken, receptionToken] = await Promise.all([
      tokenFor("balance-rpc-dentist@dentgrow.test"),
      tokenFor("balance-rpc-reception@dentgrow.test"),
    ]);
  });

  afterAll(cleanup);

  it("agrees with lib/billing/balance.ts to the paisa", async () => {
    const expected = computeOutstandingBalance(OWES_TREATMENTS, OWES_PAYMENTS);
    // 5000 + 300 + 700 (completed) + 300 (OPD on planned) + 450 (X-ray on
    // cancelled) − 2000 = 4750. Stated here so a change to either side has to
    // argue with a number a human wrote down.
    expect(expected).toBe(4750);

    const rows = await balancesAs(dentistToken);
    const owes = rows.find((r) => r.patient_id === OWES);
    expect(owes, "the patient who owes money is missing from the result").toBeTruthy();
    expect(Number(owes!.balance)).toBe(expected);
  });

  it("clamps per patient — an overpayment neither shows nor offsets", async () => {
    expect(computeOutstandingBalance(OVERPAID_TREATMENTS, OVERPAID_PAYMENTS)).toBe(0);

    const rows = await balancesAs(dentistToken);
    expect(
      rows.some((r) => r.patient_id === OVERPAID),
      "a settled patient must not appear in the dues list",
    ).toBe(false);

    // And the overpayment must not have reduced the other patient's debt.
    expect(Number(rows.find((r) => r.patient_id === OWES)!.balance)).toBe(4750);
  });

  it("is readable by a receptionist — it drives their pending-payments list", async () => {
    const rows = await balancesAs(receptionToken);
    expect(Number(rows.find((r) => r.patient_id === OWES)!.balance)).toBe(4750);
  });

  it("returns nothing to an anonymous caller", async () => {
    // auth_role() and auth_clinic_id() are both NULL, so `scope` resolves to
    // NULL and every join matches nothing. The function is SECURITY DEFINER, so
    // this is the assertion that its own authorisation — not RLS — is holding.
    const res = await fetch(`${URL}/rest/v1/rpc/clinic_outstanding_balances`, {
      method: "POST",
      headers: { apikey: ANON, "Content-Type": "application/json" },
      body: "{}",
    });
    if (res.ok) {
      expect(await res.json()).toEqual([]);
    } else {
      // EXECUTE is revoked from anon, so being refused outright is the stronger
      // and equally acceptable outcome.
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });
});
