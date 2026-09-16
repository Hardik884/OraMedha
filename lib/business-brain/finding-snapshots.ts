/**
 * lib/business-brain/finding-snapshots.ts
 *
 * Recording what the briefing showed a clinic today, so the learning loop can
 * later tell "recommended and left" from "never recommended".
 *
 * Same arrangement as `persist-metrics.ts`: the render stays read-only, the page
 * schedules this with `after()`, and the write uses the service role because no
 * client may author what a clinic was shown. First view of the day wins; a later
 * load the same day changes nothing, which the append-only trigger enforces too.
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database.types";
import type { PrioritizedFindings, RankedFinding, SnapshotFinding } from "@/business-brain";
import { createAdminClient } from "@/lib/supabase/admin";

/** Identifiers and ordinals only — no patient, amount or free text. Pure. */
export function snapshotFindings(
  findings: PrioritizedFindings,
  suppressedCategories: ReadonlySet<string>,
): SnapshotFinding[] {
  const all: RankedFinding[] = [
    ...(findings.top ? [findings.top] : []),
    ...findings.next,
    ...findings.supporting,
    ...findings.wins,
    ...findings.noActionRequired,
  ];
  return all
    .map((r) => ({
      findingId: r.finding.id,
      kind: r.finding.kind,
      polarity: r.finding.polarity,
      category: r.finding.category,
      role: r.role,
      rank: r.rank,
      severity: r.finding.evidence.severity,
      actionable: r.finding.evidence.actionable,
      suppressed: r.finding.category !== null && suppressedCategories.has(r.finding.category),
      ...(r.finding.evidence.rootCauses.length === 0
        ? {}
        : {
            rootCauses: r.finding.evidence.rootCauses.map((rc) => ({
              question: rc.question,
              outcome: rc.outcome,
              associations: rc.associations
                // Treatment type is clinic-entered text; it never enters a record of what was shown.
                .filter((a) => a.dimension !== "treatment_type")
                .map((a) => ({ dimension: a.dimension, group: a.id.slice(a.id.lastIndexOf(":") + 1) })),
            })),
          }),
    }))
    .sort((a, b) => (a.findingId < b.findingId ? -1 : a.findingId > b.findingId ? 1 : 0));
}

/**
 * Record one clinic-day's snapshot, once. Never throws: a lost snapshot is a day
 * the learning loop treats as unknown, which is exactly what it is.
 */
export async function recordFindingSnapshot(
  clinicId: string,
  businessDate: string,
  findings: readonly SnapshotFinding[],
  run: { readonly startedAt: string; readonly version: string },
  db?: SupabaseClient<Database>,
): Promise<boolean> {
  try {
    const client = db ?? (createAdminClient() as unknown as SupabaseClient<Database>);
    const { error } = await client
      .from("finding_snapshots")
      .upsert(
        {
          clinic_id: clinicId,
          business_date: businessDate,
          findings: findings as unknown as Database["public"]["Tables"]["finding_snapshots"]["Insert"]["findings"],
          // Only a healthy run is ever recorded (the page checks first). The
          // database refuses a run that did not start on this business day, or a
          // snapshot written long after it: what was shown is recorded by the run
          // that showed it, never regenerated later.
          run_health: "healthy",
          run_started_at: run.startedAt,
          brain_version: run.version,
        },
        { onConflict: "clinic_id,business_date", ignoreDuplicates: true },
      );
    if (error) {
      console.error("[recordFindingSnapshot]", error.message);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[recordFindingSnapshot]", error);
    return false;
  }
}
