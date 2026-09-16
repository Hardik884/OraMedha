/**
 * Integration specs for the clinic ledger adapter, against the LOCAL Supabase
 * stack. Skips, loudly, when it is not reachable — same contract as the sibling
 * adapters.
 *
 * What is proven here, against real rows:
 *
 *   1. The chain the flat snapshot cannot express is walkable end to end:
 *      patient → appointment → queue → treatment → payment → follow-up →
 *      booked visit → action completion.
 *   2. Tenant isolation — by the adapter's own clinic predicates under the
 *      service role, and again under RLS on a signed-in dentist's session.
 *   3. Soft deletes — deleted rows never appear, and liveness propagates to the
 *      three tables that have no `deleted_at` of their own.
 *   4. The aggregate path and the relational path AGREE wherever they describe
 *      the same fact. Two routes to one number that can drift apart are worse
 *      than one route.
 *   5. Missing stays missing — unrecorded timings are null, unrecorded
 *      relationships are `not_recorded`, a truncated read is never complete.
 *   6. Nothing identifying or clinical crosses into a slice.
 *
 * Fixture ids are generated per run. `action_completions` and `treatment_history`
 * are append-only (their triggers refuse even a clinic cascade), so the clinics
 * cannot be removed afterwards; a fresh set per run keeps executions independent.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildLedgerGraph,
  DentGrowMetricsEngine,
  LedgerFactKind,
  MetricKey,
  type ClinicLedgerGraph,
  type ClinicLedgerSlice,
  type Metric,
  type Traversal,
} from "@/business-brain";
import type { Database } from "@/types/database.types";
import { treatmentTotalCharge } from "@/lib/billing/balance";
import { addDays } from "@/business-brain/utils";
import { getUtcBoundariesForLocalDate } from "@/lib/utils";
import { MAX_LEDGER_PATIENTS, SupabaseClinicLedger } from "../clinic-ledger";
import { SupabaseMetricsDataRepository } from "../metrics-repository";

const URL = process.env.SUPABASE_TEST_URL ?? "http://127.0.0.1:55321";
const KEY =
  process.env.SUPABASE_TEST_SERVICE_KEY ??
  // Standard local-development service key — published in Supabase's own docs.
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const ANON_KEY =
  process.env.SUPABASE_TEST_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${URL}/rest/v1/`, { headers: { apikey: KEY }, signal: AbortSignal.timeout(2500) });
    return res.status < 500;
  } catch {
    return false;
  }
}
const LOCAL_UP = await reachable();
if (!LOCAL_UP) {
  console.warn(
    `\n[clinic-ledger] SKIPPED — local Supabase not reachable at ${URL}.` +
      `\n                Start it with: npm run db:start\n`,
  );
}

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
 * Soft-delete a fixed dentist's appointments left by earlier runs. Appointment
 * slots are unique per (dentist, start time) among live rows, and a reused
 * dentist would otherwise collide with its own previous run's fixtures. Earlier
 * runs' clinics are abandoned test data; nothing reads them.
 */
async function retirePreviousRuns(dentistIds: readonly string[]) {
  const { error } = await raw
    .from("appointments")
    .update({ deleted_at: new Date().toISOString() })
    .in("dentist_id", dentistIds as string[])
    .is("deleted_at", null);
  if (error) throw new Error(`retire previous runs: ${error.message}`);
}


// ── Time ─────────────────────────────────────────────────────────────────────
const TZ = "Asia/Kolkata";
const D = "2026-05-12";
/** End of the clinic-local business day: the moment both paths describe. */
const AS_OF = getUtcBoundariesForLocalDate(D, TZ).end;
const BEFORE = "2026-04-20T04:00:00.000Z";
const DELETED_AT = "2026-05-12T12:00:00.000Z";

// ── Identifiers, fresh per run ───────────────────────────────────────────────
const id = () => crypto.randomUUID();
const RUN = id().slice(0, 8);
const CLINIC_A = id();
const CLINIC_B = id();
/**
 * Auth users are FIXED per spec and reused across runs, not created per run.
 *
 * Each run's clinic is new (the append-only audit tables refuse a clinic delete),
 * and a dentist whose profile those rows reference cannot be deleted either — so
 * per-run users could never be cleaned up, and they accumulated until specs that
 * look users up on the first page of `auth.admin.listUsers()` stopped finding
 * theirs. A fixed user's profile is simply upserted onto the new clinic.
 */
const DENTIST_A = "1ed00000-0000-4000-8000-0000000000a1";
const DENTIST_B = "1ed00000-0000-4000-8000-0000000000b1";
const DENTIST_A_EMAIL = "ledger-a@test.local";
const RECEPTIONIST_A = "1ed00000-0000-4000-8000-0000000000a2";
const RECEPTIONIST_A_EMAIL = "ledger-r@test.local";

