/**
 * Integration specs for the Diagnosis Engine's entity-level context adapter.
 *
 * These run against the LOCAL Supabase stack and skip, loudly, when it is not
 * reachable — same contract as the sibling adapters.
 *
 * The claims worth proving are the ones a discriminator would act on:
 *
 *   - cancellation NOTICE, which lives only in appointment_history and is the
 *     whole difference between a slot lost three weeks ahead and one lost an
 *     hour before
 *   - attendance history counted strictly BEFORE each missed appointment, so
 *     two misses in one week do not both read as "repeat offender"
 *   - money, where billed and collected must not be conflated
 *   - and the one method that must return `null` rather than `[]`, because an
 *     empty list would answer the very question the discriminator is asking
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/types/database.types";
import type { EntityWindow } from "@/business-brain";
import {
  applyEntityResolution,
  Availability,
  DEFAULT_ENTITY_RESOLUTION,
  DISCRIMINATORS,
} from "@/business-brain";
import type { Diagnosis } from "@/business-brain";
import { computeOutstandingBalance } from "@/lib/billing/balance";
import { EntityWindowTooLargeError, SupabaseDiagnosisContext } from "../diagnosis-context";

const URL = process.env.SUPABASE_TEST_URL ?? "http://127.0.0.1:55321";
const KEY =
  process.env.SUPABASE_TEST_SERVICE_KEY ??
  // Standard local-development service key — published in Supabase's own docs.
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
    `\n[diagnosis-context] SKIPPED — local Supabase not reachable at ${URL}.` +
      `\n                    Start it with: npm run db:start\n`,
  );
}

const C = "9fc00000-0000-4000-8000-000000000001";
const D = "9fc00000-0000-4000-8000-000000000010";
const P_REPEAT = "9fc00000-0000-4000-8000-000000000021";
const P_FIRST = "9fc00000-0000-4000-8000-000000000022";
const P_BOOKED = "9fc00000-0000-4000-8000-000000000023";
// Audit: diagnosis-context financial consistency (OPD/X-ray + pooled payments).
const P_OPD_XRAY = "9fc00000-0000-4000-8000-000000000024";
const P_LUMPSUM = "9fc00000-0000-4000-8000-000000000025";
// Audit: row-limit truncation ordering.
const P_LIMIT = "9fc00000-0000-4000-8000-000000000026";

/** Window under test: the first week of April 2026. */
const FROM = "2026-04-01";
const TO = "2026-04-07";
const WINDOW: EntityWindow = { clinicId: C, from: FROM, to: TO, limit: 500 };

