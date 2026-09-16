/**
 * lib/business-brain/action-outcomes.ts
 *
 * The Supabase adapter for the Outcome Engine.
 *
 * Same split as every other port in this module: the engine lives in
 * `business-brain/engines/outcome/` and knows nothing about Postgres; this is the
 * only place `action_completions` is read and the only place the clinic's data is
 * asked whether an action's intended result actually arrived.
 *
 * ## Tenant isolation, stated once
 *
 * Every query below is filtered by `clinic_id` explicitly AND restricted to the
 * completion's own target ids. Two filters rather than one, deliberately: RLS
 * already scopes a dentist's session to their clinic, but the verifier must also
 * be correct under the service role, and an `in (targets)` without a clinic
 * predicate would be a cross-clinic entity match waiting for the day someone
 * passes a service-role client.
 *
 * ## Soft deletes
 *
 * The completion record keeps every id it targeted, for good reason — see the
 * migration header. The verifier resolves those ids through a live-patient query
 * that filters `deleted_at`, so a patient deleted since is excluded from today's
 * denominator while the historical record of having been targeted survives. That
 * is why `resolvable` exists alongside `targeted`.
 *
 * ## Read-only
 *
 * Nothing here writes. Recording a completion is a separate, explicit act in
 * `actions/business-brain.ts`; assessing what followed is a pure read.
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database.types";
import {
  addDays,
  CompletionSource,
  EvidenceSource,
  MetricKey,
  type ActionCompletionRecord,
  type ClinicLearning,
  type Finding,
  type Metric,
  type Outcome,
  type TargetVerification,
} from "@/business-brain";
import {
  dedupeCompletions,
  deriveOutcomes,
  OUTCOME_SPECS,
  OUTCOME_SPEC_BY_CATEGORY,
} from "@/business-brain/engines/outcome";
import { deriveLearning, DEFAULT_LEARNING_CONFIG, inputsFromHistory } from "@/business-brain/engines/learning";
import { SupabaseActionHistory } from "./action-history";
import { readUpTo } from "./paged-read";
import { livePatientsAt, readHistoryCaptures, readResultEvents, resultTiming } from "./result-events";

/** The most result rows one verification read may return per id chunk. */
const MAX_VERIFICATION_ROWS = 250_000;

/**
 * How far back the Actions page looks for completed actions.
 *
 * Thirty days. Long enough that a clinic sees the work it did this month, short
 * enough that the page stays a briefing rather than becoming an archive — and
 * long enough for the level metrics involved to have moved if they were going to.
 */
export const COMPLETION_LOOKBACK_DAYS = 30;

/** Most completions assessed per load. A guard, not a page. */
const COMPLETION_LIMIT = 50;


interface CompletionRow {
  id: string;
  category: string;
  constraint_id: string;
  completed_at: string;
  source: string;
  target_patient_ids: string[] | null;
  metric_key: string | null;
  metric_value: number | string | null;
}

/**
 * Read this clinic's recent completions.
 *
 * Never throws: what happened after an action is a retrospective nicety, and
 * losing it must not cost a dentist the page they came for. On any failure the
 * caller gets an empty list and the history section simply does not render.
 */
