/**
 * Action → Outcome → Learning against the LOCAL Supabase stack. Skips, loudly,
 * when it is not reachable.
 *
 * Two clinics with different histories, read through the real adapter:
 *
 *   A  recall outreach done five times over three months, each followed within
 *      days by most targeted follow-ups completing and the overdue list dropping
 *      well beyond its normal variation — plus one completion this week
 *   B  recall outreach done six times with nothing following, and a month of
 *      briefings recommending it that nobody acted on
 *
 * Checked on real rows: the attribution rungs, the learnings and their
 * thresholds, soft deletes, withheld reads, RLS, clinic isolation, the
 * append-only snapshot, and that an outcome short of the new rungs is exactly
 * what the existing loader returns.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import {
  addDays,
  buildMetric,
  deriveLearning,
  inputsFromHistory,
  LearningKind,
  MetricKey,
  OutcomeAttribution,
  type ClinicLearning,
  type Finding,
  type Outcome,
} from "@/business-brain";
import { deriveOutcomes } from "@/business-brain/engines/outcome";
import { todayFinding } from "@/business-brain/engines/learning/__tests__/learning-fixtures";
import type { Database } from "@/types/database.types";
import { SupabaseActionHistory } from "../action-history";
import { loadActionLearning, loadActionOutcomes } from "../action-outcomes";
import { recordFindingSnapshot } from "../finding-snapshots";

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
if (!LOCAL_UP) console.warn(`\n[action-learning] SKIPPED — local Supabase not reachable at ${URL}.\n`);

const db: SupabaseClient<Database> = createClient<Database>(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
/* eslint-disable @typescript-eslint/no-explicit-any */
const raw = db as any;
async function insert(table: string, values: unknown) {
  const { error } = await raw.from(table).insert(values);
  if (error) throw new Error(`seed ${table}: ${error.message}`);
}

const TZ = "Asia/Kolkata";
const D = "2026-09-14";
const NOW = "2026-09-14T12:00:00.000Z";
const id = () => crypto.randomUUID();
const RUN = id().slice(0, 8);
const OVERDUE = MetricKey.FOLLOWUPS_OVERDUE;

interface ClinicFixture {
  readonly clinic: string;
  readonly dentist: string;
  readonly email: string;
  readonly patients: readonly string[];
}

function fixture(label: "a" | "b"): ClinicFixture {
  return {
    clinic: id(),
    dentist: `7e5a0000-0000-4000-8000-0000000000${label}1`,
    email: `learning-${label}@test.local`,
    patients: Array.from({ length: 50 }, id),
  };
}
const A = fixture("a");
const B = fixture("b");

const A_DATES = ["2026-05-04", "2026-05-25", "2026-06-15", "2026-07-06", "2026-07-27"];
const A_RECENT = "2026-09-10";
const B_DATES = ["2026-04-27", "2026-05-18", "2026-06-08", "2026-06-29", "2026-07-20", "2026-08-10"];

/** 10:00 in Kolkata on a date, so the clinic-local date is that date. */
const at = (date: string, plusDays = 0) => new Date(Date.parse(`${date}T04:30:00.000Z`) + plusDays * 86_400_000).toISOString();
const dayNumber = (date: string) => Math.round(Date.parse(`${date}T00:00:00.000Z`) / 86_400_000);
const noisy = (centre: number, date: string) => centre + ((dayNumber(date) % 3) - 1);

async function seedBase(f: ClinicFixture) {
  const { error } = await raw.auth.admin.createUser({ id: f.dentist, email: f.email, password: "password123", email_confirm: true });
  if (error && !/already/i.test(error.message)) throw new Error(`seed user: ${error.message}`);
  await insert("clinics", { id: f.clinic, name: `Learning ${RUN}` });
  await insert("clinic_settings", { clinic_id: f.clinic, clinic_name: "Learning", timezone: TZ, average_appointment_duration: 30, chair_count: 1 });
  const { error: profileError } = await raw.from("profiles").upsert({ id: f.dentist, clinic_id: f.clinic, full_name: "Learning Dentist", role: "dentist" });
  if (profileError) throw new Error(`seed profiles: ${profileError.message}`);
  await insert(
    "patients",
    f.patients.map((pid, i) => ({
      id: pid,
      clinic_id: f.clinic,
      name: `Learning ${i}`,
      phone: `99900400${String(i).padStart(2, "0")}`,
      created_at: "2026-01-01T00:00:00.000Z",
      // Patient 48 was soft-deleted after being targeted.
      deleted_at: i === 48 ? "2026-06-01T00:00:00.000Z" : null,
    })),
  );
}