const db: SupabaseClient<Database> = createClient<Database>(URL, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
/* eslint-disable @typescript-eslint/no-explicit-any */
const raw = db as any;

async function insert(table: string, values: unknown) {
  const { error } = await raw.from(table).insert(values);
  if (error) throw new Error(`seed ${table}: ${error.message}`);
}

async function cleanup() {
  await raw.from("clinics").delete().eq("id", C);
  await raw.auth.admin.deleteUser(D).catch(() => undefined);
}

// ── Fixture ids, named so assertions read as claims ──────────────────────────
const A_EARLY_CANCEL = "9fc00000-0000-4000-8000-000000000101"; // 48h notice
const A_LATE_CANCEL = "9fc00000-0000-4000-8000-000000000102"; // 2h notice, refilled
const A_UNTRACKED_CANCEL = "9fc00000-0000-4000-8000-000000000103"; // no history row
const A_NO_SHOW_1 = "9fc00000-0000-4000-8000-000000000104";
const A_NO_SHOW_2 = "9fc00000-0000-4000-8000-000000000105";
const A_REFILL = "9fc00000-0000-4000-8000-000000000106";
const A_ATTENDED = "9fc00000-0000-4000-8000-000000000107"; // prior attendance
const A_ARRIVED = "9fc00000-0000-4000-8000-000000000108";
const A_NO_CHECKIN = "9fc00000-0000-4000-8000-000000000109";
const A_OPD_XRAY = "9fc00000-0000-4000-8000-00000000010b";
const A_LUMPSUM = "9fc00000-0000-4000-8000-00000000010c";
const A_LIMIT = "9fc00000-0000-4000-8000-00000000010d";

const T_PAID = "9fc00000-0000-4000-8000-000000000201";
const T_PART_PAID = "9fc00000-0000-4000-8000-000000000202";
const T_PENDING = "9fc00000-0000-4000-8000-000000000203";
const T_PENDING_BOOKED = "9fc00000-0000-4000-8000-000000000204";
const T_CANCELLED_SLOT = "9fc00000-0000-4000-8000-000000000205";
// OPD/X-ray charge, no payment.
const T_OPD_XRAY = "9fc00000-0000-4000-8000-000000000206";
// Lump-sum pooling: A is older, B is newer; one payment linked to B overflows
// into the pool and settles A too (oldest-first, matching lib/billing/payout.ts).
const T_LUMPSUM_A = "9fc00000-0000-4000-8000-000000000207";
const T_LUMPSUM_B = "9fc00000-0000-4000-8000-000000000208";
// Row-limit ordering: OLD predates NEW; only NEW should survive a limit of 1.
const T_LIMIT_OLD = "9fc00000-0000-4000-8000-000000000209";
const T_LIMIT_NEW = "9fc00000-0000-4000-8000-00000000020a";

async function seed() {
  await cleanup();
  const { error } = await raw.auth.admin.createUser({
    id: D,
    email: "bb-ctx@test.local",
    password: "password123",
    email_confirm: true,
  });
  if (error && !/already/i.test(error.message)) throw new Error(`seed user: ${error.message}`);

  await insert("clinics", { id: C, name: "Context Clinic" });
  await insert("clinic_settings", {
    clinic_id: C,
    clinic_name: "Context Clinic",
    timezone: "Asia/Kolkata",
    average_appointment_duration: 30,
  });
  await insert("profiles", { id: D, clinic_id: C, full_name: "Ctx Dentist", role: "dentist" });
  await insert("patients", [
    { id: P_REPEAT, clinic_id: C, name: "Repeat", created_at: "2026-01-01T00:00:00Z" },
    { id: P_FIRST, clinic_id: C, name: "First timer", created_at: "2026-01-01T00:00:00Z" },
    { id: P_BOOKED, clinic_id: C, name: "Has a booking", created_at: "2026-01-01T00:00:00Z" },
    { id: P_OPD_XRAY, clinic_id: C, name: "OPD Xray", created_at: "2026-01-01T00:00:00Z" },
    { id: P_LUMPSUM, clinic_id: C, name: "Lumpsum", created_at: "2026-01-01T00:00:00Z" },
    { id: P_LIMIT, clinic_id: C, name: "Limit", created_at: "2026-01-01T00:00:00Z" },
  ]);

  const appt = (
    id: string,
    patient: string,
    scheduled: string,
    status: string,
  ) => ({
    id,
    clinic_id: C,
    patient_id: patient,
    dentist_id: D,
    scheduled_at: scheduled,
    source: "walk_in",
    status,
  });

  await insert("appointments", [
    appt(A_EARLY_CANCEL, P_FIRST, "2026-04-03T05:00:00Z", "cancelled"),
    appt(A_LATE_CANCEL, P_FIRST, "2026-04-04T05:00:00Z", "cancelled"),
    appt(A_UNTRACKED_CANCEL, P_FIRST, "2026-04-05T05:00:00Z", "cancelled"),
    // The slot A_LATE_CANCEL vacated, taken by someone else.
    appt(A_REFILL, P_BOOKED, "2026-04-04T05:00:00Z", "scheduled"),
    // P_REPEAT attends once, then misses twice in the window.
    appt(A_ATTENDED, P_REPEAT, "2026-03-01T05:00:00Z", "completed"),
    appt(A_NO_SHOW_1, P_REPEAT, "2026-04-02T05:00:00Z", "no_show"),
    appt(A_NO_SHOW_2, P_REPEAT, "2026-04-06T05:00:00Z", "no_show"),
    appt(A_ARRIVED, P_BOOKED, "2026-04-02T09:00:00Z", "completed"),
    appt(A_NO_CHECKIN, P_BOOKED, "2026-04-03T09:00:00Z", "completed"),
    // Distinct scheduled_at from every other fixture appointment above — the
    // unique index is (dentist_id, scheduled_at) for non-cancelled/no_show rows.
    appt(A_OPD_XRAY, P_OPD_XRAY, "2026-04-02T10:00:00Z", "completed"),
    appt(A_LUMPSUM, P_LUMPSUM, "2026-04-02T11:00:00Z", "completed"),
    appt(A_LIMIT, P_LIMIT, "2026-04-01T10:00:00Z", "completed"),
  ]);

  // Cancellation moments live ONLY here — appointments has no cancelled_at.
  await insert("appointment_history", [
    {
      appointment_id: A_EARLY_CANCEL,
      action: "status_changed",
      new_value: { status: "cancelled" },
      timestamp: "2026-04-01T05:00:00Z", // 48h before
    },
    {
      appointment_id: A_LATE_CANCEL,
      action: "status_changed",
      new_value: { status: "cancelled" },
      timestamp: "2026-04-04T03:00:00Z", // 2h before
    },
    // A_UNTRACKED_CANCEL deliberately has NO history row.
  ]);

  await insert("queue_entries", {
    id: "9fc00000-0000-4000-8000-000000000301",
    clinic_id: C,
    appointment_id: A_ARRIVED,
    patient_id: P_BOOKED,
    position: 1,
    status: "completed",
    queue_date: "2026-04-02",
    checked_in_at: "2026-04-02T09:12:00Z", // 12 minutes late
    called_at: "2026-04-02T09:30:00Z",
    // Booked for 30 minutes, actually took 50 — the overrun the service-time
    // discriminator exists to find.
    completed_at: "2026-04-02T10:20:00Z",
  });

  // NOTE: every row in this bulk insert must carry the SAME keys — PostgREST
  // fills a missing key with NULL, not the column DEFAULT, which trips the
  // NOT NULL constraints on opd_charged/opd_fee/xray_taken. Rows that don't
  // exercise OPD/X-ray explicitly zero them out.
  const noAncillary = { opd_charged: false, opd_fee: 0, xray_taken: false, xray_cost: 0 };
  await insert("treatments", [
    {
      id: T_PAID,
      clinic_id: C,
      appointment_id: A_ARRIVED,
      patient_id: P_BOOKED,
      treatment_type: "Cleaning",
      cost: 2000,
      status: "completed",
      performed_at: "2026-04-02T09:30:00Z",
      created_at: "2026-04-02T09:30:00Z",
      ...noAncillary,
    },
    {
      id: T_PART_PAID,
      clinic_id: C,
      appointment_id: A_NO_CHECKIN,
      patient_id: P_BOOKED,
      treatment_type: "Crown",
      cost: 20000,
      status: "completed",
      performed_at: "2026-04-03T09:30:00Z",
      created_at: "2026-04-03T09:30:00Z",
      ...noAncillary,
    },
    {
      // Booked into the slot that was then cancelled. Status `cancelled` so it
      // cannot leak into the pending, outstanding or completed lists — the only
      // thing under test here is that the slot's treatment type survives.
      id: T_CANCELLED_SLOT,
      clinic_id: C,
      appointment_id: A_EARLY_CANCEL,
      patient_id: P_FIRST,
      treatment_type: "Extraction",
      cost: 3000,
      status: "cancelled",
      created_at: "2026-03-30T05:00:00Z",
      ...noAncillary,
    },
    {
      id: T_PENDING,
      clinic_id: C,
      appointment_id: A_ATTENDED,
      patient_id: P_FIRST,
      treatment_type: "Root Canal",
      cost: 15000,
      status: "planned",
      created_at: "2026-04-01T05:00:00Z",
      ...noAncillary,
    },
    {
      id: T_PENDING_BOOKED,
      clinic_id: C,
      appointment_id: A_ATTENDED,
      patient_id: P_BOOKED,
      treatment_type: "Implant",
      cost: 50000,
      status: "planned",
      created_at: "2026-04-01T05:00:00Z",
      ...noAncillary,
    },
    // OPD + X-ray charge, no payment. 1000 cost + 300 OPD + 200 X-ray = 1500 owed.
    {
      id: T_OPD_XRAY,
      clinic_id: C,
      appointment_id: A_OPD_XRAY,
      patient_id: P_OPD_XRAY,
      treatment_type: "Consultation",
      cost: 1000,
      opd_charged: true,
      opd_fee: 300,
      xray_taken: true,
      xray_cost: 200,
      status: "completed",
      performed_at: "2026-04-02T09:30:00Z",
      created_at: "2026-04-02T09:30:00Z",
    },
    // Lump-sum pooling: A is older (500), B is newer (500). One ₹1000 payment
    // linked to B settles B (500) and overflows 500 into the pool, which
    // settles A oldest-first — both should read fully paid.
    {
      id: T_LUMPSUM_A,
      clinic_id: C,
      appointment_id: A_LUMPSUM,
      patient_id: P_LUMPSUM,
      treatment_type: "Filling",
      cost: 500,
      status: "completed",
      performed_at: "2026-04-02T09:00:00Z",
      created_at: "2026-04-02T09:00:00Z",
      ...noAncillary,
    },
    {
      id: T_LUMPSUM_B,
      clinic_id: C,
      appointment_id: A_LUMPSUM,
      patient_id: P_LUMPSUM,
      treatment_type: "Cleaning",
      cost: 500,
      status: "completed",
      ...noAncillary,
      performed_at: "2026-04-05T09:00:00Z",
      created_at: "2026-04-05T09:00:00Z",
    },
    // Row-limit ordering: both unpaid and outstanding; OLD predates NEW.
    {
      id: T_LIMIT_OLD,
      clinic_id: C,
      appointment_id: A_LIMIT,
      patient_id: P_LIMIT,
      treatment_type: "Cleaning",
      cost: 100,
      status: "completed",
      performed_at: "2026-04-01T09:00:00Z",
      created_at: "2026-04-01T09:00:00Z",
      ...noAncillary,
    },
    {
      id: T_LIMIT_NEW,
      clinic_id: C,
      appointment_id: A_LIMIT,
      patient_id: P_LIMIT,
      treatment_type: "Filling",
      cost: 200,
      status: "completed",
      performed_at: "2026-04-06T09:00:00Z",
      created_at: "2026-04-06T09:00:00Z",
      ...noAncillary,
    },
  ]);

  await insert("payments", [
    // T_PAID fully settled.
    { id: "9fc00000-0000-4000-8000-000000000401", clinic_id: C, patient_id: P_BOOKED, treatment_id: T_PAID, amount: 2000, method: "cash", payment_date: "2026-04-02" },
    // T_PART_PAID half settled.
    { id: "9fc00000-0000-4000-8000-000000000402", clinic_id: C, patient_id: P_BOOKED, treatment_id: T_PART_PAID, amount: 8000, method: "upi", payment_date: "2026-04-03" },
    // Linked to T_LUMPSUM_B (500 charge) but pays 1000 — the extra 500 must
    // pool and settle T_LUMPSUM_A, not vanish or double-credit B.
    { id: "9fc00000-0000-4000-8000-000000000403", clinic_id: C, patient_id: P_LUMPSUM, treatment_id: T_LUMPSUM_B, amount: 1000, method: "cash", payment_date: "2026-04-05" },
  ]);

  // P_BOOKED has a visit after the window, so their pending plan is not
  // "unscheduled". P_FIRST has none.
  await insert("appointments", appt(
    "9fc00000-0000-4000-8000-00000000010a",
    P_BOOKED,
    "2026-04-20T05:00:00Z",
    "scheduled",
  ));
}

const ctx = new SupabaseDiagnosisContext(db);

describe.skipIf(!LOCAL_UP)("diagnosis context (integration)", () => {
  beforeAll(seed);
  afterAll(cleanup);

  describe("cancellation events", () => {
    it("derives notice hours from the audit trail, not the appointment row", async () => {
      // appointments has no cancelled_at; appointment_history is the only record
      // of WHEN a slot was lost, and notice is the point of the discriminator.
      const events = await ctx.listCancellationEvents(WINDOW);
      const early = events?.find((e) => e.appointmentId === A_EARLY_CANCEL);
      const late = events?.find((e) => e.appointmentId === A_LATE_CANCEL);
      expect(early?.noticeHours).toBe(48);
      expect(late?.noticeHours).toBe(2);
    });

    it("leaves notice NULL when the cancellation moment was never recorded", async () => {
      // Guessing from created_at or scheduled_at would fabricate the exact
      // quantity being measured.
      const events = await ctx.listCancellationEvents(WINDOW);
      const untracked = events?.find((e) => e.appointmentId === A_UNTRACKED_CANCEL);
      expect(untracked?.cancelledAt).toBeNull();
      expect(untracked?.noticeHours).toBeNull();
    });

    it("gives a no-show no notice at all, rather than zero", async () => {
      // Zero notice would mean "cancelled at the last second", which is a
      // different event from never turning up.
      const events = await ctx.listCancellationEvents(WINDOW);
      const noShow = events?.find((e) => e.appointmentId === A_NO_SHOW_1);
      expect(noShow?.outcome).toBe("no_show");
      expect(noShow?.noticeHours).toBeNull();
    });

    it("reports whether the lost slot was recovered", async () => {
      const events = await ctx.listCancellationEvents(WINDOW);
      expect(events?.find((e) => e.appointmentId === A_LATE_CANCEL)?.slotRefilled).toBe(true);
      expect(events?.find((e) => e.appointmentId === A_EARLY_CANCEL)?.slotRefilled).toBe(false);
    });

    it("carries the treatment type that was booked into the slot", async () => {
      // Which work was lost matters: a week of cancelled hygiene visits and a
      // week of cancelled crowns are the same count and different problems.
      const events = await ctx.listCancellationEvents(WINDOW);
      expect(events?.find((e) => e.appointmentId === A_EARLY_CANCEL)?.treatmentType).toBe(
        "Extraction",
      );
      expect(events?.find((e) => e.appointmentId === A_NO_SHOW_1)?.treatmentType).toBeNull();
    });

    it("stays inside the window and the clinic", async () => {
      const events = await ctx.listCancellationEvents(WINDOW);
      expect(events?.every((e) => e.date >= FROM && e.date <= TO)).toBe(true);
      const elsewhere = await ctx.listCancellationEvents({
        ...WINDOW,
        clinicId: "9fc00000-0000-4000-8000-0000000000ff",
      });
      expect(elsewhere).toEqual([]);
    });
  });

  describe("clinic-local hours", () => {
    it("buckets cancellations and arrivals by the clinic's hour, not the server's", async () => {
      // 05:00 UTC is 10:30 in Kolkata. Bucketed in UTC, a morning clinic's losses
      // would be reported against the small hours of the night.
      const utc = await ctx.listCancellationEvents(WINDOW);
      const local = await new SupabaseDiagnosisContext(db, "Asia/Kolkata").listCancellationEvents(WINDOW);
      expect(utc?.find((e) => e.appointmentId === A_EARLY_CANCEL)?.localHour).toBe("05:00");
      expect(local?.find((e) => e.appointmentId === A_EARLY_CANCEL)?.localHour).toBe("10:00");
      // Checked in at 09:12 UTC: 14:42 in Kolkata.
      const arrivals = await new SupabaseDiagnosisContext(db, "Asia/Kolkata").listAppointmentArrivals(WINDOW);
      expect(arrivals?.find((a) => a.appointmentId === A_ARRIVED)?.arrivalLocalHour).toBe("14:00");
    });
  });

  describe("no-show history", () => {
    it("counts prior attendance strictly BEFORE each missed appointment", async () => {
      // Both misses belong to the same patient. If history were counted from the
      // window's edge they would read identically, and the discriminator that
      // separates a first lapse from a pattern would be useless.
      const history = await ctx.listNoShowHistory(WINDOW);
      const first = history?.find((h) => h.appointmentId === A_NO_SHOW_1);
      const second = history?.find((h) => h.appointmentId === A_NO_SHOW_2);
      expect(first?.priorMissed).toBe(0);
      expect(second?.priorMissed).toBe(1);
      expect(first?.priorAttended).toBe(1);
      expect(second?.priorAttended).toBe(1);
    });

    it("reports the last date the patient actually attended", async () => {
      const history = await ctx.listNoShowHistory(WINDOW);
      expect(history?.[0]?.lastAttendedDate).toBe("2026-03-01");
    });
  });

  describe("pending treatments", () => {
    it("excludes work whose patient has an upcoming visit", async () => {
      const pending = await ctx.listPendingTreatments(WINDOW);
      const ids = pending?.map((p) => p.treatmentId) ?? [];
      expect(ids).toContain(T_PENDING);
      expect(ids).not.toContain(T_PENDING_BOOKED);
    });

    it("ages the plan from acceptance to the end of the window", async () => {
      const pending = await ctx.listPendingTreatments(WINDOW);
      const row = pending?.find((p) => p.treatmentId === T_PENDING);
      expect(row?.acceptedOn).toBe("2026-04-01");
      expect(row?.ageDays).toBe(6); // 1 April -> 7 April
      expect(row?.quotedValue.value).toBe(15000);
    });
  });

  describe("outstanding balances", () => {
    it("omits fully-settled work — a balance of zero is not outstanding", async () => {
      const balances = await ctx.listOutstandingBalances(WINDOW);
      expect(balances?.map((b) => b.invoiceId)).not.toContain(T_PAID);
    });

    it("reports what is still owed and what has been paid, separately", async () => {
      const balances = await ctx.listOutstandingBalances(WINDOW);
      const row = balances?.find((b) => b.invoiceId === T_PART_PAID);
      expect(row?.amountOutstanding.value).toBe(12000);
      expect(row?.amountPaid.value).toBe(8000);
      expect(row?.ageDays).toBe(4); // 3 April -> 7 April
    });

    it("includes OPD and X-ray charges, matching lib/billing/balance.ts", async () => {
      // 1000 cost + 300 OPD + 200 X-ray, no payment = 1500 owed. The bug read
      // 1000 (cost only).
      const balances = await ctx.listOutstandingBalances(WINDOW);
      const row = balances?.find((b) => b.invoiceId === T_OPD_XRAY);
      expect(row?.amountOutstanding.value).toBe(1500);
      expect(row?.amountPaid.value).toBe(0);
    });

    it("pools a payment linked to one treatment across the patient's ledger (oldest first)", async () => {
      // T_LUMPSUM_B carries a ₹1000 payment against its own ₹500 charge; the
      // extra ₹500 must settle the older T_LUMPSUM_A, not vanish or leave A
      // reading as unpaid. The bug reported A still owing ₹500.
      const balances = await ctx.listOutstandingBalances(WINDOW);
      expect(balances?.map((b) => b.invoiceId)).not.toContain(T_LUMPSUM_A);
      expect(balances?.map((b) => b.invoiceId)).not.toContain(T_LUMPSUM_B);
    });

    it("reconciles with the canonical computeOutstandingBalance for the same patient", async () => {
      // The context's per-invoice figures, summed for one patient, must equal
      // the same patient/payment data run through lib/billing/balance.ts directly.
      const balances = await ctx.listOutstandingBalances(WINDOW);
      const contextTotal = (balances ?? [])
        .filter((b) => b.patientId === P_OPD_XRAY)
        .reduce((sum, b) => sum + b.amountOutstanding.value, 0);
      const canonical = computeOutstandingBalance(
        [
          {
            cost: 1000,
            status: "completed",
            opd_charged: true,
            opd_fee: 300,
            xray_taken: true,
            xray_cost: 200,
          },
        ],
        [],
      );
      expect(contextTotal).toBe(canonical);
      expect(canonical).toBe(1500);
    });

    it("refuses a window larger than its limit rather than answering from part of it", async () => {
      // Hardening: this used to keep the newest N and drop the rest, which made an
      // ageing distribution read from recent balances only look complete. A
      // window the limit cannot hold is now refused, and the service records the
      // discriminator as unanswered.
      await expect(ctx.listOutstandingBalances({ ...WINDOW, limit: 1 })).rejects.toBeInstanceOf(EntityWindowTooLargeError);
      const whole = await ctx.listOutstandingBalances(WINDOW);
      expect(whole.map((r) => r.invoiceId)).toEqual(expect.arrayContaining([T_LIMIT_NEW, T_LIMIT_OLD]));
    });
  });

  describe("appointment arrivals", () => {
    it("measures lateness against the scheduled start", async () => {
      const arrivals = await ctx.listAppointmentArrivals(WINDOW);
      const arrived = arrivals?.find((a) => a.appointmentId === A_ARRIVED);
      expect(arrived?.arrivalDeltaMinutes).toBe(12);
      expect(arrived?.seenAt).toBe("2026-04-02T09:30:00+00:00");
    });

    it("measures how long the appointment actually took", async () => {
      // Booked 30 minutes, called in 09:30, finished 10:20 — 50 actual.
      const arrivals = await ctx.listAppointmentArrivals(WINDOW);
      const arrived = arrivals?.find((a) => a.appointmentId === A_ARRIVED);
      expect(arrived?.scheduledMinutes).toBe(30);
      expect(arrived?.actualMinutes).toBe(50);
      expect(arrived?.finishedAt).toBe("2026-04-02T10:20:00+00:00");
    });

    it("leaves actual duration NULL when the visit was never closed out", async () => {
      // A plan is not an observation. An appointment with no recorded end has no
      // measurable duration, and substituting the booked length would report the
      // plan back as if it were the result.
      const arrivals = await ctx.listAppointmentArrivals(WINDOW);
      const none = arrivals?.find((a) => a.appointmentId === A_NO_CHECKIN);
      expect(none?.actualMinutes).toBeNull();
      expect(none?.finishedAt).toBeNull();
    });

    it("leaves arrival NULL when nobody checked the patient in", async () => {
      // Never-checked-in and never-arrived are indistinguishable from here, and
      // a null keeps that ambiguity visible instead of resolving it wrongly.
      const arrivals = await ctx.listAppointmentArrivals(WINDOW);
      const none = arrivals?.find((a) => a.appointmentId === A_NO_CHECKIN);
      expect(none?.arrivedAt).toBeNull();
      expect(none?.arrivalDeltaMinutes).toBeNull();
    });
  });

  describe("completed treatments", () => {
    it("keeps billed and collected apart", async () => {
      // Conflating them is exactly the confusion the discriminator exists to
      // resolve: a cheaper case mix and unpaid work look identical in a total.
      const completed = await ctx.listCompletedTreatments(WINDOW);
      const crown = completed?.find((t) => t.treatmentId === T_PART_PAID);
      expect(crown?.billedValue.value).toBe(20000);
      expect(crown?.collectedValue.value).toBe(8000);
    });

    it("includes fully-paid work, which the balance list excludes", async () => {
      const completed = await ctx.listCompletedTreatments(WINDOW);
      const clean = completed?.find((t) => t.treatmentId === T_PAID);
      expect(clean?.billedValue.value).toBe(2000);
      expect(clean?.collectedValue.value).toBe(2000);
    });

    it("bills OPD and X-ray charges, matching lib/billing/balance.ts", async () => {
      // 1000 cost + 300 OPD + 200 X-ray = 1500 billed. The bug read 1000.
      const completed = await ctx.listCompletedTreatments(WINDOW);
      const row = completed?.find((t) => t.treatmentId === T_OPD_XRAY);
      expect(row?.billedValue.value).toBe(1500);
      expect(row?.collectedValue.value).toBe(0);
    });

    it("shows a lump-sum payment as collected against BOTH treatments it settled", async () => {
      // T_LUMPSUM_B's own ₹1000 payment overflows into the pool and settles
      // T_LUMPSUM_A too — a clinic that pays in one lump sum should not read as
      // having collected nothing on the older line. The bug reported A's
      // collectedValue as 0 (payments carrying only B's treatment_id).
      const completed = await ctx.listCompletedTreatments(WINDOW);
      const a = completed?.find((t) => t.treatmentId === T_LUMPSUM_A);
      const b = completed?.find((t) => t.treatmentId === T_LUMPSUM_B);
      expect(a?.collectedValue.value).toBe(500);
      expect(a?.billedValue.value).toBe(500);
      expect(b?.collectedValue.value).toBe(500);
      expect(b?.billedValue.value).toBe(500);
    });
  });

  describe("what this deployment cannot answer", () => {
    it("offers no method for recall contact attempts, and catalogues them as data capture", async () => {
      // DentGrow records no contact attempt or outcome against a follow-up. The
      // port used to declare a method that could only ever return null; it now
      // declares nothing, and the discriminator says plainly that the data would
      // have to be captured. Either way no hypothesis may be settled from it.
      expect("listRecallContactAttempts" in ctx).toBe(false);
      expect(DISCRIMINATORS.RECALL_CONTACT_ATTEMPTS.availability).toBe(
        Availability.REQUIRES_DATA_CAPTURE,
      );
      expect(DISCRIMINATORS.RECALL_CONTACT_ATTEMPTS.portMethod).toBeNull();
    });

    it("distinguishes that from a method that genuinely found nothing", async () => {
      const empty = await ctx.listCompletedTreatments({
        ...WINDOW,
        from: "2020-01-01",
        to: "2020-01-02",
      });
      expect(empty).toEqual([]);
      expect(empty).not.toBeNull();
    });
  });

  /**
   * Adapter and resolvers, joined.
   *
   * The unit specs feed the resolvers literals; these feed them rows that came
   * out of Postgres. That is the join worth testing — a shape mismatch between
   * what the adapter returns and what a resolver reads would pass both sets of
   * unit tests and produce nothing in production.
   */
  describe("end to end with the resolvers", () => {
    const ADVANCE = "cancellation_dominant";
    const OTHER = "no_show_dominant";

    function pendingDiagnosis(discriminatorSlug: string): Diagnosis {
      const id = "diagnosis.schedule_attrition:ctx:2026-04-07";
      const h = (slug: string) => ({
        id: `${id}#h.${slug}`,
        statement: `Statement for ${slug}.`,
        status: "undetermined" as const,
        confidence: 0.4,
        supporting: [],
        contradicting: [],
        requiredData: ["entity rows"],
      });
      return {
        id,
        pattern: "schedule_attrition",
        title: "Appointments booked and then lost",
        summary: "Seeded losses.",
        category: "scheduling",
        severity: "medium",
        confidence: 0.5,
        persistence: "transient",
        signalIds: [],
        metricIds: [],
        hypotheses: [h(ADVANCE), h(OTHER)],
        discriminators: [
          {
            id: `${id}#d.${discriminatorSlug}`,
            description: "Would separate the two.",
            wouldSeparate: [`${id}#h.${ADVANCE}`, `${id}#h.${OTHER}`],
            availability: "requires_entity_data" as const,
          },
        ],
        relatedEntities: [],
        evidence: [],
        generatedAt: "2026-04-07T06:30:00.000Z",
      };
    }

    it("turns real cancellation rows into evidence with the real numbers", async () => {
      const events = await ctx.listCancellationEvents(WINDOW);
      const resolved = applyEntityResolution(
        [pendingDiagnosis("cancellation_timing")],
        { cancellationEvents: events },
        "2026-04-07T06:30:00.000Z",
        DEFAULT_ENTITY_RESOLUTION,
      );
      const description = resolved[0].evidence[0]?.description ?? "";
      // 5 lost appointments seeded (3 cancelled + 2 no-shows), 2 of them with a
      // recorded cancellation moment.
      expect(description).toContain("2 of 5 lost appointment(s)");
      expect(description).toContain("cancellation moment");
    });

    it("reports the real refill outcome", async () => {
      const events = await ctx.listCancellationEvents(WINDOW);
      const resolved = applyEntityResolution(
        [pendingDiagnosis("slot_refill_outcome")],
        { cancellationEvents: events },
        "2026-04-07T06:30:00.000Z",
        DEFAULT_ENTITY_RESOLUTION,
      );
      // Exactly one of the seeded losses had its slot taken.
      expect(resolved[0].evidence[0]?.description).toContain("1 of 5 vacated slot(s)");
    });

    it("leaves hypotheses open when a method could not answer", async () => {
      // The null path, end to end: the service records a failed or unanswerable
      // fetch as null, and nothing downstream may read that as "no cancellations".
      const before = pendingDiagnosis("cancellation_timing");
      const after = applyEntityResolution(
        [before],
        { cancellationEvents: null },
        "2026-04-07T06:30:00.000Z",
        DEFAULT_ENTITY_RESOLUTION,
      );
      expect(after[0]).toEqual(before);
    });
  });
});
