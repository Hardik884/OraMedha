/**
 * lib/business-brain/action-history.ts
 *
 * The Supabase adapter for `ActionHistoryPort`: one bounded read of a clinic's
 * action history for the Outcome and Learning Engines.
 *
 * ## Bounded
 *
 * A date range, a row limit per kind (a kind that reaches it is reported
 * truncated), and only the metric keys asked for. metric_history is paged under
 * PostgREST's 1000-row cap rather than trusting a single response to be whole.
 *
 * ## Tenant isolation and soft deletes
 *
 * Every query carries an explicit `clinic_id` predicate, correct under the
 * service role as well as the dentist's session. Targets resolve only through
 * patients live in this clinic at `asOf`; a result deleted or cancelled by `asOf`
 * confirms nothing (see result-events.ts).
 *
 * ## Nothing recorded after asOf
 *
 * A completion, snapshot or snooze recorded after `asOf` was not known at `asOf`
 * and is not read, whatever moment it names. Results are read from state history
 * as known at `asOf` where history reaches back to the completion, and labelled
 * `current_state` where it does not. Metric readings carry their provenance.
 *
 * ## No patient leaves this file
 *
 * Confirmations are returned as delays in days per completion. The patient ids
 * used to compute them stay here.
 *
 * ## Failures throw; withheld kinds are declared
 *
 * A failed query is not an empty history. A kind the session may not read is
 * passed in `withhold`, never read, and reported as withheld.
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database.types";
import type {
  ActionHistoryKind,
  ActionHistoryPort,
  ActionHistoryScope,
  ActionHistorySlice,
  CompletionConfirmationFact,
  CompletionHistoryFact,
  DismissalFact,
  FindingSnapshotFact,
  MetricReadingDay,
  SnapshotFinding,
  SnapshotRootCause,
} from "@/business-brain";
import { EvidenceSource, type EvidenceTiming, type ResultEvidence } from "@/business-brain";
import { OUTCOME_SPEC_BY_CATEGORY, type VerificationTarget } from "@/business-brain/engines/outcome";
import { getUtcBoundariesForLocalDate } from "@/lib/utils";
import { readUpTo } from "./paged-read";
import { livePatientsAt, readHistoryCaptures, readResultEvents, resultTiming } from "./result-events";

const DAY_MS = 86_400_000;

/** Calendar days from `from` to `to`, inclusive. */
function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
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

export interface ActionHistoryOptions {
  /** Kinds this session must not read, reported as withheld rather than empty. */
  readonly withhold?: readonly ActionHistoryKind[];
}

export class SupabaseActionHistory implements ActionHistoryPort {
  private readonly withhold: ReadonlySet<ActionHistoryKind>;

  constructor(
    private readonly db: SupabaseClient<Database>,
    private readonly timezone: string = "UTC",
    options: ActionHistoryOptions = {},
  ) {
    this.withhold = new Set(options.withhold ?? []);
  }

  async readActionHistory(scope: ActionHistoryScope): Promise<ActionHistorySlice> {
    if (scope.from > scope.to) throw new RangeError(`Action history starts after it ends: ${scope.from} > ${scope.to}.`);
    if (!Number.isInteger(scope.limit) || scope.limit < 1) throw new RangeError(`Action history limit must be a positive integer.`);

    const truncated = new Set<ActionHistoryKind>();
    const start = getUtcBoundariesForLocalDate(scope.from, this.timezone).start;
    const endOfTo = getUtcBoundariesForLocalDate(scope.to, this.timezone).end;
    const end = endOfTo < scope.asOf ? endOfTo : scope.asOf;

    const [completions, snapshots, dismissals, metricDays] = await Promise.all([
      this.withhold.has("action_completion") ? Promise.resolve([]) : this.readCompletions(scope, start, end, truncated),
      this.withhold.has("finding_snapshot") ? Promise.resolve([]) : this.readSnapshots(scope, truncated),
      this.withhold.has("dismissal") ? Promise.resolve([]) : this.readDismissals(scope, start, truncated),
      this.withhold.has("metric_history") ? Promise.resolve([]) : this.readMetricDays(scope, truncated),
    ]);
    const confirmations = this.withhold.has("action_completion")
      ? []
      : await this.readConfirmations(scope, completions, truncated);

    const withheld = [...this.withhold];
    if (this.withhold.has("action_completion")) withheld.push("completion_confirmation");
    return {
      clinicId: scope.clinicId,
      scope,
      timezone: this.timezone,
      completions,
      confirmations,
      snapshots,
      dismissals,
      metricDays,
      truncated: [...truncated].sort(),
      withheld: [...new Set(withheld)].sort(),
    };
  }