const P1 = id(); // the full chain
const P2 = id(); // no-shows, a planned treatment with nothing booked, deleted rows
const P_DEL = id(); // soft-deleted patient
const PB = id(); // clinic B

const A1 = id(); // P1, D, completed, queue Q1
const A2 = id(); // P1, booked from F1, 2026-05-26
const A_DEL = id(); // P1, soft-deleted, its queue entry left behind
const A3 = id(); // P2, D, no-show, never checked in
const A4 = id(); // P2, D, cancelled with 48h notice
const A5 = id(); // P2, 2026-05-02, no-show
const A6 = id(); // P2, D, checked in, never called
const A_PDEL = id(); // P_DEL, D, soft-deleted with the patient
const A_ORPHAN = id(); // P_DEL, 2026-05-13, missed by the cascade
const AB = id(); // clinic B, D

const Q1 = id();
const Q_DEL = id();
const Q6 = id();
const T1 = id(); // P1 completed root canal + OPD, recorded at A1
const T2 = id(); // P1 planned crown, recorded at A1
const T3 = id(); // P2 planned, recorded at A3
const T_DEL = id(); // P2 soft-deleted
const TB = id();
const F1 = id(); // P1, raised by T1 at A1, booked as A2
const F2 = id(); // P2 overdue
const FB = id();
const PAY1 = id();
const PAY_DEL = id();
const PAYB = id();
const R1 = id();
const RB = id();

const SECRET = `LEDGER-SECRET-${RUN}`;

