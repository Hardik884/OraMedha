#!/usr/bin/env node
/**
 * scripts/seed-demo-clinic.mjs
 *
 * Fills the demo clinic with nine months of plausible activity, so the Business
 * Brain can be reviewed against realistic volume.
 *
 * WHY THIS EXISTS
 *   The allow-listed development clinic had 40 patients and three appointments
 *   in thirty days. At that size every rate is noise, every baseline is too wide
 *   to flag anything, and every win gate correctly stays shut — so the analysis
 *   looks broken when it is working exactly as designed. Reviewing it needs a
 *   clinic with a real shape: busy mornings, quiet Fridays, a seasonal dip, work
 *   that goes unpaid for a while, recalls that fall overdue, and a recent
 *   improvement worth noticing.
 *
 * WHAT IT WILL NOT DO
 *   - Write to any clinic that is not in DEMO_CLINIC_IDS (lib/feature-flags.ts).
 *     The id is checked before anything is inserted, so this can never be
 *     pointed at a real clinic.
 *   - Invent a person. Patients are "Demo Patient 001" with numbers in the
 *     555-prefixed range reserved for fiction, and the clinic is named
 *     "Demo Clinic (sample data)" everywhere it appears.
 *   - Run without being asked: it needs --confirm, and it prints the target
 *     database host first.
 *
 * DETERMINISTIC
 *   One seeded generator, so the same command on the same day produces the same
 *   clinic. The window is measured from today, so a run tomorrow shifts every
 *   date by a day — which is the point: the demo clinic stays current.
 *   --reset removes the generated rows first, so re-running rebuilds rather
 *   than doubling.
 *
 * USAGE
 *   node scripts/seed-demo-clinic.mjs --confirm                  # local stack
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/seed-demo-clinic.mjs --confirm
 *   node scripts/seed-demo-clinic.mjs --confirm --reset          # wipe first
 *   node scripts/seed-demo-clinic.mjs --confirm --admin-only     # see below
 *
 * ENVIRONMENT
 *   DEMO_DENTIST_EMAIL     sign-in address for the demo clinic's dentist
 *   DEMO_DENTIST_PASSWORD  its password; without one the account cannot sign in
 *
 * --admin-only
 *   Marks the demo account as a platform admin. The sign-in doors are split by
 *   audience (actions/auth.ts), and an admin account is refused at the staff
 *   door — so the demo clinic becomes reachable through /admin/login and
 *   nowhere else. It also means the account can open /admin, which shows
 *   platform-wide COUNTS (never patient rows), so give it a real password.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

// ── Target ────────────────────────────────────────────────────────────────────

const LOCAL_URL = "http://127.0.0.1:55321";
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const TARGET_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? LOCAL_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? LOCAL_SERVICE_KEY;

const CLINIC_ID = "d0000000-0000-4000-8000-0000000000d0";
const CLINIC_NAME = "Demo Clinic (sample data)";
const DENTIST_ID = "d0000000-0000-4000-8000-0000000000d1";
const DENTIST_EMAIL = process.env.DEMO_DENTIST_EMAIL ?? "demo-dentist@oramedha.invalid";

/** The demo clinic must be declared in the app, not only here. */
function assertDeclaredDemoClinic() {
  const flags = readFileSync(new URL("../lib/feature-flags.ts", import.meta.url), "utf8");
  const block = flags.slice(flags.indexOf("DEMO_CLINIC_IDS"), flags.indexOf("isDemoClinic"));
  if (!block.includes(CLINIC_ID)) {
    throw new Error(
      `Refusing to run: ${CLINIC_ID} is not in DEMO_CLINIC_IDS (lib/feature-flags.ts). ` +
        "This script only ever writes to a clinic the app knows is sample data.",
    );
  }
}

// ── Deterministic generator ───────────────────────────────────────────────────