  private async readCompletions(
    scope: ActionHistoryScope,
    start: string,
    end: string,
    truncated: Set<ActionHistoryKind>,
  ): Promise<CompletionHistoryFact[]> {
    const { rows, truncated: cut } = await readUpTo<CompletionRow>(
      "action history (action_completions)",
      (from, to) =>
        this.db
          .from("action_completions")
          .select("id, category, constraint_id, completed_at, source, target_patient_ids, metric_key, metric_value")
          .eq("clinic_id", scope.clinicId)
          .gte("completed_at", start)
          .lte("completed_at", end)
          // A completion recorded after asOf was not known at asOf, whatever moment it names.
          .lte("created_at", scope.asOf)
          .order("completed_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      scope.limit,
    );
    if (cut) truncated.add("action_completion");
    return rows.map((r) => ({
      clinicId: scope.clinicId,
      id: r.id,
      category: r.category,
      constraintId: r.constraint_id,
      // Passed through as stored, exactly as the existing completion reader does.
      completedAt: r.completed_at,
      source: r.source === "inferred" ? "inferred" : "declared",
      targetPatientIds: r.target_patient_ids ?? [],
      metricKey: r.metric_key,
      metricValue: r.metric_value === null ? null : Number(r.metric_value),
    }));
  }

  /**
   * What followed each completion, as delays with their evidence kind. Patient ids
   * never leave this method.
   *
   * Each completion's evidence is read as known at the scope's `asOf`, from state
   * history when history reaches back to the completion (see result-events.ts),
   * and from current rows — labelled as such — when it does not.
   */
  private async readConfirmations(
    scope: ActionHistoryScope,
    completions: readonly CompletionHistoryFact[],
    truncated: Set<ActionHistoryKind>,
  ): Promise<CompletionConfirmationFact[]> {
    const facts = new Map<string, CompletionConfirmationFact>();
    const groups = new Map<string, { target: VerificationTarget; timing: EvidenceTiming; completions: CompletionHistoryFact[] }>();
    const captures = completions.length === 0 ? [] : await readHistoryCaptures(this.db);
    for (const c of completions) {
      const verifies = OUTCOME_SPEC_BY_CATEGORY.get(c.category)?.verifies ?? null;
      if (verifies === null) {
        facts.set(c.id, { completionId: c.id, targeted: c.targetPatientIds.length, resolvable: 0, verifiable: false, delaysDays: [], results: [] });
        continue;
      }
      const timing = resultTiming(captures, verifies, c.completedAt);
      if (c.targetPatientIds.length === 0) {
        facts.set(c.id, { completionId: c.id, targeted: 0, resolvable: 0, verifiable: true, delaysDays: [], results: [], timing });
        continue;
      }
      const key = `${verifies}|${timing}`;
      const group = groups.get(key) ?? { target: verifies, timing, completions: [] };
      group.completions.push(c);
      groups.set(key, group);
    }

    for (const key of [...groups.keys()].sort()) {
      const { target, timing, completions: group } = groups.get(key) as { target: VerificationTarget; timing: EvidenceTiming; completions: CompletionHistoryFact[] };
      const ids = [...new Set(group.flatMap((c) => c.targetPatientIds))];
      const earliest = new Date(Math.min(...group.map((c) => Date.parse(c.completedAt)))).toISOString();
      const live = await livePatientsAt(this.db, scope.clinicId, ids, scope.asOf, timing);
      const read = await readResultEvents(this.db, {
        clinicId: scope.clinicId,
        target,
        patientIds: ids.filter((id) => live.has(id)),
        since: earliest,
        knownAt: scope.asOf,
        timing,
        limit: scope.limit,
      });
      if (read.truncated) truncated.add("completion_confirmation");

      for (const c of group) {
        const completedMs = Date.parse(c.completedAt);
        const resolvable = c.targetPatientIds.filter((id) => live.has(id));
        const delay = (at: string) => Math.round(((Date.parse(at) - completedMs) / DAY_MS) * 100) / 100;
        const delaysDays: number[] = [];
        const results: ResultEvidence[] = [];
        for (const id of resolvable) {
          const after = read.events.filter((e) => e.patientId === id && Date.parse(e.at) >= completedMs);
          if (after.length === 0) continue;
          delaysDays.push(delay(after[0].at));
          const observed = after.find((e) => e.source === EvidenceSource.OBJECTIVELY_OBSERVED);
          const chosen = observed ?? after[0];
          results.push({ delayDays: delay(chosen.at), source: chosen.source });
        }
        facts.set(c.id, {
          completionId: c.id,
          targeted: c.targetPatientIds.length,
          resolvable: resolvable.length,
          verifiable: true,
          delaysDays: delaysDays.sort((a, b) => a - b),
          results: results.sort((a, b) => a.delayDays - b.delayDays || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0)),
          timing,
        });
      }
    }
    return completions.map((c) => facts.get(c.id) as CompletionConfirmationFact);
  }