async function seed() {
  for (const [uid, email] of [
    [DENTIST_A, DENTIST_A_EMAIL],
    [DENTIST_B, "ledger-b@test.local"],
    [RECEPTIONIST_A, RECEPTIONIST_A_EMAIL],
  ] as const) {
    const { error } = await raw.auth.admin.createUser({ id: uid, email, password: "password123", email_confirm: true });
    if (error && !/already/i.test(error.message)) throw new Error(`seed user: ${error.message}`);
  }

  await insert("clinics", [
    { id: CLINIC_A, name: "Ledger Clinic A" },
    { id: CLINIC_B, name: "Ledger Clinic B" },
  ]);
  await insert("clinic_settings", [
    { clinic_id: CLINIC_A, clinic_name: "Ledger Clinic A", timezone: TZ, average_appointment_duration: 30 },
    { clinic_id: CLINIC_B, clinic_name: "Ledger Clinic B", timezone: TZ, average_appointment_duration: 30 },
  ]);
  await upsert("profiles", [
    { id: DENTIST_A, clinic_id: CLINIC_A, full_name: "Ledger Dentist A", role: "dentist" },
    { id: DENTIST_B, clinic_id: CLINIC_B, full_name: "Ledger Dentist B", role: "dentist" },
    { id: RECEPTIONIST_A, clinic_id: CLINIC_A, full_name: "Ledger Receptionist A", role: "receptionist" },
  ]);

  await retirePreviousRuns([DENTIST_A, DENTIST_B]);

  const patient = (pid: string, clinic: string, deleted = false) => ({
    id: pid,
    clinic_id: clinic,
    name: `${SECRET} name`,
    notes: `${SECRET} notes`,
    created_at: "2026-01-01T00:00:00.000Z",
    deleted_at: deleted ? DELETED_AT : null,
  });
  await insert("patients", [
    patient(P1, CLINIC_A),
    patient(P2, CLINIC_A),
    patient(P_DEL, CLINIC_A, true),
    patient(PB, CLINIC_B),
  ]);

  const appt = (o: {
    id: string;
    clinic?: string;
    patient: string;
    at: string;
    status: string;
    dentist?: string;
    deleted?: boolean;
    booked?: string;
    followUp?: string | null;
  }) => ({
    id: o.id,
    clinic_id: o.clinic ?? CLINIC_A,
    patient_id: o.patient,
    dentist_id: o.dentist ?? DENTIST_A,
    scheduled_at: o.at,
    duration_minutes: 30,
    source: "phone_call",
    status: o.status,
    notes: `${SECRET} appointment notes`,
    created_at: o.booked ?? BEFORE,
    deleted_at: o.deleted ? DELETED_AT : null,
    follow_up_id: o.followUp ?? null,
  });
  await insert("appointments", [
    appt({ id: A1, patient: P1, at: "2026-05-12T04:00:00.000Z", status: "completed" }),
    appt({ id: A_DEL, patient: P1, at: "2026-05-05T04:00:00.000Z", status: "completed", deleted: true }),
    appt({ id: A3, patient: P2, at: "2026-05-12T06:00:00.000Z", status: "no_show" }),
    appt({ id: A4, patient: P2, at: "2026-05-12T07:00:00.000Z", status: "cancelled" }),
    appt({ id: A5, patient: P2, at: "2026-05-02T06:00:00.000Z", status: "no_show" }),
    appt({ id: A6, patient: P2, at: "2026-05-12T09:00:00.000Z", status: "checked_in" }),
    appt({ id: A_PDEL, patient: P_DEL, at: "2026-05-12T08:00:00.000Z", status: "scheduled", deleted: true }),
    appt({ id: A_ORPHAN, patient: P_DEL, at: "2026-05-13T08:00:00.000Z", status: "scheduled" }),
    appt({ id: AB, clinic: CLINIC_B, patient: PB, dentist: DENTIST_B, at: "2026-05-12T04:00:00.000Z", status: "completed" }),
  ]);

  await insert("queue_entries", [
    {
      id: Q1, clinic_id: CLINIC_A, appointment_id: A1, patient_id: P1, position: 1, status: "completed",
      queue_date: D, checked_in_at: "2026-05-12T03:55:00.000Z", called_at: "2026-05-12T04:05:00.000Z",
      completed_at: "2026-05-12T04:50:00.000Z",
    },
    {
      // Belongs to a soft-deleted appointment. queue_entries has no deleted_at,
      // so only liveness propagation keeps it out.
      id: Q_DEL, clinic_id: CLINIC_A, appointment_id: A_DEL, patient_id: P1, position: 1, status: "completed",
      queue_date: "2026-05-05", checked_in_at: "2026-05-05T03:55:00.000Z", called_at: "2026-05-05T04:00:00.000Z",
      completed_at: "2026-05-05T04:40:00.000Z",
    },
    {
      id: Q6, clinic_id: CLINIC_A, appointment_id: A6, patient_id: P2, position: 1, status: "waiting",
      queue_date: D, checked_in_at: "2026-05-12T08:55:00.000Z", called_at: null, completed_at: null,
    },
  ]);

  const treatment = (o: {
    id: string; clinic?: string; patient: string; appt: string; type: string; cost: number; status: string;
    performed?: string | null; deleted?: boolean; opd?: number;
  }) => ({
    id: o.id,
    clinic_id: o.clinic ?? CLINIC_A,
    appointment_id: o.appt,
    patient_id: o.patient,
    treatment_type: o.type,
    cost: o.cost,
    status: o.status,
    performed_at: o.performed ?? null,
    created_at: "2026-05-12T04:30:00.000Z",
    deleted_at: o.deleted ? DELETED_AT : null,
    internal_notes: `${SECRET} internal`,
    patient_visible_notes: `${SECRET} visible`,
    opd_charged: (o.opd ?? 0) > 0,
    opd_fee: o.opd ?? 0,
    xray_taken: false,
    xray_cost: 0,
  });
  await insert("treatments", [
    treatment({ id: T1, patient: P1, appt: A1, type: "Root Canal", cost: 5000, status: "completed", performed: "2026-05-12T04:30:00.000Z", opd: 300 }),
    treatment({ id: T2, patient: P1, appt: A1, type: "Crown", cost: 8000, status: "planned" }),
    treatment({ id: T3, patient: P2, appt: A3, type: "Filling", cost: 1500, status: "planned" }),
    treatment({ id: T_DEL, patient: P2, appt: A3, type: "Scaling", cost: 700, status: "completed", performed: "2026-05-12T06:10:00.000Z", deleted: true }),
    treatment({ id: TB, clinic: CLINIC_B, patient: PB, appt: AB, type: "Cleaning", cost: 900, status: "completed", performed: "2026-05-12T04:20:00.000Z" }),
  ]);

  await insert("treatment_history", [
    { clinic_id: CLINIC_A, treatment_id: T2, patient_id: P1, action: "created", new_value: { status: "planned", cost: 8000 }, timestamp: "2026-05-12T04:35:00.000Z" },
    { clinic_id: CLINIC_A, treatment_id: T_DEL, patient_id: P2, action: "created", new_value: { status: "completed" }, timestamp: "2026-05-12T06:10:00.000Z" },
  ]);

  const followUp = (o: { id: string; clinic?: string; patient: string; due: string; appt?: string | null; treatment?: string | null }) => ({
    id: o.id,
    clinic_id: o.clinic ?? CLINIC_A,
    patient_id: o.patient,
    appointment_id: o.appt ?? null,
    treatment_id: o.treatment ?? null,
    due_date: o.due,
    status: "pending",
    notes: `${SECRET} follow-up notes`,
    created_at: BEFORE,
    updated_at: BEFORE,
  });
  await insert("follow_ups", [
    followUp({ id: F1, patient: P1, due: "2026-05-26", appt: A1, treatment: T1 }),
    followUp({ id: F2, patient: P2, due: "2026-05-01" }),
    followUp({ id: FB, clinic: CLINIC_B, patient: PB, due: "2026-05-01" }),
  ]);

  // Booked from F1 — inserted after the follow-up it references.
  await insert("appointments", [
    appt({ id: A2, patient: P1, at: "2026-05-26T05:00:00.000Z", status: "scheduled", booked: "2026-05-12T05:00:00.000Z", followUp: F1 }),
  ]);

  const payment = (o: { id: string; clinic?: string; patient: string; amount: number; appt?: string | null; treatment?: string | null; deleted?: boolean }) => ({
    id: o.id,
    clinic_id: o.clinic ?? CLINIC_A,
    patient_id: o.patient,
    appointment_id: o.appt ?? null,
    treatment_id: o.treatment ?? null,
    amount: o.amount,
    method: "upi",
    payment_date: D,
    notes: `${SECRET} payment notes`,
    created_at: "2026-05-12T05:00:00.000Z",
    deleted_at: o.deleted ? DELETED_AT : null,
  });
  await insert("payments", [
    payment({ id: PAY1, patient: P1, amount: 3000, appt: A1, treatment: T1 }),
    payment({ id: PAY_DEL, patient: P2, amount: 999, appt: A3, deleted: true }),
    payment({ id: PAYB, clinic: CLINIC_B, patient: PB, amount: 900, appt: AB, treatment: TB }),
  ]);

  await insert("appointment_history", [
    { appointment_id: A1, action: "status_changed", old_value: { status: "in_progress", notes: SECRET }, new_value: { status: "completed", notes: SECRET }, timestamp: "2026-05-12T04:50:00.000Z" },
    { appointment_id: A4, action: "status_changed", old_value: { status: "scheduled" }, new_value: { status: "cancelled" }, timestamp: "2026-05-10T07:00:00.000Z" },
    { appointment_id: A2, action: "rescheduled", old_value: { scheduled_at: "2026-05-25T05:00:00.000Z" }, new_value: { scheduled_at: "2026-05-26T05:00:00.000Z" }, timestamp: "2026-05-12T05:30:00.000Z" },
  ]);

  await insert("reminder_logs", [
    { id: R1, clinic_id: CLINIC_A, patient_id: P1, kind: "recall_invitation", sent_at: "2026-05-10T05:00:00.000Z", sent_by: DENTIST_A },
    { id: RB, clinic_id: CLINIC_B, patient_id: PB, kind: "recall_invitation", sent_at: "2026-05-10T05:00:00.000Z", sent_by: DENTIST_B },
  ]);

  await insert("action_completions", [
    { clinic_id: CLINIC_A, category: "retention", constraint_id: `constraint.retention:${CLINIC_A}:2026-05-11`, completed_at: "2026-05-11T09:00:00.000Z", completed_by: DENTIST_A, source: "declared", target_patient_ids: [P1, P2] },
    // Clinic B's completion names clinic A's patient id. It must never surface in
    // clinic A's ledger, whatever ids it carries.
    { clinic_id: CLINIC_B, category: "retention", constraint_id: `constraint.retention:${CLINIC_B}:2026-05-11`, completed_at: "2026-05-11T09:00:00.000Z", completed_by: DENTIST_B, source: "declared", target_patient_ids: [P1, PB] },
  ]);
}