async function seedMetrics(f: ClinicFixture, lowDates: readonly string[]) {
  const low = new Set(lowDates);
  const rows: Record<string, unknown>[] = [];
  for (let d = "2026-04-01"; d <= addDays(D, -1); d = addDays(d, 1)) {
    rows.push({ clinic_id: f.clinic, metric_date: d, metric_key: OVERDUE, value: low.has(d) ? 12 : noisy(20, d), measured_at: `${d}T18:00:00.000Z` });
    rows.push({ clinic_id: f.clinic, metric_date: d, metric_key: MetricKey.APPOINTMENTS_TOTAL_TODAY, value: noisy(10, d), measured_at: `${d}T18:00:00.000Z` });
  }
  await insert("metric_history", rows);
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

function followUp(f: ClinicFixture, patient: string, completedAt: string, deleted = false) {
  return {
    id: id(),
    clinic_id: f.clinic,
    patient_id: patient,
    due_date: "2026-04-01",
    status: "completed",
    created_at: "2026-03-15T00:00:00.000Z",
    updated_at: completedAt,
    deleted_at: deleted ? "2026-08-01T00:00:00.000Z" : null,
  };
}

async function seedA() {
  await seedBase(A);
  await seedMetrics(A, A_DATES.map((d) => addDays(d, 14)));
  const completions = A_DATES.map((d, i) => completionRow(A, d, [...A.patients.slice(i * 8, i * 8 + 8), ...(i === 0 ? [A.patients[48]] : [])]));
  completions.push(completionRow(A, A_RECENT, A.patients.slice(40, 48)));
  await insert("action_completions", completions);
  const followUps: Record<string, unknown>[] = [];
  A_DATES.forEach((d, i) => {
    const targets = A.patients.slice(i * 8, i * 8 + 8);
    targets.slice(0, 7).forEach((p, k) => followUps.push(followUp(A, p, at(d, k + 1))));
    // Soft-deleted follow-up for the eighth target, and a completed one for the deleted patient.
    followUps.push(followUp(A, targets[7], at(d, 2), true));
    if (i === 0) followUps.push(followUp(A, A.patients[48], at(d, 1)));
  });
  A.patients.slice(40, 42).forEach((p) => followUps.push(followUp(A, p, at(A_RECENT, 1))));
  await insert("follow_ups", followUps);
}

async function seedB() {
  await seedBase(B);
  await seedMetrics(B, []);
  await insert("action_completions", B_DATES.map((d, i) => completionRow(B, d, B.patients.slice(i * 8, i * 8 + 8))));
  // Recorded as each day's healthy run would have recorded them: started that
  // morning in the clinic's timezone, written a minute later. The service role can
  // seed this; the database still refuses one written long after its run.
  for (let d = "2026-08-16"; d <= addDays(D, -1); d = addDays(d, 1)) {
    await insert("finding_snapshots", {
      clinic_id: B.clinic,
      business_date: d,
      run_health: "healthy",
      run_started_at: `${d}T04:00:00.000Z`,
      recorded_at: `${d}T04:01:00.000Z`,
      brain_version: "test",
      findings: [
        {
          findingId: `finding.problem:constraint.retention:${B.clinic}:${d}`,
          kind: "problem",
          polarity: "negative",
          category: "retention",
          role: "top",
          rank: 1,
          severity: "high",
          actionable: true,
          suppressed: false,
        },
      ],
    });
  }
}

function runFor(f: ClinicFixture): { date: string; timezone: string; metrics: ReturnType<typeof buildMetric>[]; findings: Finding[] } {
  return {
    date: D,
    timezone: TZ,
    metrics: [buildMetric(OVERDUE, 18, f.clinic, D, NOW)],
    findings: [{ ...todayFinding("retention"), id: `finding.problem:constraint.retention:${f.clinic}:${D}`, clinicId: f.clinic }],
  };
}

/** The same pipeline `loadActionLearning` runs, but surfacing errors instead of falling back. */
async function learnFrom(client: SupabaseClient<Database>, f: ClinicFixture, withhold: ("action_completion" | "finding_snapshot")[] = []) {
  const run = runFor(f);
  const slice = await new SupabaseActionHistory(client, TZ, { withhold }).readActionHistory({
    clinicId: f.clinic,
    from: addDays(D, -179),
    to: D,
    asOf: NOW,
    limit: 1000,
    metricKeys: [OVERDUE, MetricKey.APPOINTMENTS_TOTAL_TODAY],
  });
  const inputs = inputsFromHistory(slice);
  const outcomes = deriveOutcomes({
    completions: inputs.completions,
    verifications: inputs.verifications,
    metrics: run.metrics,
    now: NOW,
    history: inputs.history,
    resolution: { date: D, today: run.findings, snapshots: slice.snapshots },
  }).outcomes;
  const learning = deriveLearning({
    clinicId: f.clinic,
    date: D,
    timezone: TZ,
    outcomes,
    snapshots: slice.snapshots,
    dismissals: slice.dismissals,
    today: run.findings,
    gaps: inputs.gaps,
  });
  return { slice, outcomes, learning };
}

const kinds = (l: ClinicLearning) => l.learnings.map((x) => `${x.kind}:${x.subject}`).sort();
const byDate = (outcomes: readonly Outcome[]) => [...outcomes].sort((a, b) => (a.completedAt < b.completedAt ? -1 : 1));

beforeAll(async () => {
  if (!LOCAL_UP) return;
  await seedA();
  await seedB();
}, 120_000);

// In order, never shuffled: the snapshot test records finding snapshots the learning comparisons before it read.
describe.skipIf(!LOCAL_UP)("action → outcome → learning on real rows", { shuffle: false }, () => {
  let a: Awaited<ReturnType<typeof learnFrom>>;
  let b: Awaited<ReturnType<typeof learnFrom>>;
  beforeAll(async () => {
    [a, b] = await Promise.all([learnFrom(db, A), learnFrom(db, B)]);
  }, 60_000);

  it("A: recall outreach written into the database after the fact never climbs above observed-after", () => {
    // The same rows once reached strong evidence. They were seeded today to look
    // like months of history: the readings carry no provenance and the follow-up
    // closures predate state-history capture, so nothing proves what was on record
    // at each horizon. The ladder stops, and says exactly why — the
    // point-in-time ladder itself is covered with stated provenance in
    // attribution.spec.ts, and real captured history in point-in-time.spec.ts.
    expect(a.slice.truncated).toEqual([]);
    const outcomes = byDate(a.outcomes);
    expect(outcomes.map((o) => o.attribution)).toEqual(Array(6).fill(OutcomeAttribution.OBSERVED_AFTER));
    for (const o of outcomes.slice(0, 5)) {
      const temporal = o.evidence?.requirements.find((r) => r.key === "evidence_point_in_time");
      expect(temporal?.met).toBe(false);
      expect(temporal?.detail).toMatch(/recomputed later or are of unknown provenance/);
      expect(temporal?.detail).toMatch(/read from records as they stand now/);
      expect(o.evidenceQuality).toMatchObject({ completion: "staff_declared", completionTime: "declaration_time", pointInTime: false });
      expect(o.evidenceQuality.results?.timing).toBe("current_state");
    }
    const learning = a.learning.learnings.find((l) => l.kind === LearningKind.REPEATED_IMPROVEMENT);
    expect(learning?.level === "strong_evidence" || learning?.level === "likely_contributed").toBe(false);
    // Closures read from current rows cannot say what kind of record they are,
    // so none is counted as a result, and no time-to-result is claimed from them.
    expect(a.learning.learnings.find((l) => l.kind === LearningKind.TIME_TO_OUTCOME)).toBeUndefined();
  });

  it("A: a soft-deleted patient and a soft-deleted follow-up confirm nothing", () => {
    const first = byDate(a.outcomes)[0];
    expect(first.targets).toMatchObject({ targeted: 9, resolvable: 8, confirmed: 7, observed: 0 });
    // Seven closures on record, none of them provably a record of the visit itself.
    expect(first.evidence?.targets).toMatchObject({ resolvable: 8, confirmedWithinWindow: 0, declaredWithinWindow: 7 });
  });

  it("A: an outcome short of the new rungs is exactly what the existing loader returns", async () => {
    const run = runFor(A);
    const existing = await loadActionOutcomes(db, A.clinic, run.metrics, NOW);
    const withLearning = await loadActionLearning(db, A.clinic, run, NOW);
    expect(withLearning.learning).not.toBeNull();
    expect(existing).toHaveLength(1);
    const strip = (o: Outcome) => {
      const { evidence: _e, resolution: _r, ...rest } = o;
      return rest;
    };
    expect(withLearning.outcomes.map(strip)).toEqual(existing);
    expect(existing[0]).toMatchObject({ attribution: OutcomeAttribution.OBSERVED_AFTER, targets: { resolvable: 8, confirmed: 2 } });
  });

  it("B: repeated completions with no change, an ignored recommendation and a recurring problem", () => {
    expect(kinds(b.learning)).toEqual([
      "frequently_ignored:retention",
      "no_measurable_change:retention",
      "recurring_unresolved:retention",
    ]);
    const statement = (kind: string) => b.learning.learnings.find((l) => l.kind === kind)?.statement;
    expect(statement(LearningKind.NO_MEASURABLE_CHANGE)).toBe(
      "Working the overdue recall list was marked done 6 times, and 6 of those were followed by no measurable change in the records within the following weeks.",
    );
    expect(statement(LearningKind.FREQUENTLY_IGNORED)).toBe(
      "Working the overdue recall list was a top recommendation on 29 of 29 recorded days, and was marked done within 2 days of 0 of them.",
    );
    expect(statement(LearningKind.RECURRING_UNRESOLVED)).toBe(
      "The overdue recall list has been flagged on 30 of 30 recorded days since 2026-08-16 and is still flagged on 2026-09-14, after 6 completed actions.",
    );
    expect(b.outcomes.every((o) => o.attribution !== OutcomeAttribution.LIKELY_CONTRIBUTED && o.attribution !== OutcomeAttribution.STRONG_EVIDENCE)).toBe(true);
    expect(b.learning.proposals.map((p) => p.kind).sort()).toEqual(["confidence_adjustment", "threshold_adjustment", "workflow_improvement"]);
    expect(b.learning.proposals.every((p) => p.requiresHumanAcceptance && !p.appliedAutomatically)).toBe(true);
  });

  it("keeps each clinic's memory to itself", async () => {
    expect(JSON.stringify(a)).not.toContain(B.clinic);
    expect(JSON.stringify(b)).not.toContain(A.clinic);
    for (const pid of [...A.patients, ...B.patients]) {
      expect(JSON.stringify(a.learning)).not.toContain(pid);
      expect(JSON.stringify(b.learning)).not.toContain(pid);
    }
    // B's dentist asking for A's history under RLS reads nothing — never A's evidence.
    const client = createClient<Database>(URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await client.auth.signInWithPassword({ email: B.email, password: "password123" });
    if (error) throw new Error(`sign in: ${error.message}`);
    const leaked = await learnFrom(client, A);
    expect(leaked.slice.completions).toEqual([]);
    expect(leaked.slice.metricDays).toEqual([]);
    expect(leaked.learning.learnings).toEqual([]);
    await client.auth.signOut();
  });

  it("gives a dentist's own session under RLS the same learning as the service role", async () => {
    const client = createClient<Database>(URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await client.auth.signInWithPassword({ email: A.email, password: "password123" });
    if (error) throw new Error(`sign in: ${error.message}`);
    const own = await learnFrom(client, A);
    expect(own.learning).toEqual(a.learning);
    expect(own.outcomes).toEqual(a.outcomes);
    await client.auth.signOut();
  });

  it("keeps withheld data withheld: no learning from a read that could not see completions", async () => {
    const withheld = await learnFrom(db, A, ["action_completion"]);
    expect(withheld.slice.withheld).toEqual(["action_completion", "completion_confirmation"]);
    expect(withheld.learning.learnings).toEqual([]);
    expect(withheld.learning.assessments.every((x) => x.status === "insufficient_evidence")).toBe(true);
  });

  it("records one snapshot per clinic-day, first view wins, and never rewrites it", async () => {
    // A snapshot is recorded by the run that showed it, on that run's own
    // business day: the real present, in the clinic's timezone.
    const startedAt = new Date().toISOString();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(startedAt));
    const run = { startedAt, version: "test" };
    const first = [{ findingId: "finding.problem:x", kind: "problem", polarity: "negative", category: "retention", role: "top", rank: 1, severity: "high", actionable: true, suppressed: false }];
    expect(await recordFindingSnapshot(A.clinic, today, first, run, db)).toBe(true);
    expect(await recordFindingSnapshot(A.clinic, today, [], run, db)).toBe(true);
    const { data } = await raw.from("finding_snapshots").select("findings, run_health, run_started_at").eq("clinic_id", A.clinic).eq("business_date", today);
    expect(data).toHaveLength(1);
    expect(data[0].findings).toEqual(first);
    expect(data[0].run_health).toBe("healthy");
    // Regenerating an earlier day's snapshot now is refused: it was not shown then.
    expect(await recordFindingSnapshot(A.clinic, addDays(today, -40), first, run, db)).toBe(false);
    const { error } = await raw.from("finding_snapshots").update({ findings: [] }).eq("clinic_id", A.clinic);
    expect(error?.message).toMatch(/append-only/);
  });

  it("learns the same thing from the same rows twice", async () => {
    const again = await learnFrom(db, B);
    expect(again.learning).toEqual(b.learning);
    expect(again.outcomes).toEqual(b.outcomes);
  });
});
