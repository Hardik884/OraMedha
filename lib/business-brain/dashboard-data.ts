/**
 * lib/business-brain/dashboard-data.ts
 *
 * Server-side entry point for the Business Brain dashboard.
 *
 * It wires the Supabase repository into the existing orchestrator and returns
 * the run. No metric, signal or diagnosis is computed here — this file only
 * decides which clinic and which date to ask about.
 */

import "server-only";
import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";
import { createServerClient } from "@/lib/supabase/server";
import { getClinicConfig } from "@/lib/clinic/config";
import { resolveSession } from "@/lib/auth/session";
import { isBusinessBrainEnabled } from "@/lib/feature-flags";
import { getTodayInTimezone } from "@/lib/utils";
import { addDays } from "@/business-brain";
import { BusinessBrain, type BusinessBrainResult } from "@/business-brain";
import { SupabaseMetricsDataRepository } from "./metrics-repository";
import { SupabaseMetricHistoryStore } from "./metric-history-store";
import { SupabaseClinicLedger } from "./clinic-ledger";
import { recordRecomputedHistory } from "./persist-metrics";
import { readLatestClinicMemory } from "./clinic-memory";

/**
 * Days of history loaded per run.
 *
 * Raised from 7 to 35 because two capabilities need more than a week and the data
 * was already there: the Baseline Engine needs enough observations to describe
 * this clinic's normal RANGE rather than just its recent level (its `adequate`
 * mark is 6 and `strong` is 14), and a week-over-week movement needs a day on
 * both sides of the comparison. `metric_history` has been recording every metric
 * every day for as long as the clinic has been live; the run was reading seven of
 * them.
 *
 * Raised again from 35 to 70 when baselines became weekday-aware. A Saturday is
 * judged against Saturdays, and six of them is the bar every other judgement
 * here uses — which is six weeks, so five weeks of history could never clear it
 * for any weekday. Ten weeks leaves room for the days a clinic is closed.
 *
 * Ten weeks rather than more: it covers the 30-day windows the metrics
 * themselves describe, with slack for weekday bands and for a comparison day
 * near a closure. Beyond that the reads get wider for no question anyone is
 * asking yet — seasonality needs a year, and no clinic has one (see
 * `BaselineResult.seasonality`).
 *
 * The store pages its reads, so a wider window is one range query rather than a
 * truncated one.
 */
const HISTORY_DAYS = 70;

/**
 * How many of those days this run may MEASURE itself when the store lacks them.
 *
 * The cap matters because the two costs are not comparable: a stored day is one
 * row of a range read, while a missing day is a full clinic snapshot. Without it,
 * the first load for a clinic with a cold store would run 35 snapshots inside a
 * page render.
 *
 * Seven keeps the recent window — the part persistence reasons over — complete on
 * the first load, while the write-back below and the hourly job fill the rest in
 * behind it. Older days that are neither stored nor measured are simply absent,
 * which every consumer already handles honestly: persistence treats an
 * unsupplied day as unknown, and a baseline reports the observations it has.
 */
const MAX_RECOMPUTED_HISTORY_DAYS = 7;

export interface DashboardRun {
  readonly result: BusinessBrainResult;
  readonly clinicId: string;
  readonly date: string;
  readonly timezone: string;
}

/**
 * Run the pipeline for the caller's clinic on a business date.
 *
 * Read-only, and deliberately kept that way: a page render must not write, and
 * `pipeline.spec.ts` asserts the whole run leaves every table's row count
 * unchanged. Recording measurements is a separate, explicit step — see
 * `persistMetricDay` in ./persist-metrics.ts.
 *
 * Uses the request's own Supabase session rather than the service role, so RLS
 * still applies and the dashboard cannot see further than the dentist can. That
 * is also why the history store here can only ever read: `metric_history` grants
 * SELECT to a dentist and INSERT to nobody.
 *
 * @param date Business date "YYYY-MM-DD". Defaults to today in the clinic's
 *             timezone — not the server's.
 */
export async function runDashboardBrain(date?: string): Promise<DashboardRun> {
  // Defence in depth. Every caller sits behind a dentist route, but this reads
  // business performance a receptionist has no access to anywhere else, and RLS
  // would hand a non-dentist session empty dentist-only tables that read as a
  // quiet clinic. The guard belongs with the read, not only at the door.
  const { profile } = await resolveSession();
  if (!profile || profile.role !== "dentist" || !isBusinessBrainEnabled(profile.clinic_id)) {
    throw new Error("The Business Brain is available to this clinic's dentist only.");
  }
  const { clinicId, timezone } = await getClinicConfig();
  const businessDate = date ?? getTodayInTimezone(timezone);

  // @supabase/ssr's client and @supabase/supabase-js's client are structurally
  // the same at runtime but carry different generic parameters, so the two do
  // not unify. Narrowed here rather than widening the repository's public type,
  // which would lose the typing the rest of the codebase relies on. Same root
  // cause as the TYPING NOTE in ./metrics-repository.ts.
  const supabase = (await createServerClient()) as unknown as SupabaseClient<Database>;
  const repository = new SupabaseMetricsDataRepository(supabase);
  const brain = new BusinessBrain({
    repository,
    historyStore: new SupabaseMetricHistoryStore(supabase),
    // The relational ledger, which also serves the Diagnosis Engine's entity
    // questions — so the discriminators the matchers attach are actually
    // measured rather than left as a list of what would have settled them.
    // Read-only and still on the request's own session, so RLS applies.
    ledgerPort: new SupabaseClinicLedger(supabase, timezone),
  });

  // This clinic's latest memory build: one row, built by the scheduled job. Cited
  // in explanations when an active entry supports a finding; never ranked on.
  const memory = await readLatestClinicMemory(supabase, clinicId);

  const result = await brain.runBusinessBrain(clinicId, businessDate, {
    memory,
    historyDays: HISTORY_DAYS,
    maxRecomputedHistoryDays: MAX_RECOMPUTED_HISTORY_DAYS,
    // Only a run for today can describe time still ahead. A caller asking about a
    // past date gets no opportunities rather than ones measured against a week
    // that has already happened.
    ...(date === undefined ? { opportunities: { now: new Date().toISOString() } } : {}),
    // Where the day's problems are concentrated in the trailing month. Reads only
    // when a finding qualifies, and attaches to that finding.
    rootCauses: { now: new Date().toISOString(), timezone },
  });

  // Self-healing history.
  //
  // The run just measured every history day the store did not have. Writing
  // those back means the next load reads them instead of measuring them again,
  // so history fills itself the first time anyone opens the page — no scheduler,
  // no external job.
  //
  // `after` runs this once the response has been sent, so the render itself
  // stays read-only and the dentist never waits on a write. Only COMPLETED days
  // are recorded: today's figures are still moving, and freezing them would
  // store a half-finished number as if it were the day's result.
  const lastCompletedDay = addDays(businessDate, -1);
  const finishedDays = result.recomputedHistory.filter((day) => day.date <= lastCompletedDay);
  if (finishedDays.length > 0) {
    after(() => recordRecomputedHistory(clinicId, finishedDays));
  }

  return { result, clinicId, date: businessDate, timezone };
}