const ledger = new SupabaseClinicLedger(db, TZ);

/** A signed-in client for a seeded user, subject to RLS. */
async function sessionFor(email: string): Promise<SupabaseClient<Database>> {
  const client = createClient<Database>(URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: "password123" });
  if (error) throw new Error(`sign in ${email}: ${error.message}`);
  return client;
}

function known<T>(t: Traversal<T>): T {
  if (t.status !== "known") throw new Error(`expected known, got ${t.status}: ${"reason" in t ? t.reason : ""}`);
  return t.value;
}
const idsOf = (rows: readonly { id: string }[]) => rows.map((r) => r.id).sort();

async function patientGraph(patientIds: string[], limit = 500): Promise<ClinicLedgerGraph> {
  return buildLedgerGraph(
    await ledger.readPatientLedger({ kind: "patients", clinicId: CLINIC_A, patientIds, asOf: AS_OF, limit }),
  );
}

async function windowSlice(from: string, to: string, clinicId = CLINIC_A): Promise<ClinicLedgerSlice> {
  return ledger.readAppointmentWindow({ kind: "appointment_window", clinicId, from, to, asOf: AS_OF, limit: 500 });
}

function allFacts(slice: ClinicLedgerSlice) {
  return [
    ...slice.patients, ...slice.appointments, ...slice.appointmentEvents, ...slice.treatments,
    ...slice.treatmentEvents, ...slice.queueVisits, ...slice.followUps, ...slice.payments,
    ...slice.reminderSends, ...slice.actionCompletions,
  ];
}

beforeAll(async () => {
  if (LOCAL_UP) await seed();
}, 60_000);

