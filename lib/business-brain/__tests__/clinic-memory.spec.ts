/**
 * Clinic Memory against the LOCAL Supabase stack. Skips, loudly, when it is not
 * reachable.
 *
 * Two clinics whose stored histories are deliberately different:
 *
 *   A  steady: an overdue list around 20, quiet Fridays, recall problems that come
 *      back every three weeks, lost appointments concentrated in evenings, and
 *      recall outreach that repeatedly works when done — but is done on few of the
 *      days it is recommended
 *   B  changed: the overdue list jumped from 20 to 40 on 1 August, no weekday
 *      pattern, recall outreach followed by nothing, and six weeks of recall
 *      recommendations nobody acted on
 *
 * Checked on real rows: what each clinic remembers, rebuild determinism and the
 * stored build, RLS versus service role, isolation, decisions and their
 * append-only audit, soft deletes, withheld evidence, patient minimisation, and
 * which tables a build and a dashboard read touch.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { addDays, MetricKey, type ClinicMemory, type ClinicMemoryEntry, type MemoryType } from "@/business-brain";
import { ClinicMemoryReader } from "@/business-brain/memory";
import type { Database } from "@/types/database.types";
import {
  buildClinicMemory,
  persistClinicMemory,
  readClinicDecisions,
  readLatestClinicMemory,
  recordClinicDecision,
} from "../clinic-memory";

const URL = process.env.SUPABASE_TEST_URL ?? "http://127.0.0.1:55321";
const KEY =
  process.env.SUPABASE_TEST_SERVICE_KEY ??
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
if (!LOCAL_UP) console.warn(`\n[clinic-memory] SKIPPED — local Supabase not reachable at ${URL}.\n`);

const db: SupabaseClient<Database> = createClient<Database>(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
/* eslint-disable @typescript-eslint/no-explicit-any */
const raw = db as any;
async function insert(table: string, values: unknown) {
  const { error } = await raw.from(table).insert(values);
  if (error) throw new Error(`seed ${table}: ${error.message}`);
}

const TZ = "Asia/Kolkata";
const D = "2026-09-14";
const NOW = "2026-09-15T06:00:00.000Z";
const id = () => crypto.randomUUID();
const RUN = id().slice(0, 8);
const OVERDUE = MetricKey.FOLLOWUPS_OVERDUE;
const APPOINTMENTS = MetricKey.APPOINTMENTS_TOTAL_TODAY;

interface ClinicFixture {
  readonly clinic: string;
  readonly dentist: string;
  readonly email: string;
  readonly patients: readonly string[];
}

function fixture(label: "a" | "b"): ClinicFixture {
  return { clinic: id(), dentist: `7f6a0000-0000-4000-8000-0000000000${label}1`, email: `memory-${label}@test.local`, patients: Array.from({ length: 50 }, id) };
}
const A = fixture("a");
const B = fixture("b");

const A_DATES = ["2026-05-04", "2026-05-25", "2026-06-15", "2026-07-06", "2026-07-27"];
const B_DATES = ["2026-04-27", "2026-05-18", "2026-06-08", "2026-06-29", "2026-07-20", "2026-07-27"];

const at = (date: string, plusDays = 0) => new Date(Date.parse(`${date}T04:30:00.000Z`) + plusDays * 86_400_000).toISOString();
const dayNumber = (date: string) => Math.round(Date.parse(`${date}T00:00:00.000Z`) / 86_400_000);
const noisy = (centre: number, date: string) => centre + ((dayNumber(date) % 3) - 1);
const weekday = (date: string) => new Date(`${date}T12:00:00.000Z`).getUTCDay();

async function seedBase(f: ClinicFixture) {
  const { error } = await raw.auth.admin.createUser({ id: f.dentist, email: f.email, password: "password123", email_confirm: true });
  if (error && !/already/i.test(error.message)) throw new Error(`seed user: ${error.message}`);
  await insert("clinics", { id: f.clinic, name: `Memory ${RUN}` });
  await insert("clinic_settings", { clinic_id: f.clinic, clinic_name: "Memory", timezone: TZ, average_appointment_duration: 30, chair_count: 1 });
  const { error: profileError } = await raw.from("profiles").upsert({ id: f.dentist, clinic_id: f.clinic, full_name: "Memory Dentist", role: "dentist" });
  if (profileError) throw new Error(`seed profiles: ${profileError.message}`);
  await insert(
    "patients",
    f.patients.map((pid, i) => ({
      id: pid,
      clinic_id: f.clinic,
      name: `Memory ${i}`,
      phone: `99900500${String(i).padStart(2, "0")}`,
      created_at: "2026-01-01T00:00:00.000Z",
      deleted_at: i === 48 ? "2026-06-01T00:00:00.000Z" : null,
    })),
  );
}