/** mulberry32: small, fast, and identical across runs. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = rng(20260918);
const pick = (list) => list[Math.floor(random() * list.length)];
const between = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
const chance = (p) => random() < p;

/** Stable uuids, so a rebuild reuses the same ids instead of piling up rows. */
let counter = 0;
function id(prefix) {
  counter += 1;
  const hex = counter.toString(16).padStart(12, "0");
  return `${prefix}-0000-4000-8000-${hex}`;
}

// ── The clinic's shape ────────────────────────────────────────────────────────

const DAYS = 273; // nine months
const TIMEZONE = "Asia/Kolkata";
const OFFSET_MINUTES = 330; // IST, fixed: India has no DST
/**
 * One chair. `uq_appointments_dentist_slot` allows one live appointment per
 * dentist per slot, and OraMedha has no multi-dentist scheduling yet, so a
 * second chair could not be filled by generated visits without inventing a
 * second dentist the product does not support.
 */
const CHAIRS = 1;
const OPEN_HOUR = 9;
const CLOSE_HOUR = 17;

/** Appointments a weekday carries, before seasonality. Friday is the quiet one. */
const LOAD_BY_WEEKDAY = { 0: 0, 1: 13, 2: 14, 3: 13, 4: 12, 5: 7, 6: 5 };

const TREATMENTS = [
  { type: "Cleaning", cost: 800, minutes: 30, weight: 34, recallDays: 180 },
  { type: "Filling", cost: 1800, minutes: 30, weight: 20, recallDays: null },
  { type: "Root Canal", cost: 6500, minutes: 60, weight: 12, recallDays: 21 },
  { type: "Crown", cost: 9000, minutes: 45, weight: 8, recallDays: 30 },
  { type: "Extraction", cost: 2500, minutes: 30, weight: 9, recallDays: 14 },
  { type: "Scaling", cost: 1200, minutes: 30, weight: 9, recallDays: 180 },
  { type: "Consultation", cost: 300, minutes: 15, weight: 8, recallDays: null },
];
const TREATMENT_PICKER = TREATMENTS.flatMap((t) => Array(t.weight).fill(t));

const SOURCES = ["walk_in", "walk_in", "phone_call", "phone_call", "phone_call", "referral", "website", "other"];