afterAll(async () => {
  if (!LOCAL_UP) return;
  // The clinics stay (append-only audit tables refuse the cascade — see header).
  // Auth users are removable; their profiles cascade with them.
  // Users are fixed and reused; see the note on their ids.
}, 60_000);

// ── 1. The chain ─────────────────────────────────────────────────────────────

describe.skipIf(!LOCAL_UP)("walking the relational chain the snapshot flattens", () => {
  it("patient → appointment → queue → treatment → payment → follow-up → booked visit → completion", async () => {
    const g = await patientGraph([P1, P2]);

    expect(idsOf(known(g.appointmentsOfPatient(P1)))).toEqual([A1, A2].sort());

    const visit = known(g.queueVisitForAppointment(A1));
    expect(visit?.id).toBe(Q1);
    expect(visit?.calledAt).toBe("2026-05-12T04:05:00+00:00");

    expect(idsOf(known(g.treatmentsRecordedAtAppointment(A1)))).toEqual([T1, T2].sort());
    expect(idsOf(known(g.paymentsLinkedToTreatment(T1)))).toEqual([PAY1]);
    expect(idsOf(known(g.followUpsRaisedByTreatment(T1)))).toEqual([F1]);
    expect(idsOf(known(g.appointmentsBookedFromFollowUp(F1)))).toEqual([A2]);
    expect(known(g.originFollowUpOfAppointment(A2))?.id).toBe(F1);

    const completions = known(g.completionsTargetingPatient(P1));
    expect(completions).toHaveLength(1);
    expect([...completions[0].targetPatientIds].sort()).toEqual([P1, P2].sort());
    expect(idsOf(known(g.reminderSendsToPatient(P1)))).toEqual([R1]);
  });

  it("charges a treatment exactly as the billing module does", async () => {
    const g = await patientGraph([P1]);
    const t1 = g.treatment(T1);
    expect(t1?.treatmentType).toBe("Root Canal");
    expect(t1?.charge).toEqual({ treatment: 5000, consultation: 300, radiograph: 0, total: 5300, quoted: 5000 });
    expect(t1?.charge.total).toBe(
      treatmentTotalCharge({ status: "completed", cost: 5000, opd_charged: true, opd_fee: 300, xray_taken: false, xray_cost: 0 }),
    );
    // Planned work owes nothing; its value is still visible as quoted.
    expect(g.treatment(T2)?.charge).toMatchObject({ treatment: 0, total: 0, quoted: 8000 });
  });

  it("extracts status and reschedule facts from audit history without loading the jsonb", async () => {
    const g = await patientGraph([P1, P2]);
    const cancelled = known(g.eventsForAppointment(A4));
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].statusAfter).toBe("cancelled");

    const moved = known(g.eventsForAppointment(A2));
    expect(moved[0].action).toBe("rescheduled");
    expect(moved[0].previousScheduledAt).toBe("2026-05-25T05:00:00.000Z");

    expect(known(g.eventsForTreatment(T2))[0].statusAfter).toBe("planned");
  });

  it("serves the same chain from an appointment window", async () => {
    const g = buildLedgerGraph(await windowSlice(D, D));
    expect(idsOf(known(g.treatmentsRecordedAtAppointment(A1)))).toEqual([T1, T2].sort());
    expect(idsOf(known(g.paymentsLinkedToTreatment(T1)))).toEqual([PAY1]);
    expect(idsOf(known(g.followUpsRaisedByTreatment(T1)))).toEqual([F1]);
    // ...but declines what a window cannot see.
    expect(g.appointmentsBookedFromFollowUp(F1).status).toBe("outside_slice");
    expect(g.paymentsOfPatient(P1).status).toBe("outside_slice");
  });
});

// ── 2. Isolation ─────────────────────────────────────────────────────────────

