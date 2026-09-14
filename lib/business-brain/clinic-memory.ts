/**
 * lib/business-brain/clinic-memory.ts
 *
 * The Supabase side of Clinic Memory: the bounded evidence read a build derives
 * from, the append-only write of a build, the single-row read a dashboard load
 * makes, and the recording of a human decision.
 *
 * ## Two paths that never mix
 *
 *   build (scheduled job)  one bounded read of up to a year of STORED evidence —
 *                          metric_history for a fixed set of keys, finding
 *                          snapshots, completions and what followed them,
 *                          snoozes and decisions — then the pure engine, then one
 *                          insert. Reads operational rows only to confirm what
                          followed a completion (follow-ups, payments, and for
                          treatment acceptance the appointments booked), counted
                          per completion and never passed on by patient.
 *   read (dashboard)       one row: the latest build for the clinic.
 *
 * ## Isolation and minimisation
 *
 * Every query carries an explicit clinic predicate. Patient ids are used only
 * inside the history adapter to count confirmations and never reach the engine,
 * the build, or a decision. A build read back is refused if it names another
 * clinic.
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database.types";
import {
  addDays,
  MetricKey,
  type ClinicDecisionFact,
  type ClinicMemory,
} from "@/business-brain";
import { deriveOutcomes, OUTCOME_SPECS } from "@/business-brain/engines/outcome";
import { inputsFromHistory } from "@/business-brain/engines/learning";
import {
  DEFAULT_MEMORY_CONFIG,
  deriveClinicMemory,
  MEMORY_DERIVATION_VERSION,
  RANGE_METRIC_KEYS,
} from "@/business-brain/memory";
import { SupabaseActionHistory, type ActionHistoryOptions } from "./action-history";
import { readAll } from "./paged-read";
import { getUtcBoundariesForLocalDate } from "@/lib/utils";

/** Most rows per history kind in one build. A kind that reaches it is reported truncated. */
export const MEMORY_ROW_LIMIT = 5000;
/** Most decisions one read returns before it is refused rather than cut. */
export const DECISION_LIMIT = 20_000;

/** Every stored metric a build reads, and nothing else from metric_history. */
export function memoryMetricKeys(): string[] {
  return [
    ...new Set([
      ...RANGE_METRIC_KEYS,
      ...OUTCOME_SPECS.flatMap((s) => (s.metricKey === null ? [] : [s.metricKey])),
      MetricKey.APPOINTMENTS_TOTAL_TODAY,
    ]),
  ].sort();
}

interface DecisionRow {
  id: string;
  target_type: string;
  target_id: string;
  proposal_kind: string | null;
  subject: string;
  decision: string;
  basis: unknown;
  decided_at: string;
}

/**
 * This clinic's decisions, oldest first. Throws on a failed read.
 *
 * `asOf` bounds the read to decisions already made at that moment: a build for a
 * past day must not reflect a decision taken after it, or a rebuild would rewrite
 * what the clinic had decided then.
 */
export async function readClinicDecisions(db: SupabaseClient<Database>, clinicId: string, asOf?: string): Promise<ClinicDecisionFact[]> {
  // Whole or refused: resolving the latest decision per target from part of the
  // audit trail could revive a decision that was later revoked.
  const data = await readAll<DecisionRow>(
    "clinic memory (clinic_decisions)",
    (from, to) =>
      db
        .from("clinic_decisions")
        .select("id, target_type, target_id, proposal_kind, subject, decision, basis, decided_at")
        .eq("clinic_id", clinicId)
        .lte("decided_at", asOf ?? "infinity")
        .order("decided_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    DECISION_LIMIT,
  );
  return data.flatMap((r) =>
    (r.target_type === "proposal" || r.target_type === "memory") &&
    (r.decision === "accepted" || r.decision === "rejected" || r.decision === "revoked")
      ? [
          {
            id: r.id,
            clinicId,
            target: { type: r.target_type, id: r.target_id },
            proposalKind: r.proposal_kind,
            subject: r.subject,
            decision: r.decision,
            decidedAt: new Date(r.decided_at).toISOString(),
            basis: basisOf(r.basis),
          },
        ]
      : [],
  );
}

/** Keep only scalar codes and numbers from a stored basis. */
function basisOf(raw: unknown): Readonly<Record<string, number | string | null>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, number | string | null> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" || typeof v === "string" || v === null) out[k] = v;
  }
  return out;
}

/**
 * Derive this clinic's memory for `date` (the last completed business day) from
 * one bounded read of stored evidence. Throws on a failed read.
 */
export async function buildClinicMemory(
  db: SupabaseClient<Database>,
  clinicId: string,
  date: string,
  timezone: string,
  now: string,
  options: ActionHistoryOptions = {},
): Promise<ClinicMemory> {
  // Evidence as it stood at the END of the day the build describes, never later.
  // A build for 14 September made on the 15th and one rebuilt months later must
  // read the same evidence — otherwise confirmations recorded since, and outcome
  // windows that closed since, would rewrite what was known that day.
  const asOf = memoryKnowledgeAsOf(date, timezone, now);
  const slice = await new SupabaseActionHistory(db, timezone, options).readActionHistory({
    clinicId,
    from: addDays(date, -(DEFAULT_MEMORY_CONFIG.windowDays - 1)),
    to: date,
    asOf,
    limit: MEMORY_ROW_LIMIT,
    metricKeys: memoryMetricKeys(),
  });
  const inputs = inputsFromHistory(slice);
  const outcomes = deriveOutcomes({
    completions: inputs.completions,
    verifications: inputs.verifications,
    // The build describes history, not today: no current readings are needed.
    metrics: [],
    now: asOf,
    history: inputs.history,
  }).outcomes;
  const decisions = await readClinicDecisions(db, clinicId, asOf);
  return deriveClinicMemory({
    clinicId,
    date,
    timezone,
    metricDays: slice.metricDays,
    snapshots: slice.snapshots,
    outcomes,
    dismissals: slice.dismissals,
    decisions,
    gaps: inputs.gaps,
  });
}