/** An instant from a clinic-local day and time. */
function localInstant(date, hour, minute) {
  return new Date(Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`) - OFFSET_MINUTES * 60_000).toISOString();
}
const plusMinutes = (iso, m) => new Date(Date.parse(iso) + m * 60_000).toISOString();
const dayOf = (iso) => new Date(Date.parse(iso) + OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);

const FUTURE_DAYS = 14;

/** Every clinic-local date from `days` ago to two weeks ahead. */
function dateSeries(days) {
  const out = [];
  const end = new Date();
  for (let i = days; i >= -FUTURE_DAYS; i -= 1) {
    out.push(new Date(end.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * How much of its usual load the clinic carried on a date.
 *
 * A dip through one month (a quiet season), and a recent lift — so the analysis
 * has both a problem to find in the middle of the window and an improvement to
 * recognise at the end of it.
 */
function loadFactor(date, daysAgo) {
  const monthsAgo = daysAgo / 30;
  if (monthsAgo > 4 && monthsAgo < 5.5) return 0.62; // the quiet season
  if (monthsAgo < 0.8 && daysAgo >= 0) return 1.12; // the recent lift
  // Days still ahead are only partly booked, which is what a forward schedule
  // actually looks like — and what the thin-week-ahead signal reads.
  if (daysAgo < 0) return 0.55;
  return 0.9 + random() * 0.2;
}

/** No-shows fall away in the last three weeks: the improvement the wins strip should find. */
function noShowRate(daysAgo) {
  return daysAgo / 30 < 0.8 ? 0.03 : 0.11;
}

// ── Build ─────────────────────────────────────────────────────────────────────

function build() {
  const dates = dateSeries(DAYS);

  const patients = [];
  const appointments = [];
  const history = [];
  const queue = [];
  const treatments = [];
  const payments = [];
  const followUps = [];

  // A roster that grows: some patients registered before the window, the rest
  // arrive through it, so "new patients" and "lapsed" both mean something.
  const PATIENT_COUNT = 420;
  for (let i = 0; i < PATIENT_COUNT; i += 1) {
    const registeredIndex = i < 150 ? -between(30, 400) : Math.floor((i - 150) * (DAYS / (PATIENT_COUNT - 150)));
    const registeredAt =
      registeredIndex < 0
        ? new Date(Date.parse(`${dates[0]}T04:00:00.000Z`) + registeredIndex * 86_400_000).toISOString()
        : localInstant(dates[Math.min(registeredIndex, DAYS - 1)], between(9, 16), 0);
    patients.push({
      id: id("da000000"),
      clinic_id: CLINIC_ID,
      name: `Demo Patient ${String(i + 1).padStart(3, "0")}`,
      // 555 numbers are reserved for fiction; nobody can be called by mistake.
      phone: `555${String(1_000_000 + i).slice(-7)}`,
      gender: pick(["male", "female", "other"]),
      date_of_birth: `19${between(55, 99)}-${String(between(1, 12)).padStart(2, "0")}-${String(between(1, 28)).padStart(2, "0")}`,
      created_at: registeredAt,
      total_visits: 0,
      last_visit: null,
    });
  }

  const slotsPerDay = [];
  for (let h = OPEN_HOUR; h < CLOSE_HOUR; h += 1) for (const m of [0, 30]) slotsPerDay.push([h, m]);

  const todayDate = dayOf(new Date().toISOString());

  dates.forEach((date) => {
    const weekday = new Date(`${date}T12:00:00.000Z`).getUTCDay();
    const base = LOAD_BY_WEEKDAY[weekday];
    if (base === 0) return; // closed Sunday

    const daysAgo = Math.round((Date.parse(`${todayDate}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
    const count = Math.max(0, Math.round(base * loadFactor(date, daysAgo)));
    const missRate = noShowRate(daysAgo);
    /** Visits already placed in each slot. Two chairs means two, never more. */
    const used = new Map();

    for (let n = 0; n < count; n += 1) {
      let slot = pick(slotsPerDay);
      let guard = 0;
      while ((used.get(`${slot[0]}:${slot[1]}`) ?? 0) >= CHAIRS && guard < 12) {
        slot = pick(slotsPerDay);
        guard += 1;
      }
      const key = `${slot[0]}:${slot[1]}`;
      if ((used.get(key) ?? 0) >= CHAIRS) continue; // the day is genuinely full
      used.set(key, (used.get(key) ?? 0) + 1);

      const closesAt = weekday === 5 || weekday === 6 ? 14 : CLOSE_HOUR;
      if (slot[0] >= closesAt) continue;

      const treatment = pick(TREATMENT_PICKER);
      const patient = patients[Math.floor(random() * patients.length)];
      if (Date.parse(patient.created_at) > Date.parse(localInstant(date, slot[0], slot[1]))) continue;

      const scheduledAt = localInstant(date, slot[0], slot[1]);
      const bookedAheadDays = chance(0.35) ? 0 : between(1, 24);
      const appointmentId = id("da100000");

      // Outcome. Days still ahead stay scheduled; the rest resolve.
      let status;
      if (date >= todayDate) status = "scheduled";
      else if (chance(missRate)) status = "no_show";
      else if (chance(0.07)) status = "cancelled";
      else status = "completed";

      appointments.push({
        id: appointmentId,
        clinic_id: CLINIC_ID,
        patient_id: patient.id,
        dentist_id: DENTIST_ID,
        scheduled_at: scheduledAt,
        duration_minutes: treatment.minutes,
        source: pick(SOURCES),
        status,
        created_at: new Date(Date.parse(scheduledAt) - bookedAheadDays * 86_400_000).toISOString(),
      });

      if (status === "cancelled") {
        // Cancelled with real notice, by the front desk. No actor role is
        // invented for a patient who has no portal account here.
        history.push({
          id: id("da200000"),
          appointment_id: appointmentId,
          action: "cancelled",
          old_value: { status: "scheduled" },
          new_value: { status: "cancelled" },
          performed_by: DENTIST_ID,
          timestamp: new Date(Date.parse(scheduledAt) - between(2, 72) * 3_600_000).toISOString(),
        });
      }

      if (status === "no_show") {
        // Most are the nightly job's inference (no actor); some a person marked.
        const inferred = chance(0.7);
        history.push({
          id: id("da200000"),
          appointment_id: appointmentId,
          action: "status_changed",
          old_value: { status: "scheduled" },
          new_value: { status: "no_show" },
          performed_by: inferred ? null : DENTIST_ID,
          timestamp: plusMinutes(scheduledAt, inferred ? 15 * 60 : between(30, 240)),
        });
      }

      if (status !== "completed") continue;

      // The visit itself: arrival, call-in, and how long it really took.
      const arrived = plusMinutes(scheduledAt, between(-12, 20));
      const wait = between(3, 38);
      const calledAt = plusMinutes(arrived, wait);
      const overrun = chance(0.28) ? between(5, 25) : between(-5, 5);
      const completedAt = plusMinutes(calledAt, treatment.minutes + overrun);

      queue.push({
        id: id("da300000"),
        clinic_id: CLINIC_ID,
        appointment_id: appointmentId,
        patient_id: patient.id,
        position: n + 1,
        status: "completed",
        queue_date: date,
        checked_in_at: arrived,
        called_at: calledAt,
        completed_at: completedAt,
      });

      patient.total_visits += 1;
      patient.last_visit = completedAt;

      const treatmentId = id("da400000");
      treatments.push({
        id: treatmentId,
        clinic_id: CLINIC_ID,
        patient_id: patient.id,
        appointment_id: appointmentId,
        treatment_type: treatment.type,
        status: "completed",
        cost: treatment.cost,
        performed_at: completedAt,
        created_at: completedAt,
        opd_charged: treatment.type === "Consultation" ? false : chance(0.25),
        opd_fee: 300,
        xray_taken: chance(0.18),
        xray_cost: 400,
      });

      // Payment: most settle on the day, some run on, a few never arrive. That
      // spread is what makes the collection metrics mean anything.
      if (chance(0.88)) {
        const lag = chance(0.72) ? 0 : between(1, 40);
        const paidDay = new Date(Date.parse(completedAt) + lag * 86_400_000);
        if (paidDay <= new Date()) {
          const full = chance(0.85);
          payments.push({
            id: id("da500000"),
            clinic_id: CLINIC_ID,
            patient_id: patient.id,
            appointment_id: appointmentId,
            treatment_id: treatmentId,
            amount: full ? treatment.cost : Math.round(treatment.cost * 0.5),
            method: pick(["cash", "upi", "upi", "card", "bank_transfer"]),
            payment_date: dayOf(paidDay.toISOString()),
            created_at: paidDay.toISOString(),
          });
        }
      }

      // A recall, where the treatment implies one.
      if (treatment.recallDays !== null && chance(0.7)) {
        const due = new Date(Date.parse(completedAt) + treatment.recallDays * 86_400_000);
        const dueDate = due.toISOString().slice(0, 10);
        const past = due < new Date();
        // Recent recalls are being kept up with; older ones were not.
        const done = past && chance((Date.now() - due.getTime()) / 86_400_000 < 30 ? 0.75 : 0.45);
        followUps.push({
          id: id("da600000"),
          clinic_id: CLINIC_ID,
          patient_id: patient.id,
          appointment_id: appointmentId,
          treatment_id: treatmentId,
          due_date: dueDate,
          status: done ? "completed" : "pending",
          follow_up_type: treatment.type === "Cleaning" || treatment.type === "Scaling" ? "cleaning" : "review",
          confirmation_status: "confirmed",
          notes: `${treatment.type} review`,
          created_at: completedAt,
          updated_at: done ? new Date(due.getTime() + 86_400_000).toISOString() : completedAt,
        });
      }
    }
  });

  // Work planned and not yet booked: the treatment pipeline.
  const plannedFor = patients.filter(() => chance(0.06)).slice(0, 40);
  for (const patient of plannedFor) {
    const treatment = pick(TREATMENT_PICKER.filter((t) => t.cost > 1500));
    const lastVisit = appointments.find((a) => a.patient_id === patient.id && a.status === "completed");
    if (!lastVisit) continue;
    treatments.push({
      id: id("da400000"),
      clinic_id: CLINIC_ID,
      patient_id: patient.id,
      appointment_id: lastVisit.id,
      treatment_type: treatment.type,
      status: "planned",
      cost: treatment.cost,
      performed_at: null,
      created_at: new Date(Date.now() - between(10, 120) * 86_400_000).toISOString(),
      opd_charged: false,
      opd_fee: 300,
      xray_taken: false,
      xray_cost: 400,
    });
  }

  return { patients, appointments, history, queue, treatments, payments, followUps };
}