describe.skipIf(!LOCAL_UP)("tenant isolation", () => {
  it("never returns another clinic's facts, even when they name this clinic's patient", async () => {
    const slice = await ledger.readPatientLedger({ kind: "patients", clinicId: CLINIC_A, patientIds: [P1, P2], asOf: AS_OF, limit: 500 });
    for (const fact of allFacts(slice)) expect(fact.clinicId).toBe(CLINIC_A);
    const ids = new Set(allFacts(slice).map((f) => f.id));
    for (const foreign of [AB, TB, FB, PAYB, RB]) expect(ids.has(foreign)).toBe(false);
    // Clinic B's completion lists P1 as a target; clinic A still sees one completion.
    expect(slice.actionCompletions).toHaveLength(1);
  });

  it("resolves no patient from another clinic, and does not say why", async () => {
    const slice = await ledger.readPatientLedger({ kind: "patients", clinicId: CLINIC_A, patientIds: [PB], asOf: AS_OF, limit: 50 });
    expect(slice.patients).toEqual([]);
    expect(slice.unresolvedPatientIds).toEqual([PB]);
    expect(allFacts(slice)).toEqual([]);

    const reverse = await ledger.readPatientLedger({ kind: "patients", clinicId: CLINIC_B, patientIds: [P1], asOf: AS_OF, limit: 50 });
    expect(reverse.unresolvedPatientIds).toEqual([P1]);
    expect(allFacts(reverse)).toEqual([]);
  });

  it("keeps each clinic's appointment window to itself", async () => {
    const a = await windowSlice(D, D, CLINIC_A);
    const b = await windowSlice(D, D, CLINIC_B);
    expect(a.appointments.map((x) => x.id)).not.toContain(AB);
    expect(b.appointments.map((x) => x.id)).toEqual([AB]);
    for (const fact of allFacts(b)) expect(fact.clinicId).toBe(CLINIC_B);
  });

  it("holds under RLS on a signed-in dentist's own session", async () => {
    const client = await sessionFor(DENTIST_A_EMAIL);
    const asDentist = new SupabaseClinicLedger(client, TZ);

    // Everything the service role sees for clinic A, the dentist sees too —
    // including the history, reminder and completion tables.
    const mine = await asDentist.readPatientLedger({ kind: "patients", clinicId: CLINIC_A, patientIds: [P1, P2], asOf: AS_OF, limit: 500 });
    const service = await ledger.readPatientLedger({ kind: "patients", clinicId: CLINIC_A, patientIds: [P1, P2], asOf: AS_OF, limit: 500 });
    expect(allFacts(mine).map((f) => f.id).sort()).toEqual(allFacts(service).map((f) => f.id).sort());

    // Asking for the other clinic by name gets nothing: RLS hides it even though
    // the scope names it.
    const theirs = await asDentist.readPatientLedger({ kind: "patients", clinicId: CLINIC_B, patientIds: [PB], asOf: AS_OF, limit: 50 });
    expect(allFacts(theirs)).toEqual([]);
    expect(theirs.unresolvedPatientIds).toEqual([PB]);
    const theirWindow = await asDentist.readAppointmentWindow({ kind: "appointment_window", clinicId: CLINIC_B, from: D, to: D, asOf: AS_OF, limit: 50 });
    expect(allFacts(theirWindow)).toEqual([]);
    await client.auth.signOut();
  });
});

// ── 3. Soft deletes ──────────────────────────────────────────────────────────

describe.skipIf(!LOCAL_UP)("soft-delete semantics", () => {
  it("excludes soft-deleted rows from every kind", async () => {
    const slice = await ledger.readPatientLedger({ kind: "patients", clinicId: CLINIC_A, patientIds: [P1, P2], asOf: AS_OF, limit: 500 });
    const ids = new Set(allFacts(slice).map((f) => f.id));
    for (const deleted of [A_DEL, T_DEL, PAY_DEL]) expect(ids.has(deleted)).toBe(false);
  });

  it("propagates liveness to tables with no deleted_at of their own", async () => {
    const slice = await ledger.readPatientLedger({ kind: "patients", clinicId: CLINIC_A, patientIds: [P1, P2], asOf: AS_OF, limit: 500 });
    // A deleted appointment's queue entry, and a deleted treatment's history.
    expect(slice.queueVisits.map((q) => q.id)).not.toContain(Q_DEL);
    expect(slice.treatmentEvents.map((e) => e.treatmentId)).not.toContain(T_DEL);
  });

  it("reports a live patient whose only payment was deleted as having none — the ledger's truth", async () => {
    const g = await patientGraph([P1, P2]);
    expect(known(g.paymentsOfPatient(P2))).toEqual([]);
  });

  it("does not resolve a soft-deleted patient, and does not call their history empty", async () => {
    const slice = await ledger.readPatientLedger({ kind: "patients", clinicId: CLINIC_A, patientIds: [P_DEL], asOf: AS_OF, limit: 50 });
    expect(slice.unresolvedPatientIds).toEqual([P_DEL]);
    expect(buildLedgerGraph(slice).appointmentsOfPatient(P_DEL).status).toBe("outside_slice");
  });

  it("drops a live appointment whose patient is deleted from a window", async () => {
    const slice = await windowSlice("2026-05-13", "2026-05-13");
    expect(slice.appointments.map((a) => a.id)).not.toContain(A_ORPHAN);
    expect(slice.patients.map((p) => p.id)).not.toContain(P_DEL);
  });
});

// ── 4. Agreement with the aggregate path ─────────────────────────────────────

