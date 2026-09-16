/**
 * Integration specs for the approved metric-definition fixes (B4/B5/B6/B7).
 * Runs against the LOCAL Supabase stack and skips, loudly, when it is not
 * reachable — same contract as the Business Brain integration specs.
 *
 *   B4 — avgPerCompletedAppointment: revenue attributable to completed
 *        appointments only, not every payment in range.
 *   B5 — avgCostByType/revenueByType: billable (completed/in_progress)
 *        treatments only, not cancelled/planned.
 *   B6 — averagePerDay: operating days, not calendar days and not "days that
 *        happened to have an appointment".
 *   B7 — returningPatients/activePatients/completedFollowUps and
 *        returningVsNew/topPatients: scoped to the SELECTED range, not the
 *        lifetime total_visits/last_visit columns or an unbounded fetch.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/types/database.types";
import {
  getAnalyticsSummary,
  getAppointmentAnalytics,
  getFollowUpAnalytics,
  getPatientAnalytics,
  getRevenueAnalytics,
  getTreatmentAnalytics,
} from "../queries";

const URL = process.env.SUPABASE_TEST_URL ?? "http://127.0.0.1:55321";
const KEY =
  process.env.SUPABASE_TEST_SERVICE_KEY ??
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
    `\n[metric-definitions] SKIPPED — local Supabase not reachable at ${URL}.` +
      `\n                     Start it with: npm run db:start\n`,
  );
}

const CLINIC = "9fd00000-0000-4000-8000-000000000001";
const DENTIST = "9fd00000-0000-4000-8000-000000000010";
const P1 = "9fd00000-0000-4000-8000-000000000021"; // 2 completed visits in range → returning
const P2 = "9fd00000-0000-4000-8000-000000000022"; // 1 completed visit in range → active only
const P3 = "9fd00000-0000-4000-8000-000000000023"; // only visit is OUTSIDE the range
const P4 = "9fd00000-0000-4000-8000-000000000024"; // 1 completed visit in range → active only

const FROM = "2026-05-01";
const TO = "2026-05-31";
const FILTER = { clinicId: CLINIC, dateFrom: FROM, dateTo: TO, timezone: "UTC" };

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
  await raw.from("clinics").delete().eq("id", CLINIC);
  await raw.auth.admin.deleteUser(DENTIST).catch(() => undefined);
}

const A1 = "9fd00000-0000-4000-8000-000000000101"; // P1 completed, in range, has a payment
const A2 = "9fd00000-0000-4000-8000-000000000102"; // P1 completed, in range
const A3 = "9fd00000-0000-4000-8000-000000000103"; // P2 completed, in range
const A4 = "9fd00000-0000-4000-8000-000000000104"; // P3 completed, OUTSIDE range
const A5 = "9fd00000-0000-4000-8000-000000000105"; // P1 cancelled, in range
const A8 = "9fd00000-0000-4000-8000-000000000108"; // scheduled (not completed), has a payment
const A9 = "9fd00000-0000-4000-8000-000000000109"; // P4 completed, in range, on the Monday that stays open
const A10 = "9fd00000-0000-4000-8000-00000000010a"; // P1 no_show, in range

async function seed() {
  await cleanup();
  const { error } = await raw.auth.admin.createUser({
    id: DENTIST,
    email: "bb-metricdef@test.local",
    password: "password123",
    email_confirm: true,
  });
  if (error && !/already/i.test(error.message)) throw new Error(`seed user: ${error.message}`);

  await insert("clinics", { id: CLINIC, name: "Metric Definitions Clinic" });
  await insert("clinic_settings", {
    clinic_id: CLINIC,
    clinic_name: "Metric Definitions Clinic",
    timezone: "UTC",
    average_appointment_duration: 30,
  });
  await insert("profiles", { id: DENTIST, clinic_id: CLINIC, full_name: "Dr Def", role: "dentist" });
  await insert("patients", [
    { id: P1, clinic_id: CLINIC, name: "Returning", created_at: "2026-01-01T00:00:00Z" },
    { id: P2, clinic_id: CLINIC, name: "ActiveOnly", created_at: "2026-01-01T00:00:00Z" },
    { id: P3, clinic_id: CLINIC, name: "OutsideRange", created_at: "2026-01-01T00:00:00Z" },
    { id: P4, clinic_id: CLINIC, name: "ActiveOnlyToo", created_at: "2026-01-01T00:00:00Z" },
  ]);

  const appt = (id: string, patient: string, scheduled: string, status: string) => ({
    id,
    clinic_id: CLINIC,
    patient_id: patient,
    dentist_id: DENTIST,
    scheduled_at: scheduled,
    source: "walk_in",
    status,
  });

  await insert("appointments", [
    appt(A1, P1, "2026-05-05T10:00:00Z", "completed"),
    appt(A2, P1, "2026-05-15T10:00:00Z", "completed"),
    appt(A3, P2, "2026-05-10T10:00:00Z", "completed"),
    appt(A4, P3, "2026-04-01T10:00:00Z", "completed"), // outside range on purpose
    appt(A5, P1, "2026-05-20T10:00:00Z", "cancelled"),
    appt(A8, P2, "2026-05-06T10:00:00Z", "scheduled"), // never completed
    appt(A9, P4, "2026-05-04T10:00:00Z", "completed"), // a Monday — B6 fixture
    appt(A10, P1, "2026-05-18T11:00:00Z", "no_show"),
  ]);

  const noAncillary = { opd_charged: false, opd_fee: 0, xray_taken: false, xray_cost: 0 };
  await insert("treatments", [
    // Billable — must count toward avgCostByType/revenueByType.
    {
      id: "9fd00000-0000-4000-8000-000000000201",
      clinic_id: CLINIC, appointment_id: A1, patient_id: P1,
      treatment_type: "Cleaning", cost: 1000, status: "completed",
      performed_at: "2026-05-05T10:00:00Z", created_at: "2026-05-05T10:00:00Z",
      ...noAncillary,
    },
    // Cancelled — same type, must NOT drag the average up (audit B5).
    {
      id: "9fd00000-0000-4000-8000-000000000202",
      clinic_id: CLINIC, appointment_id: A2, patient_id: P1,
      treatment_type: "Cleaning", cost: 5000, status: "cancelled",
      created_at: "2026-05-15T10:00:00Z",
      ...noAncillary,
    },
    // Planned — must not appear in avgCostByType for its own type either.
    {
      id: "9fd00000-0000-4000-8000-000000000203",
      clinic_id: CLINIC, appointment_id: A3, patient_id: P2,
      treatment_type: "Filling", cost: 2000, status: "planned",
      created_at: "2026-05-10T10:00:00Z",
      ...noAncillary,
    },
  ]);

  await insert("payments", [
    // Linked to a COMPLETED appointment — counts toward B4's numerator.
    { id: "9fd00000-0000-4000-8000-000000000301", clinic_id: CLINIC, patient_id: P1, appointment_id: A1, amount: 500, method: "cash", payment_date: "2026-05-05" },
    // Linked to a scheduled (never completed) appointment — must NOT count.
    { id: "9fd00000-0000-4000-8000-000000000302", clinic_id: CLINIC, patient_id: P2, appointment_id: A8, amount: 9999, method: "cash", payment_date: "2026-05-06" },
    // Unlinked walk-in payment — must NOT count.
    { id: "9fd00000-0000-4000-8000-000000000303", clinic_id: CLINIC, patient_id: P2, appointment_id: null, amount: 300, method: "upi", payment_date: "2026-05-07" },
  ]);

  await insert("follow_ups", [
    // Completed WITHIN the range — must count (both toward completedFollowUps
    // and as a completed entry in the completion-rate denominator).
    { id: "9fd00000-0000-4000-8000-000000000401", clinic_id: CLINIC, patient_id: P1, due_date: "2026-05-01", status: "completed", updated_at: "2026-05-10T00:00:00Z" },
    // Completed BEFORE the range — must NOT count (audit B7).
    { id: "9fd00000-0000-4000-8000-000000000402", clinic_id: CLINIC, patient_id: P2, due_date: "2026-04-01", status: "completed", updated_at: "2026-04-15T00:00:00Z" },
    // Due WITHIN the range but still pending — counts in the completion-rate
    // denominator (it was due this period) but not the numerator, so the two
    // in-range follow-ups (401 + 403) give a 50% rate, not 100%.
    { id: "9fd00000-0000-4000-8000-000000000403", clinic_id: CLINIC, patient_id: P2, due_date: "2026-05-20", status: "pending", updated_at: "2026-05-01T00:00:00Z" },
  ]);

  // B6 fixture: clinic open Mondays only; one of May's four Mondays is closed.
  // 2026-05-04, 05-11, 05-18, 05-25 are the Mondays; 05-11 is a holiday.
  await insert("availability_rules", {
    clinic_id: CLINIC, day_of_week: 1, start_time: "09:00", end_time: "17:00",
    slot_duration_minutes: 30, is_active: true,
  });
  await insert("unavailable_dates", { clinic_id: CLINIC, date: "2026-05-11" });
}

describe.skipIf(!LOCAL_UP)("analytics metric definitions (audit B4/B5/B6/B7)", () => {
  beforeAll(seed);
  afterAll(cleanup);

  it("B4 — avgPerCompletedAppointment counts only revenue tied to a completed appointment", async () => {
    const result = await getRevenueAnalytics(db, FILTER);
    // 4 completed-in-range appointments (A1, A2, A3, A9); only A1 has a
    // payment (500). The 9999 (scheduled A8) and 300 (unlinked) must be
    // excluded from both sides.
    expect(result.avgPerCompletedAppointment).toBe(500 / 4);
  });

  it("B5 — avgCostByType excludes cancelled/planned treatments", async () => {
    const result = await getTreatmentAnalytics(db, FILTER);
    const cleaning = result.avgCostByType.find((t) => t.treatmentType === "Cleaning");
    // Only the completed ₹1000 treatment counts — not (1000+5000)/2 = 3000.
    expect(cleaning?.avgCost).toBe(1000);
    const filling = result.avgCostByType.find((t) => t.treatmentType === "Filling");
    // The only Filling treatment is planned — zero billable, not 2000.
    expect(filling?.avgCost).toBe(0);
  });

  it("B5 — byType (most common) still counts every status, unaffected", async () => {
    const result = await getTreatmentAnalytics(db, FILTER);
    const cleaning = result.byType.find((t) => t.treatmentType === "Cleaning");
    // Both the completed and cancelled Cleaning treatments — "most common
    // type" means what got booked, not what got billed.
    expect(cleaning?.count).toBe(2);
  });

  it("B6 — averagePerDay divides by operating days, not calendar days", async () => {
    const result = await getAppointmentAnalytics(db, FILTER);
    // 6 appointments in range (A1,A2,A3,A5,A9,A10); 3 operating Mondays
    // (4 minus the 1 holiday) — NOT 31 calendar days, NOT the count of days
    // that happened to have an appointment.
    expect(result.averagePerDay).toBe(Math.round(6 / 3));
    expect(result.averagePerDay).not.toBe(Math.round(6 / 31));
  });

  it("B7 — returningPatients/activePatients are scoped to the selected range", async () => {
    const result = await getAnalyticsSummary(db, FILTER);
    // Only P1 has more than one completed visit IN RANGE.
    expect(result.returningPatients).toBe(1);
    // P1, P2, P4 each have at least one completed visit in range; P3's only
    // completed visit is in April, outside the range — must be excluded.
    expect(result.activePatients).toBe(3);
  });

  it("B7 — completedFollowUps respects the selected range", async () => {
    const result = await getAnalyticsSummary(db, FILTER);
    // Only the follow-up completed (updated_at) within May counts.
    expect(result.completedFollowUps).toBe(1);
  });

  it("B7 — Follow-up Completion Rate is scoped to the selected range, not all-time", async () => {
    const result = await getFollowUpAnalytics(db, FILTER);
    // Two follow-ups are DUE within May (401 completed, 403 still pending);
    // 402 is due in April and must not enter either side of the ratio.
    // 1 of 2 completed = 50%, not 1 of 3 (33%) and not 1 of 1 (100%).
    expect(result.completionRate).toBe(50);
  });

  it("B7 — a Last-30-Days-style narrower range changes the Completion Rate", async () => {
    // Excluding the still-pending follow-up's due date (2026-05-20) from the
    // window must raise the rate — proving the number actually MOVES with
    // the selected range instead of silently staying an all-time constant.
    const narrower = { ...FILTER, dateFrom: "2026-05-01", dateTo: "2026-05-15" };
    const result = await getFollowUpAnalytics(db, narrower);
    // Only follow-up 401 (due 2026-05-01, completed) falls in this window.
    expect(result.completionRate).toBe(100);
  });

  it("B7 — getPatientAnalytics.returningVsNew is scoped to the range, not lifetime total_visits", async () => {
    const result = await getPatientAnalytics(db, FILTER);
    expect(result.returningVsNew.returning).toBe(1); // P1 only
    expect(result.returningVsNew.new).toBe(3); // P2, P3, P4
  });

  it("B7 — getPatientAnalytics.topPatients ranks by visits within the range", async () => {
    const result = await getPatientAnalytics(db, FILTER);
    expect(result.topPatients[0]?.patientId).toBe(P1);
    expect(result.topPatients[0]?.visits).toBe(2);
    // P3's only visit is outside the range, so it must not appear at all.
    expect(result.topPatients.map((p) => p.patientId)).not.toContain(P3);
  });

  // Last: it deletes a patient, which the range-scoped cases above do not expect.
  it("F11 — collections over time keep a deleted patient's payments; the outstanding balance does not", async () => {
    const before = await getRevenueAnalytics(db, FILTER);
    const P5 = "9fd00000-0000-4000-8000-000000000025";
    const A11 = "9fd00000-0000-4000-8000-00000000010b";
    await insert("patients", { id: P5, clinic_id: CLINIC, name: "Deleted later", created_at: "2026-01-01T00:00:00Z" });
    await insert("appointments", { id: A11, clinic_id: CLINIC, patient_id: P5, dentist_id: DENTIST, scheduled_at: "2026-05-08T10:00:00Z", source: "walk_in", status: "completed" });
    await insert("treatments", {
      id: "9fd00000-0000-4000-8000-000000000204", clinic_id: CLINIC, appointment_id: A11, patient_id: P5,
      treatment_type: "Crown", cost: 1200, status: "completed", performed_at: "2026-05-08T10:30:00Z",
      opd_charged: false, opd_fee: 0, xray_taken: false, xray_cost: null,
    });
    await insert("payments", [
      { id: "9fd00000-0000-4000-8000-000000000304", clinic_id: CLINIC, patient_id: P5, appointment_id: A11, amount: 700, method: "cash", payment_date: "2026-05-08" },
      // Deleted on its own, cause not recorded: stays out, as before.
      { id: "9fd00000-0000-4000-8000-000000000305", clinic_id: CLINIC, patient_id: P5, appointment_id: null, amount: 800, method: "cash", payment_date: "2026-05-09" },
    ]);
    const deletedAt = "2026-06-01T00:00:00Z";
    await raw.from("payments").update({ deleted_at: deletedAt }).eq("id", "9fd00000-0000-4000-8000-000000000305");
    for (const table of ["appointments", "treatments", "payments"]) {
      const { error } = await raw.from(table).update({ deleted_at: deletedAt, deletion_cause: "patient_deleted" }).eq("patient_id", P5).is("deleted_at", null);
      if (error) throw new Error(`delete ${table}: ${error.message}`);
    }
    await raw.from("patients").update({ deleted_at: deletedAt }).eq("id", P5);

    const after = await getRevenueAnalytics(db, FILTER);
    const on = (r: typeof after, date: string) => r.overTime.find((d) => d.date === date)?.amount ?? 0;
    expect(on(after, "2026-05-08") - on(before, "2026-05-08")).toBe(700);
    expect(on(after, "2026-05-09")).toBe(on(before, "2026-05-09"));
    expect(after.outstandingTotal).toBe(before.outstandingTotal);
  });
});