async function seedMetrics(f: ClinicFixture, overdue: (d: string) => number, appointments: (d: string) => number) {
  const rows: Record<string, unknown>[] = [];
  for (let d = "2026-03-30"; d <= D; d = addDays(d, 1)) {
    rows.push({ clinic_id: f.clinic, metric_date: d, metric_key: OVERDUE, value: overdue(d), measured_at: `${d}T18:00:00.000Z` });
    rows.push({ clinic_id: f.clinic, metric_date: d, metric_key: APPOINTMENTS, value: appointments(d), measured_at: `${d}T18:00:00.000Z` });
  }
  await insert("metric_history", rows);
}

function finding(f: ClinicFixture, category: string, date: string, rootCauses?: unknown[]) {
  return {
    findingId: `finding.problem:constraint.${category}:${f.clinic}:${date}`,
    kind: "problem",
    polarity: "negative",
    category,
    role: "top",
    rank: 1,
    severity: "high",
    actionable: true,
    suppressed: false,
    ...(rootCauses === undefined ? {} : { rootCauses }),
  };
}

async function seedSnapshots(f: ClinicFixture, from: string, build: (i: number, date: string) => unknown[]) {
  const rows: Record<string, unknown>[] = [];
  let i = 0;
  // recorded_at pinned to the business day, for the same reason as completionRow's created_at.
  for (let d = from; d <= D; d = addDays(d, 1)) rows.push({ clinic_id: f.clinic, business_date: d, findings: build(i++, d), recorded_at: `${d}T04:01:00.000Z` });
  await insert("finding_snapshots", rows);
}

function completionRow(f: ClinicFixture, date: string, targets: readonly string[]) {
  return {
    id: id(),
    clinic_id: f.clinic,
    category: "retention",
    constraint_id: `constraint.retention:${f.clinic}:${date}`,
    completed_at: at(date),
    // Recorded when it was completed, as the app records it. Left to default, the
    // row would be recorded "now" and the as-of readers would rightly ignore it
    // once the real clock passes the fixture's dates.
    created_at: at(date),
    completed_by: f.dentist,
    source: "declared",
    target_patient_ids: targets,
    metric_key: OVERDUE,
    metric_value: 20,
  };
}

const followUp = (f: ClinicFixture, patient: string, completedAt: string, deleted = false) => ({
  id: id(),
  clinic_id: f.clinic,
  patient_id: patient,
  due_date: "2026-04-01",
  status: "completed",
  created_at: "2026-03-15T00:00:00.000Z",
  updated_at: completedAt,
  deleted_at: deleted ? "2026-08-01T00:00:00.000Z" : null,
});

async function seedA() {
  await seedBase(A);
  const low = new Set(A_DATES.map((d) => addDays(d, 14)));
  await seedMetrics(A, (d) => (low.has(d) ? 12 : noisy(20, d)), (d) => (weekday(d) === 0 ? 0 : weekday(d) === 5 ? 3 : noisy(10, d)));
  const evening = [{ question: "attrition", outcome: "explained", associations: [{ dimension: "session", group: "2" }] }];
  await seedSnapshots(A, "2026-05-01", (i, d) => [...(i % 20 < 5 ? [finding(A, "retention", d)] : []), finding(A, "scheduling", d, evening)]);
  await insert(
    "action_completions",
    A_DATES.map((d, i) => completionRow(A, d, [...A.patients.slice(i * 8, i * 8 + 8), ...(i === 0 ? [A.patients[48]] : [])])),
  );
  const followUps: Record<string, unknown>[] = [];
  A_DATES.forEach((d, i) => {
    const targets = A.patients.slice(i * 8, i * 8 + 8);
    targets.slice(0, 7).forEach((p, k) => followUps.push(followUp(A, p, at(d, k + 1))));
    followUps.push(followUp(A, targets[7], at(d, 2), true));
    if (i === 0) followUps.push(followUp(A, A.patients[48], at(d, 1)));
  });
  await insert("follow_ups", followUps);
}