describe.skipIf(!LOCAL_UP)("aggregate and relational paths agree on the same facts", () => {
  let metrics: readonly Metric[] = [];
  let people: ClinicLedgerGraph;
  let day: ClinicLedgerGraph;
  let trailing: ClinicLedgerGraph;

  const metric = (key: string) => metrics.find((m) => m.id.startsWith(`${key}:`))?.value;

  beforeAll(async () => {
    const repository = new SupabaseMetricsDataRepository(db, { asOf: AS_OF });
    metrics = await new DentGrowMetricsEngine(repository).calculateMetrics(CLINIC_A, D);
    people = await patientGraph([P1, P2]);
    day = buildLedgerGraph(await windowSlice(D, D));
    trailing = buildLedgerGraph(await windowSlice(addDays(D, -29), D));
  }, 60_000);

  it("appointments today, cancelled and no-shows", () => {
    const appts = day.slice.appointments;
    expect(appts.length).toBe(metric(MetricKey.APPOINTMENTS_TOTAL_TODAY));
    expect(appts.filter((a) => a.status === "cancelled").length).toBe(metric(MetricKey.APPOINTMENTS_CANCELLED_TODAY));
    expect(appts.filter((a) => a.status === "no_show").length).toBe(metric(MetricKey.APPOINTMENTS_NO_SHOWS_TODAY));
    expect(appts.length).toBe(4);
  });

  it("revenue collected today", () => {
    const collected = people.slice.payments.filter((p) => p.paymentDate === D).reduce((s, p) => s + p.amount, 0);
    expect(collected).toBe(metric(MetricKey.REVENUE_COLLECTED_TODAY));
    expect(collected).toBe(3000);
  });

  it("outstanding balance, clamped per patient", () => {
    let outstanding = 0;
    for (const p of people.slice.patients) {
      const charged = known(people.treatmentsOfPatient(p.id)).reduce((s, t) => s + t.charge.total, 0);
      if (charged === 0) continue;
      const paid = known(people.paymentsOfPatient(p.id)).reduce((s, x) => s + x.amount, 0);
      outstanding += Math.max(0, charged - paid);
    }
    expect(outstanding).toBe(metric(MetricKey.REVENUE_OUTSTANDING));
    expect(outstanding).toBe(2300);
  });

  it("overdue follow-ups", () => {
    const overdue = people.slice.followUps.filter((f) => f.status === "pending" && f.dueDate < D).length;
    expect(overdue).toBe(metric(MetricKey.FOLLOWUPS_OVERDUE));
    expect(overdue).toBe(1);
  });

  it("planned treatment whose patient has no upcoming visit", () => {
    const live = new Set(["scheduled", "checked_in", "in_progress", "completed"]);
    const pending = people.slice.treatments.filter((t) => {
      if (t.status !== "planned") return false;
      const upcoming = known(people.appointmentsOfPatient(t.patientId)).some(
        (a) => live.has(a.status) && Date.parse(a.scheduledAt) > Date.parse(AS_OF),
      );
      return !upcoming;
    });
    expect(pending.length).toBe(metric(MetricKey.TREATMENT_ACCEPTED_PENDING_SCHEDULING));
    expect(pending.map((t) => t.id)).toEqual([T3]);
  });

  it("treatments completed today", () => {
    const completedToday = people.slice.treatments.filter(
      (t) => t.status === "completed" && t.performedAt !== null && t.performedAt.slice(0, 10) === D,
    ).length;
    expect(completedToday).toBe(metric(MetricKey.TREATMENT_COMPLETED_TODAY));
  });

  it("measured visits over the trailing window — an unrecorded call-in is not a measurement", () => {
    const attended = new Set(["checked_in", "in_progress", "completed"]);
    const measured = trailing.slice.appointments.filter((a) => {
      if (!attended.has(a.status)) return false;
      const visit = known(trailing.queueVisitForAppointment(a.id));
      if (!visit || visit.calledAt === null || visit.completedAt === null) return false;
      return Date.parse(visit.completedAt) >= Date.parse(visit.calledAt);
    }).length;
    expect(measured).toBe(metric(MetricKey.SCHEDULING_MEASURED_VISITS_30D));
    // A1 only: A6 was checked in and never called; A_DEL is deleted.
    expect(measured).toBe(1);
  });

  it("repeat non-attenders over the trailing window", () => {
    const misses = new Map<string, number>();
    for (const a of trailing.slice.appointments) {
      if (a.status === "no_show") misses.set(a.patientId, (misses.get(a.patientId) ?? 0) + 1);
    }
    const repeat = [...misses.values()].filter((n) => n >= 2).length;
    expect(repeat).toBe(metric(MetricKey.SCHEDULING_REPEAT_NON_ATTENDERS_30D));
    expect(repeat).toBe(1);
  });
});

// ── 5. Missing stays missing ─────────────────────────────────────────────────