  private async readSnapshots(scope: ActionHistoryScope, truncated: Set<ActionHistoryKind>): Promise<FindingSnapshotFact[]> {
    const { rows, truncated: cut } = await readUpTo<{ business_date: string; findings: unknown; run_health: string; recorded_at: string }>(
      "action history (finding_snapshots)",
      (from, to) =>
        this.db
          .from("finding_snapshots")
          .select("business_date, findings, run_health, recorded_at")
          .eq("clinic_id", scope.clinicId)
          .gte("business_date", scope.from)
          .lte("business_date", scope.to)
          .order("business_date", { ascending: true })
          .range(from, to),
      scope.limit,
    );
    if (cut) truncated.add("finding_snapshot");
    return rows.flatMap((r) => {
      // Recorded after asOf: not yet known as shown.
      if (Date.parse(r.recorded_at) > Date.parse(scope.asOf)) return [];
      const findings = Array.isArray(r.findings) ? r.findings.flatMap(snapshotFinding) : [];
      const runHealth = r.run_health === "healthy" ? "healthy" : "unknown";
      // An empty snapshot from before run health was tracked may be a failed run
      // rendered as a quiet briefing. That day is unknown, not "nothing shown".
      if (runHealth === "unknown" && findings.length === 0) return [];
      return [{ clinicId: scope.clinicId, date: r.business_date, findings, runHealth }];
    });
  }

  private async readDismissals(scope: ActionHistoryScope, start: string, truncated: Set<ActionHistoryKind>): Promise<DismissalFact[]> {
    // Previously cut silently at the limit, so a snooze past it read as never placed.
    const { rows, truncated: cut } = await readUpTo<{ category: string; created_at: string; expires_at: string }>(
      "action history (problem_dismissals)",
      (from, to) =>
        this.db
          .from("problem_dismissals")
          .select("category, created_at, expires_at")
          .eq("clinic_id", scope.clinicId)
          .lte("created_at", scope.asOf)
          .gte("expires_at", start)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      scope.limit,
    );
    if (cut) truncated.add("dismissal");
    return rows.map((r) => ({
      clinicId: scope.clinicId,
      category: r.category,
      dismissedAt: new Date(r.created_at).toISOString(),
      expiresAt: new Date(r.expires_at).toISOString(),
    }));
  }

  private async readMetricDays(scope: ActionHistoryScope, truncated: Set<ActionHistoryKind>): Promise<MetricReadingDay[]> {
    if (scope.metricKeys.length === 0) return [];
    // Every requested key for every day of the scope, with room: a read larger
    // than that is not a history read and is reported as cut.
    const cap = scope.metricKeys.length * (daysInclusive(scope.from, scope.to) + 1);
    const { rows, truncated: cut } = await readUpTo<{ metric_date: string; metric_key: string; value: number | string; provenance: string }>(
      "action history (metric_history)",
      (from, to) =>
        this.db
          .from("metric_history")
          .select("metric_date, metric_key, value, provenance")
          .eq("clinic_id", scope.clinicId)
          .in("metric_key", scope.metricKeys as string[])
          .gte("metric_date", scope.from)
          .lte("metric_date", scope.to)
          .order("metric_date", { ascending: true })
          .order("metric_key", { ascending: true })
          .range(from, to),
      cap,
    );
    if (cut) truncated.add("metric_history");
    const byDate = new Map<string, { values: Record<string, number>; provenance: Record<string, string> }>();
    for (const r of rows) {
      const value = Number(r.value);
      if (!Number.isFinite(value)) continue;
      const day = byDate.get(r.metric_date) ?? { values: {}, provenance: {} };
      day.values[r.metric_key] = value;
      day.provenance[r.metric_key] = r.provenance;
      byDate.set(r.metric_date, day);
    }
    return [...byDate.entries()].map(([date, day]) => ({ date, values: day.values, provenance: day.provenance }));
  }
}

/** Accept only well-formed snapshot entries; anything else is dropped, never guessed. */
function snapshotFinding(raw: unknown): SnapshotFinding[] {
  if (typeof raw !== "object" || raw === null) return [];
  const r = raw as Record<string, unknown>;
  if (typeof r.findingId !== "string" || typeof r.kind !== "string" || typeof r.role !== "string") return [];
  return [
    {
      findingId: r.findingId,
      kind: r.kind,
      polarity: typeof r.polarity === "string" ? r.polarity : "negative",
      category: typeof r.category === "string" ? r.category : null,
      role: r.role,
      rank: typeof r.rank === "number" ? r.rank : null,
      severity: typeof r.severity === "string" ? r.severity : null,
      actionable: r.actionable === true,
      suppressed: r.suppressed === true,
      ...(Array.isArray(r.rootCauses) ? { rootCauses: r.rootCauses.flatMap(snapshotRootCause) } : {}),
    },
  ];
}

function snapshotRootCause(raw: unknown): SnapshotRootCause[] {
  if (typeof raw !== "object" || raw === null) return [];
  const r = raw as Record<string, unknown>;
  const outcome = r.outcome;
  if (typeof r.question !== "string" || (outcome !== "explained" && outcome !== "no_concentration" && outcome !== "insufficient_evidence")) return [];
  const associations = Array.isArray(r.associations)
    ? r.associations.flatMap((a) => {
        const x = a as Record<string, unknown>;
        return typeof x?.dimension === "string" && typeof x.group === "string" && x.dimension !== "treatment_type"
          ? [{ dimension: x.dimension, group: x.group }]
          : [];
      })
    : [];
  return [{ question: r.question, outcome, associations }];
}
