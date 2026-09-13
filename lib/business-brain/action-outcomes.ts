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
  CompletionSource,
  type ActionCompletionRecord,
  type Metric,
  type Outcome,
  type TargetVerification,
} from "@/business-brain";
import {
  deriveOutcomes,
  OUTCOME_SPEC_BY_CATEGORY,
  VerificationTarget,
} from "@/business-brain/engines/outcome";

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

/** Narrow `unknown` PostgREST payloads to the row shape a query selected. */
function rows<T>(data: unknown): T[] {
  return (data ?? []) as T[];
}

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

    const { data, error } = await db
      .from("action_completions")
      .select(
        "id, category, constraint_id, completed_at, source, target_patient_ids, metric_key, metric_value",
      )
      .eq("clinic_id", clinicId)
      .gte("completed_at", since)
      .order("completed_at", { ascending: false })
      .limit(COMPLETION_LIMIT);
    if (error || !data) return [];

    return rows<CompletionRow>(data).map((row) => ({
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
): Promise<ReadonlyMap<string, TargetVerification>> {
  const byCompletion = new Map<string, TargetVerification>();
  if (completions.length === 0) return byCompletion;

  try {
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

      if (completion.targetPatientIds.length === 0) {
        byCompletion.set(completion.id, {
          completionId: completion.id,
          targeted: 0,
          resolvable: 0,
          confirmed: 0,
          verifiable: true,
        });
        continue;
      }

      // Which targets are still live patients in THIS clinic. Both filters
      // matter: the clinic predicate is what stops a cross-clinic id from ever
      // resolving, and the soft-delete filter is what keeps a deleted patient out
      // of today's denominator.
      const { data: live } = await db
        .from("patients")
        .select("id")
        .eq("clinic_id", clinicId)
        .is("deleted_at", null)
        .in("id", completion.targetPatientIds);
      const resolvable = rows<{ id: string }>(live).map((p) => p.id);

      const confirmed =
        resolvable.length === 0
          ? 0
          : await countConfirmed(db, clinicId, spec.verifies, resolvable, completion.completedAt);

      byCompletion.set(completion.id, {
        completionId: completion.id,
        targeted: completion.targetPatientIds.length,
        resolvable: resolvable.length,
        confirmed,
        verifiable: true,
      });
    }
  } catch (error) {
    console.error("[verifyCompletions]", error);
  }

  return byCompletion;
}

/**
 * Count targets showing the intended result since the completion moment.
 *
 * Distinct PATIENTS, never rows: a patient with two payments recorded is one
 * confirmed target, and counting rows could report 9 of 8 confirmed.
 *
 * The `since` bound is what makes this evidence rather than coincidence — a
 * payment recorded last month does not confirm work reported this morning.
 */
async function countConfirmed(
  db: SupabaseClient<Database>,
  clinicId: string,
  target: VerificationTarget,
  patientIds: readonly string[],
  since: string,
): Promise<number> {
  if (target === VerificationTarget.FOLLOW_UP_COMPLETED) {
    const { data } = await db
      .from("follow_ups")
      .select("patient_id")
      .eq("clinic_id", clinicId)
      .in("patient_id", patientIds as string[])
      .eq("status", "completed")
      .is("deleted_at", null)
      .gte("updated_at", since);
    return distinctPatients(data);
  }

  if (target === VerificationTarget.PAYMENT_RECORDED) {
    const { data } = await db
      .from("payments")
      .select("patient_id")
      .eq("clinic_id", clinicId)
      .in("patient_id", patientIds as string[])
      .is("deleted_at", null)
      .gte("created_at", since);
    return distinctPatients(data);
  }

  // APPOINTMENT_BOOKED. Filtered to appointments that still represent a real
  // visit: one cancelled since does not confirm that the patient was booked in.
  const { data } = await db
    .from("appointments")
    .select("patient_id")
    .eq("clinic_id", clinicId)
    .in("patient_id", patientIds as string[])
    .in("status", ["scheduled", "checked_in", "in_progress", "completed"])
    .is("deleted_at", null)
    .gte("created_at", since);
  return distinctPatients(data);
}

function distinctPatients(data: unknown): number {
  return new Set(rows<{ patient_id: string }>(data).map((r) => r.patient_id)).size;
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
    const completions = await readActionCompletions(db, clinicId, now);
    if (completions.length === 0) return [];

    const verifications = await verifyCompletions(db, clinicId, completions);
    return deriveOutcomes({ completions, verifications, metrics, now }).outcomes;
  } catch (error) {
    console.error("[loadActionOutcomes]", error);
    return [];
  }
}