describe.skipIf(!LOCAL_UP)("missing data stays explicitly missing", () => {
  it("keeps unrecorded visit timings null, never zero", async () => {
    const g = await patientGraph([P1, P2]);
    expect(known(g.queueVisitForAppointment(A3))).toBeNull(); // never checked in
    const waiting = known(g.queueVisitForAppointment(A6));
    expect(waiting?.calledAt).toBeNull();
    expect(waiting?.completedAt).toBeNull();
  });

  it("names relationships the schema cannot hold", async () => {
    const g = await patientGraph([P1, P2]);
    expect(g.bookingForPlannedTreatment(T2).status).toBe("not_recorded");
    expect(g.planOfTreatment(T2).status).toBe("not_recorded");
    expect(g.followUpCompletedAt(F1).status).toBe("not_recorded");
    expect(g.contactOutcomeOfReminder(R1).status).toBe("not_recorded");
  });

  it("never presents a truncated read as complete", async () => {
    const slice = await ledger.readPatientLedger({ kind: "patients", clinicId: CLINIC_A, patientIds: [P1], asOf: AS_OF, limit: 1 });
    expect(slice.appointments).toHaveLength(1);
    expect(slice.truncated).toContain(LedgerFactKind.APPOINTMENT);
    // A child whose parent may have been cut is flagged too.
    expect(slice.truncated).toContain(LedgerFactKind.QUEUE_VISIT);
    const g = buildLedgerGraph(slice);
    expect(g.appointmentsOfPatient(P1).status).toBe("outside_slice");
    expect(g.appointmentsBookedFromFollowUp(F1).status).toBe("outside_slice");
  });

  it("excludes what did not exist yet at asOf", async () => {
    // A2 was booked at 05:00Z on D; a slice as of 04:00Z predates the booking.
    const early = await ledger.readPatientLedger({ kind: "patients", clinicId: CLINIC_A, patientIds: [P1], asOf: "2026-05-12T04:00:00.000Z", limit: 500 });
    expect(early.appointments.map((a) => a.id)).not.toContain(A2);
  });

  it("shows why a kind must be withheld: RLS turns 'not permitted' into 'empty'", async () => {
    const client = await sessionFor(RECEPTIONIST_A_EMAIL);
    const scope = { kind: "patients" as const, clinicId: CLINIC_A, patientIds: [P1], asOf: AS_OF, limit: 500 };

    // Without declaring it, a receptionist's read silently comes back empty for
    // the dentist-only completions table...
    const naive = await new SupabaseClinicLedger(client, TZ).readPatientLedger(scope);
    expect(naive.actionCompletions).toEqual([]);

    // ...and declared, the graph refuses to call that "none".
    const honest = await new SupabaseClinicLedger(client, TZ, {
      withhold: [LedgerFactKind.ACTION_COMPLETION],
    }).readPatientLedger(scope);
    expect(honest.withheld).toEqual([LedgerFactKind.ACTION_COMPLETION]);
    const g = buildLedgerGraph(honest);
    expect(g.completionsTargetingPatient(P1).status).toBe("outside_slice");
    // Everything the receptionist may read is still answered.
    expect(known(g.appointmentsOfPatient(P1)).length).toBeGreaterThan(0);
    await client.auth.signOut();
  });

  it("rejects an unbounded or malformed read instead of guessing", async () => {
    await expect(
      ledger.readPatientLedger({ kind: "patients", clinicId: CLINIC_A, patientIds: [P1], asOf: AS_OF, limit: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      ledger.readPatientLedger({
        kind: "patients",
        clinicId: CLINIC_A,
        patientIds: Array.from({ length: MAX_LEDGER_PATIENTS + 1 }, () => crypto.randomUUID()),
        asOf: AS_OF,
        limit: 10,
      }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      ledger.readAppointmentWindow({ kind: "appointment_window", clinicId: CLINIC_A, from: "2026-05-13", to: "2026-05-12", asOf: AS_OF, limit: 10 }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

// ── 6. Data minimisation and read-only ───────────────────────────────────────

describe.skipIf(!LOCAL_UP)("what never crosses into a slice", () => {
  it("carries no names, notes or clinical free text — not even inside audit jsonb", async () => {
    const person = await ledger.readPatientLedger({ kind: "patients", clinicId: CLINIC_A, patientIds: [P1, P2], asOf: AS_OF, limit: 500 });
    const window = await windowSlice(D, D);
    expect(JSON.stringify(person)).not.toContain(SECRET);
    expect(JSON.stringify(window)).not.toContain(SECRET);
  });

  it("writes nothing", async () => {
    const count = async (table: string) => {
      const { count: n } = await raw.from(table).select("id", { count: "exact", head: true }).eq("clinic_id", CLINIC_A);
      return n as number;
    };
    const tables = ["appointments", "treatments", "payments", "follow_ups", "queue_entries", "reminder_logs", "action_completions"];
    const before = await Promise.all(tables.map(count));
    await patientGraph([P1, P2]);
    await windowSlice(addDays(D, -29), D);
    expect(await Promise.all(tables.map(count))).toEqual(before);
  });
});