export async function readActionCompletions(
  db: SupabaseClient<Database>,
  clinicId: string,
  now: string,
): Promise<readonly ActionCompletionRecord[]> {
  try {
    const since = new Date(
      Date.parse(now) - COMPLETION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { rows: data } = await readUpTo<CompletionRow>(
      "action_completions",
      (from, to) =>
        db
          .from("action_completions")
          .select("id, category, constraint_id, completed_at, source, target_patient_ids, metric_key, metric_value")
          .eq("clinic_id", clinicId)
          .gte("completed_at", since)
          .order("completed_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to),
      COMPLETION_LIMIT,
    );

    return data.map((row) => ({
      id: row.id,
      category: row.category,
      constraintId: row.constraint_id,
      completedAt: row.completed_at,
      source:
        row.source === CompletionSource.INFERRED
          ? CompletionSource.INFERRED
          : CompletionSource.DECLARED,
      targetPatientIds: row.target_patient_ids ?? [],
      // Undefined rather than null: the engine's contract treats an absent
      // reading as "nothing to compare", and a null would have to be re-checked
      // at every use site.
      metricKey: row.metric_key ?? undefined,
      metricValueAtCompletion:
        row.metric_value === null ? undefined : Number(row.metric_value),
    }));
  } catch (error) {
    console.error("[readActionCompletions]", error);
    return [];
  }
}

/**
 * Ask the clinic's own data whether each completion's intended result arrived.
 *
 * One verification per completion, or none for a completion whose category the
 * schema cannot confirm. The distinction is carried on the result as
 * `verifiable`, because "0 of 8 confirmed" and "this cannot be confirmed" are
 * entirely different statements and a clinic shown the first when the second is
 * true would reasonably conclude its work achieved nothing.
 */
export async function verifyCompletions(
  db: SupabaseClient<Database>,
  clinicId: string,
  completions: readonly ActionCompletionRecord[],
  now: string = new Date().toISOString(),
): Promise<ReadonlyMap<string, TargetVerification>> {
  const byCompletion = new Map<string, TargetVerification>();
  if (completions.length === 0) return byCompletion;

  try {
    const captures = await readHistoryCaptures(db);
    for (const completion of completions) {
      const spec = OUTCOME_SPEC_BY_CATEGORY.get(completion.category);

      // Nothing the schema can confirm for this category. Recorded explicitly so
      // the engine reports it as unverifiable rather than as zero.
      if (spec?.verifies == null) {
        byCompletion.set(completion.id, {
          completionId: completion.id,
          targeted: completion.targetPatientIds.length,
          resolvable: 0,
          confirmed: 0,
          verifiable: false,
        });
        continue;
      }

      const timing = resultTiming(captures, spec.verifies, completion.completedAt);
      if (completion.targetPatientIds.length === 0) {
        byCompletion.set(completion.id, { completionId: completion.id, targeted: 0, resolvable: 0, confirmed: 0, observed: 0, verifiable: true, timing });
        continue;
      }

      // Which targets are live patients in THIS clinic now. The clinic predicate
      // is what stops a cross-clinic id from ever resolving; the deletion state is
      // what keeps a deleted patient out of today's denominator. A failed read
      // throws, and the completion is left unverified — never "0 of 8".
      const live = await livePatientsAt(db, clinicId, completion.targetPatientIds, now, timing);
      const resolvable = completion.targetPatientIds.filter((id) => live.has(id));
      const { events } =
        resolvable.length === 0
          ? { events: [] }
          : await readResultEvents(db, {
              clinicId,
              target: spec.verifies,
              patientIds: resolvable,
              since: completion.completedAt,
              knownAt: now,
              timing,
              limit: MAX_VERIFICATION_ROWS,
            });

      // Distinct PATIENTS, never rows: a patient with two payments recorded is
      // one confirmed target, and counting rows could report 9 of 8 confirmed.
      const confirmed = new Set(events.map((e) => e.patientId));
      const observed = new Set(events.filter((e) => e.source === EvidenceSource.OBJECTIVELY_OBSERVED).map((e) => e.patientId));
      byCompletion.set(completion.id, {
        completionId: completion.id,
        targeted: completion.targetPatientIds.length,
        resolvable: resolvable.length,
        confirmed: confirmed.size,
        observed: observed.size,
        verifiable: true,
        timing,
      });
    }
  } catch (error) {
    console.error("[verifyCompletions]", error);
  }

  return byCompletion;
}

/**
 * Read the clinic's recent completions, verify them, and assess what followed.
 *
 * The one entry point the page uses. Never throws, for the same reason
 * `readActionCompletions` does not: this is a look back, and losing it must not
 * cost the briefing.
 */
export async function loadActionOutcomes(
  db: SupabaseClient<Database>,
  clinicId: string,
  metrics: readonly Metric[],
  now: string,
): Promise<readonly Outcome[]> {
  try {
    const completions = dedupeCompletions(await readActionCompletions(db, clinicId, now));
    if (completions.length === 0) return [];

    const verifications = await verifyCompletions(db, clinicId, completions, now);
    return deriveOutcomes({ completions, verifications, metrics, now }).outcomes;
  } catch (error) {
    console.error("[loadActionOutcomes]", error);
    return [];
  }
}

/** Most rows per history kind in one learning read. A guard; a capped kind is reported. */
const HISTORY_ROW_LIMIT = 1000;

export interface ActionLearning {
  /** The recent completions the page lists, exactly as `loadActionOutcomes` selects them. */
  readonly outcomes: readonly Outcome[];
  /** What this clinic's history shows, or null when it could not be read. */
  readonly learning: ClinicLearning | null;
}

/**
 * Read this clinic's action history once, assess every completion in it with
 * windowed evidence and resolution, and derive what the history shows.
 *
 * Bounded: the learning window (180 days), a row limit per kind, and only the
 * metric keys outcomes are judged by. Falls back to `loadActionOutcomes` — the
 * behaviour the page had before learning existed — on any failure, so a history
 * problem never costs the dentist the list of what they did.
 */
export async function loadActionLearning(
  db: SupabaseClient<Database>,
  clinicId: string,
  run: { readonly date: string; readonly timezone: string; readonly metrics: readonly Metric[]; readonly findings: readonly Finding[] },
  now: string,
): Promise<ActionLearning> {
  try {
    const metricKeys = [
      ...new Set([
        ...OUTCOME_SPECS.flatMap((s) => (s.metricKey === null ? [] : [s.metricKey])),
        MetricKey.APPOINTMENTS_TOTAL_TODAY,
      ]),
    ].sort();
    const slice = await new SupabaseActionHistory(db, run.timezone).readActionHistory({
      clinicId,
      from: addDays(run.date, -(DEFAULT_LEARNING_CONFIG.windowDays - 1)),
      to: run.date,
      asOf: now,
      limit: HISTORY_ROW_LIMIT,
      metricKeys,
    });
    const inputs = inputsFromHistory(slice);
    const assessed = deriveOutcomes({
      completions: inputs.completions,
      verifications: inputs.verifications,
      metrics: run.metrics,
      now,
      history: inputs.history,
      resolution: { date: run.date, today: run.findings, snapshots: slice.snapshots },
    }).outcomes;

    const learning = deriveLearning({
      clinicId,
      date: run.date,
      timezone: run.timezone,
      outcomes: assessed,
      snapshots: slice.snapshots,
      dismissals: slice.dismissals,
      today: run.findings,
      gaps: inputs.gaps,
    });

    // The page's list keeps its original bounds: the last 30 days, newest first, 50 at most.
    const since = Date.parse(now) - COMPLETION_LOOKBACK_DAYS * 86_400_000;
    const outcomes = assessed.filter((o) => Date.parse(o.completedAt) >= since).slice(0, COMPLETION_LIMIT);
    return { outcomes, learning };
  } catch (error) {
    console.error("[loadActionLearning]", error);
    return { outcomes: await loadActionOutcomes(db, clinicId, run.metrics, now), learning: null };
  }
}