// ── Write ─────────────────────────────────────────────────────────────────────

const db = createClient(TARGET_URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function insertAll(table, rows, chunk = 500) {
  for (let i = 0; i < rows.length; i += chunk) {
    const { error } = await db.from(table).insert(rows.slice(i, i + chunk));
    if (error) throw new Error(`${table}: ${error.message}`);
  }
  console.log(`  ${table.padEnd(20)} ${rows.length}`);
}

async function wipe() {
  // Only ever this clinic's rows, children first.
  for (const table of ["payments", "follow_ups", "queue_entries", "treatments"]) {
    const { error } = await db.from(table).delete().eq("clinic_id", CLINIC_ID);
    if (error) throw new Error(`wipe ${table}: ${error.message}`);
  }
  const { data: appts } = await db.from("appointments").select("id").eq("clinic_id", CLINIC_ID);
  const ids = (appts ?? []).map((a) => a.id);
  for (let i = 0; i < ids.length; i += 200) {
    await db.from("appointment_history").delete().in("appointment_id", ids.slice(i, i + 200));
  }
  for (const table of ["appointments", "patients", "metric_history", "finding_snapshots", "clinic_memory_builds", "action_completions"]) {
    const { error } = await db.from(table).delete().eq("clinic_id", CLINIC_ID);
    if (error && !/does not exist/i.test(error.message)) throw new Error(`wipe ${table}: ${error.message}`);
  }
  console.log("  wiped the demo clinic's generated rows");
}

async function ensureClinic(adminOnly) {
  const { error: clinicErr } = await db
    .from("clinics")
    .upsert({ id: CLINIC_ID, name: CLINIC_NAME, dentist_name: "Dr Demo (sample data)" });
  if (clinicErr) throw new Error(`clinics: ${clinicErr.message}`);

  const hours = { open: "09:00", close: "17:00", is_open: true };
  const closed = { open: null, close: null, is_open: false };
  const { error: settingsErr } = await db.from("clinic_settings").upsert({
    clinic_id: CLINIC_ID,
    clinic_name: CLINIC_NAME,
    timezone: TIMEZONE,
    average_appointment_duration: 30,
    chair_count: CHAIRS,
    clinic_hours: {
      monday: hours, tuesday: hours, wednesday: hours, thursday: hours,
      friday: { open: "09:00", close: "14:00", is_open: true },
      saturday: { open: "10:00", close: "14:00", is_open: true },
      sunday: closed,
    },
  });
  if (settingsErr) throw new Error(`clinic_settings: ${settingsErr.message}`);

  // A dentist to hang the appointments on. Its own auth user, so the profile's
  // foreign key holds and nothing borrows a real account.
  //
  // The password comes from DEMO_DENTIST_PASSWORD or the account gets none it
  // can sign in with. A demo clinic still lives on a real project, so this
  // script never invents a password someone could guess, and never prints one.
  const password = process.env.DEMO_DENTIST_PASSWORD;
  const { data: existing } = await db.auth.admin.getUserById(DENTIST_ID);
  if (!existing?.user) {
    const { error } = await db.auth.admin.createUser({
      id: DENTIST_ID,
      email: DENTIST_EMAIL,
      // Kept well inside bcrypt's 72-byte limit.
      password: password ?? `unset-${crypto.randomUUID()}`,
      email_confirm: true,
      user_metadata: { full_name: "Dr Demo (sample data)" },
    });
    if (error && !/already/i.test(error.message)) {
      throw new Error(`demo dentist: ${error.message || JSON.stringify(error)}`);
    }
  } else if (password) {
    const { error } = await db.auth.admin.updateUserById(DENTIST_ID, { password });
    if (error) throw new Error(`demo dentist password: ${error.message}`);
  }
  const { error: profileErr } = await db.from("profiles").upsert({
    id: DENTIST_ID,
    clinic_id: CLINIC_ID,
    full_name: "Dr Demo (sample data)",
    role: "dentist",
    // An admin account is refused at the staff door, so this is what makes the
    // demo clinic reachable only through /admin/login.
    is_admin: adminOnly,
  });
  if (profileErr) throw new Error(`profiles: ${profileErr.message}`);

  const rules = [1, 2, 3, 4].map((d) => ({ clinic_id: CLINIC_ID, day_of_week: d, start_time: "09:00", end_time: "17:00", slot_duration_minutes: 30, is_active: true }));
  rules.push({ clinic_id: CLINIC_ID, day_of_week: 5, start_time: "09:00", end_time: "14:00", slot_duration_minutes: 30, is_active: true });
  rules.push({ clinic_id: CLINIC_ID, day_of_week: 6, start_time: "10:00", end_time: "14:00", slot_duration_minutes: 30, is_active: true });
  const { count } = await db.from("availability_rules").select("id", { count: "exact", head: true }).eq("clinic_id", CLINIC_ID);
  if ((count ?? 0) === 0) {
    const { error } = await db.from("availability_rules").insert(rules);
    if (error) throw new Error(`availability_rules: ${error.message}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes("--confirm")) {
    console.log(
      `Refusing to run without --confirm.\n\n` +
        `  target   ${new URL(TARGET_URL).host}\n` +
        `  clinic   ${CLINIC_NAME} (${CLINIC_ID})\n\n` +
        `This writes generated patients, visits and payments to that clinic only.\n` +
        `  node scripts/seed-demo-clinic.mjs --confirm [--reset]\n`,
    );
    process.exit(1);
  }
  assertDeclaredDemoClinic();

  const adminOnly = args.includes("--admin-only");
  console.log(
    `Seeding ${CLINIC_NAME} on ${new URL(TARGET_URL).host}` +
      (adminOnly ? " — reachable through /admin/login only" : ""),
  );
  await ensureClinic(adminOnly);
  if (args.includes("--reset")) await wipe();

  const data = build();
  await insertAll("patients", data.patients);
  await insertAll("appointments", data.appointments);
  await insertAll("appointment_history", data.history);
  await insertAll("queue_entries", data.queue);
  await insertAll("treatments", data.treatments);
  await insertAll("payments", data.payments);
  await insertAll("follow_ups", data.followUps);

  // The roster's own counters, which the app maintains on completion.
  for (let i = 0; i < data.patients.length; i += 200) {
    const batch = data.patients.slice(i, i + 200).filter((p) => p.total_visits > 0);
    for (const p of batch) {
      await db.from("patients").update({ total_visits: p.total_visits, last_visit: p.last_visit }).eq("id", p.id);
    }
  }

  console.log(
    `\nDone. Sign in as ${DENTIST_EMAIL}` +
      (adminOnly ? ` at /admin/login (the staff door refuses admin accounts)` : ` at /login`) +
      `, then open /dentist/business-brain.\n` +
      (process.env.DEMO_DENTIST_PASSWORD
        ? `That account's password was set from DEMO_DENTIST_PASSWORD.\n`
        : `It has no password it can sign in with — re-run with DEMO_DENTIST_PASSWORD=… to set one.\n`) +
      `The first load measures and stores 35 days of history, so it is slow once, then quick.\n`,
  );
}

main().catch((error) => {
  console.error(`\nFailed: ${error.message}`);
  process.exit(1);
});