async function seedB() {
  await seedBase(B);
  await seedMetrics(B, (d) => (d < "2026-08-01" ? noisy(20, d) : noisy(40, d)), (d) => (weekday(d) === 0 ? 0 : noisy(10, d)));
  await seedSnapshots(B, "2026-08-01", (_i, d) => [finding(B, "retention", d)]);
  await insert("action_completions", B_DATES.map((d, i) => completionRow(B, d, B.patients.slice(i * 8, i * 8 + 8))));
}

const find = (m: ClinicMemory, type: MemoryType, key: string, qualifier: string | null = null): ClinicMemoryEntry | undefined =>
  m.entries.find((e) => e.type === type && e.subject.key === key && e.subject.qualifier === qualifier);

async function signIn(f: ClinicFixture): Promise<SupabaseClient<Database>> {
  const client = createClient<Database>(URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email: f.email, password: "password123" });
  if (error) throw new Error(`sign in: ${error.message}`);
  return client;
}

/** Wrap a client so every table it touches is recorded. */
function recording(client: SupabaseClient<Database>): { client: SupabaseClient<Database>; tables: string[] } {
  const tables: string[] = [];
  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "from") {
        return (table: string) => {
          tables.push(table);
          return target.from(table as never);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { client: proxy, tables };
}

beforeAll(async () => {
  if (!LOCAL_UP) return;
  await seedA();
  await seedB();
}, 120_000);

// In order, never shuffled: the later tests add evidence to the same two clinics
// (a decision, rows recorded after D) that the earlier ones compare against.
describe.skipIf(!LOCAL_UP)("clinic memory on real stored history", { shuffle: false }, () => {
  let a: ClinicMemory;
  let b: ClinicMemory;
  beforeAll(async () => {
    [a, b] = await Promise.all([buildClinicMemory(db, A.clinic, D, TZ, NOW), buildClinicMemory(db, B.clinic, D, TZ, NOW)]);
  }, 60_000);

  it("A remembers a steady range, quiet Fridays, recurring recall problems, evening attrition and outreach that works", () => {
    expect(a.coverage.gaps).toEqual([]);
    expect(find(a, "normal_range", OVERDUE)).toMatchObject({ status: "active", facts: { median: 20, lower: 16, upper: 24 } });
    expect(find(a, "weekday_pattern", APPOINTMENTS, "5")).toMatchObject({ status: "active", facts: { side: "low", weekdayMedian: 3 } });
    expect(find(a, "recurring_problem", "retention")).toMatchObject({ status: "active", facts: { episodes: 7, typicalResolutionDays: 5 } });
    expect(find(a, "recurring_root_cause", "attrition.session", "2")?.status).toBe("active");
    // Seeded after the fact, so the outreach can only be remembered at the level
    // its evidence reaches: observed after, never likely or strong. See
    // action-learning.spec.ts for why each requirement stops there.
    expect(find(a, "action_effective", "retention")).toMatchObject({ status: "active", facts: { level: "observed", outcomes: 5 } });
    expect(a.entries.filter((e) => e.type === "historical_change")).toEqual([]);
    // Outreach works when it is done, AND recall problems were recommended on far
    // more days than it was done: two separate patterns, both kept.
    // No time-to-result memory: none of the closures is a result it can show was
    // a record of the visit itself.
    expect(a.entries.map((e) => `${e.type}:${e.status}`).filter((t) => t.startsWith("action_"))).toEqual([
      "action_effective:active",
      "action_ignored:active",
    ]);
  });

  it("B remembers a level shift that superseded its old range, outreach with no change, and ignored recommendations", () => {
    expect(find(b, "historical_change", OVERDUE, "2026-08-01")).toMatchObject({ status: "active", facts: { direction: "up", beforeMedian: 20, afterMedian: 40 } });
    const current = find(b, "normal_range", OVERDUE);
    expect(current).toMatchObject({ status: "active", facts: { median: 40 } });
    expect(find(b, "normal_range", OVERDUE, "2026-08-01")).toMatchObject({ status: "superseded", supersededBy: current?.id });
    expect(find(b, "action_no_change", "retention")?.status).toBe("active");
    expect(find(b, "action_ignored", "retention")?.status).toBe("active");
    expect(b.entries.some((e) => e.type === "weekday_pattern" || e.type === "recurring_problem" || e.type === "action_effective")).toBe(false);
  });

  it("counts no result it cannot show is a record of the event, and none from a soft-deleted patient or follow-up", () => {
    // Seven closures per action are on record (the deleted patient and deleted
    // follow-ups would have made it eight), but closures read from current rows
    // cannot be shown to be records of an attended visit, so none is a result.
    expect(find(a, "action_effective", "retention")?.facts.results).toBe(0);
  });

  it("rebuilds the same memory from the same evidence, stores it once, and reads back the same build", async () => {
    const again = await buildClinicMemory(db, A.clinic, D, TZ, NOW);
    expect(again).toEqual(a);
    expect(again.digest).toBe(a.digest);
    expect(await persistClinicMemory(db, a)).toBe(true);
    expect(await persistClinicMemory(db, again)).toBe(false);
    expect(await readLatestClinicMemory(db, A.clinic)).toEqual(a);
    const { error } = await raw.from("clinic_memory_builds").update({ digest: "tampered" }).eq("clinic_id", A.clinic);
    expect(error?.message).toMatch(/append-only/);
  });

  it("gives a dentist's own session under RLS the same memory as the service role", async () => {
    const client = await signIn(A);
    expect(await buildClinicMemory(client, A.clinic, D, TZ, NOW)).toEqual(a);
    await client.auth.signOut();
  });

  it("keeps each clinic's memory to itself", async () => {
    expect(JSON.stringify(a)).not.toContain(B.clinic);
    expect(JSON.stringify(b)).not.toContain(A.clinic);
    const client = await signIn(B);
    // B's dentist can neither read A's stored memory nor derive it from A's evidence.
    await persistClinicMemory(db, a).catch(() => undefined);
    expect(await readLatestClinicMemory(client, A.clinic)).toBeNull();
    expect((await buildClinicMemory(client, A.clinic, D, TZ, NOW)).entries).toEqual([]);
    await client.auth.signOut();
  });

  it("stores no patient identifier and no prose", async () => {
    await persistClinicMemory(db, b);
    const { data } = await raw.from("clinic_memory_builds").select("memory").in("clinic_id", [A.clinic, B.clinic]);
    const text = JSON.stringify(data);
    for (const pid of [...A.patients, ...B.patients]) expect(text).not.toContain(pid);
    const strings = (v: unknown): string[] =>
      typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : typeof v === "object" && v !== null ? Object.values(v).flatMap(strings) : [];
    for (const s of strings(data)) expect(s).toMatch(/^[A-Za-z0-9_.:-]+$/);
  });

  it("derives no positive memory from withheld completions", async () => {
    const withheld = await buildClinicMemory(db, A.clinic, D, TZ, NOW, { withhold: ["action_completion"] });
    expect(withheld.coverage.gaps).toEqual(["action_completion", "completion_confirmation"]);
    expect(withheld.entries.filter((e) => e.type.startsWith("action_"))).toEqual([]);
    // Memory that does not rest on completions is unaffected.
    expect(find(withheld, "weekday_pattern", APPOINTMENTS, "5")).toEqual(find(a, "weekday_pattern", APPOINTMENTS, "5"));
  });

  it("records decisions apart from derived memory, only through the server, with no prose and no foreign target", async () => {
    const proposal = `proposal.action_preference:learning.repeated_improvement:retention:${A.clinic}`;
    const decision = (over: Partial<Parameters<typeof recordClinicDecision>[1]> = {}) => ({
      clinicId: A.clinic,
      decidedBy: A.dentist,
      target: { type: "proposal" as const, id: proposal },
      proposalKind: "action_preference",
      subject: "retention",
      decision: "accepted" as const,
      basis: { level: "strong_evidence", outcomes: 5 },
      ...over,
    });
    // The server action writes with the service role after re-deriving the proposal.
    await recordClinicDecision(db, decision());
    // And one decided during D itself, so the build for D includes a decision
    // whatever day this test runs on: a build only reflects decisions already
    // made by the end of its day.
    await insert("clinic_decisions", {
      clinic_id: A.clinic,
      target_type: "proposal",
      target_id: proposal,
      proposal_kind: "action_preference",
      subject: "retention",
      decision: "accepted",
      basis: { level: "strong_evidence", outcomes: 5 },
      decided_by: A.dentist,
      decided_at: `${D}T06:00:00.000Z`,
    });

    // A signed-in dentist cannot write a decision directly, even for their own clinic.
    const client = await signIn(A);
    await expect(recordClinicDecision(client, decision({ decision: "rejected" }))).rejects.toThrow();
    await client.auth.signOut();

    // And the database refuses what must never be stored, whoever writes it.
    await expect(recordClinicDecision(db, decision({ target: { type: "memory", id: "call Mrs Rao about her crown" }, proposalKind: null }))).rejects.toThrow();
    await expect(recordClinicDecision(db, decision({ basis: { note: "Mrs Rao prefers evenings" } }))).rejects.toThrow();
    await expect(
      recordClinicDecision(db, decision({ target: { type: "proposal", id: `proposal.action_preference:learning.repeated_improvement:retention:${B.clinic}` } })),
    ).rejects.toThrow();

    const withDecision = await buildClinicMemory(db, A.clinic, D, TZ, NOW);
    expect(withDecision.entries).toEqual(a.entries);
    const reader = ClinicMemoryReader.for(A.clinic, withDecision);
    // Accepted on strong evidence the clinic's records no longer support point in
    // time: flagged for review, never silently kept or dropped.
    expect(reader.acceptedPreferences()).toEqual([expect.objectContaining({ target: { type: "proposal", id: proposal }, needsReview: true })]);
    // A build for the day before knows nothing of a decision made afterwards.
    const dayBefore = await buildClinicMemory(db, A.clinic, addDays(D, -1), TZ, NOW);
    expect(ClinicMemoryReader.for(A.clinic, dayBefore).acceptedPreferences()).toEqual([]);
    expect((await readClinicDecisions(db, B.clinic)).length).toBe(0);
    const { error } = await raw.from("clinic_decisions").update({ decision: "rejected" }).eq("clinic_id", A.clinic);
    expect(error?.message).toMatch(/append-only/);
  });

  it("rebuilds a past day identically however much later it is rebuilt", async () => {
    // Evidence recorded after the day the build describes must not change it. B
    // gains an outreach two days before D whose results arrive over the following
    // week: on D its window is still open, and a rebuild in November must say so
    // rather than count results nobody could have known about on D.
    const later = "2026-11-30T06:00:00.000Z";
    const targets = B.patients.slice(40, 48);
    await insert("action_completions", [completionRow(B, addDays(D, -2), targets)]);
    await insert("follow_ups", [
      followUp(B, targets[0], at(addDays(D, -1))),
      ...targets.slice(1).map((p, k) => followUp(B, p, at(D, k + 1))),
      followUp(A, A.patients[7], "2026-10-20T04:30:00.000Z"),
    ]);
    const [rebuiltA, onTimeA] = await Promise.all([buildClinicMemory(db, A.clinic, D, TZ, later), buildClinicMemory(db, A.clinic, D, TZ, NOW)]);
    expect(rebuiltA.digest).toBe(onTimeA.digest);
    const [rebuiltB, onTimeB] = await Promise.all([buildClinicMemory(db, B.clinic, D, TZ, later), buildClinicMemory(db, B.clinic, D, TZ, NOW)]);
    expect(rebuiltB.entries).toEqual(onTimeB.entries);
    expect(rebuiltB.digest).toBe(onTimeB.digest);
  });

  it("builds from stored evidence only, and a dashboard read is one row from one table", async () => {
    const built = recording(db);
    await buildClinicMemory(built.client, A.clinic, D, TZ, NOW);
    expect([...new Set(built.tables)].sort()).toEqual([
      "action_completions",
      "clinic_decisions",
      "entity_history_capture",
      "finding_snapshots",
      "follow_ups",
      "metric_history",
      "patients",
      "problem_dismissals",
    ]);
    const read = recording(db);
    await readLatestClinicMemory(read.client, A.clinic);
    expect(read.tables).toEqual(["clinic_memory_builds"]);
  });
});