/** The latest moment a build for `date` may read evidence as of: the end of that day, or earlier if built during it. */
export function memoryKnowledgeAsOf(date: string, timezone: string, now: string): string {
  const endOfDay = getUtcBoundariesForLocalDate(date, timezone).end;
  return Date.parse(now) < Date.parse(endOfDay) ? now : endOfDay;
}

/**
 * Record a build once per clinic-day and derivation version. Returns false when
 * one already existed. `knowledgeAsOf` is the bound every evidence read used.
 */
export async function persistClinicMemory(db: SupabaseClient<Database>, memory: ClinicMemory, knowledgeAsOf?: string): Promise<boolean> {
  const { data, error } = await db
    .from("clinic_memory_builds")
    .upsert(
      {
        clinic_id: memory.clinicId,
        built_for: memory.builtFor,
        derivation_version: memory.derivationVersion,
        window_from: memory.window.from,
        window_to: memory.window.to,
        digest: memory.digest,
        memory: memory as unknown as Database["public"]["Tables"]["clinic_memory_builds"]["Insert"]["memory"],
        knowledge_as_of: knowledgeAsOf ?? null,
      },
      { onConflict: "clinic_id,built_for,derivation_version", ignoreDuplicates: true },
    )
    .select("id");
  if (error) throw new Error(`clinic memory (clinic_memory_builds): ${error.message}`);
  return (data ?? []).length > 0;
}

/** Whether a build already exists for this clinic-day under the current derivation. */
export async function hasClinicMemoryBuild(db: SupabaseClient<Database>, clinicId: string, date: string): Promise<boolean> {
  const { data, error } = await db
    .from("clinic_memory_builds")
    .select("id")
    .eq("clinic_id", clinicId)
    .eq("built_for", date)
    .eq("derivation_version", MEMORY_DERIVATION_VERSION)
    .limit(1);
  if (error) throw new Error(`clinic memory (clinic_memory_builds): ${error.message}`);
  return (data ?? []).length > 0;
}

/**
 * The dashboard's read: the latest build for this clinic under the current
 * derivation, as one row. Null when none exists or it cannot be read — memory is
 * supporting evidence, and its absence costs nothing but the citation.
 */
export async function readLatestClinicMemory(db: SupabaseClient<Database>, clinicId: string): Promise<ClinicMemory | null> {
  try {
    const { data, error } = await db
      .from("clinic_memory_builds")
      .select("memory")
      .eq("clinic_id", clinicId)
      .eq("derivation_version", MEMORY_DERIVATION_VERSION)
      .order("built_for", { ascending: false })
      .order("built_at", { ascending: false })
      .limit(1);
    if (error || !data || data.length === 0) return null;
    const memory = (data[0] as { memory: unknown }).memory as ClinicMemory;
    if (
      typeof memory !== "object" ||
      memory === null ||
      memory.clinicId !== clinicId ||
      !Array.isArray(memory.entries) ||
      !Array.isArray(memory.decisions) ||
      memory.entries.some((e) => e.clinicId !== clinicId)
    ) {
      return null;
    }
    return memory;
  } catch (error) {
    console.error("[readLatestClinicMemory]", error);
    return null;
  }
}

/**
 * Build and record memory for a clinic-day unless it is already recorded. For the
 * scheduled job, on the service role.
 */
export async function ensureClinicMemoryBuild(
  db: SupabaseClient<Database>,
  clinicId: string,
  date: string,
  timezone: string,
  now: string,
): Promise<"built" | "already_built"> {
  if (await hasClinicMemoryBuild(db, clinicId, date)) return "already_built";
  const memory = await buildClinicMemory(db, clinicId, date, timezone, now);
  return (await persistClinicMemory(db, memory, memoryKnowledgeAsOf(date, timezone, now))) ? "built" : "already_built";
}

export interface DecisionInput {
  readonly clinicId: string;
  readonly decidedBy: string;
  readonly target: { readonly type: "proposal" | "memory"; readonly id: string };
  readonly proposalKind: string | null;
  readonly subject: string;
  readonly decision: "accepted" | "rejected" | "revoked";
  readonly basis: Readonly<Record<string, number | string | null>>;
}

/** Append one decision. Under a dentist session RLS pins the clinic and the author. */
export async function recordClinicDecision(db: SupabaseClient<Database>, input: DecisionInput): Promise<string> {
  const { data, error } = await db
    .from("clinic_decisions")
    .insert({
      clinic_id: input.clinicId,
      target_type: input.target.type,
      target_id: input.target.id,
      proposal_kind: input.proposalKind,
      subject: input.subject,
      decision: input.decision,
      basis: input.basis,
      decided_by: input.decidedBy,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`clinic memory (clinic_decisions): ${error?.message ?? "no row"}`);
  return (data as { id: string }).id;
}
