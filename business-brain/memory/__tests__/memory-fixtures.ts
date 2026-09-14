/**
 * Literal evidence for the Clinic Memory specs.
 *
 * Today is Monday 2026-09-14 in a UTC clinic. Readings reuse the learning
 * fixtures' noisy series (19, 20, 21 …), so a steady metric around 20 has a
 * normal range of 16–24 once the baseline floor is applied.
 */

import type { ClinicDecisionFact, ClinicMemory, ClinicMemoryEntry, MemoryType } from "../../domain";
import type { FindingSnapshotFact, SnapshotFinding } from "../../ledger";
import { addDays } from "../../utils";
import { CLINIC, DATE, snapshot, snapshotFinding } from "../../engines/learning/__tests__/learning-fixtures";
import { deriveClinicMemory, type ClinicMemoryInput } from "../memory-engine";

export { CLINIC, DATE };

export function build(over: Partial<ClinicMemoryInput> = {}): ClinicMemory {
  return deriveClinicMemory({
    clinicId: CLINIC,
    date: DATE,
    timezone: "UTC",
    metricDays: [],
    snapshots: [],
    outcomes: [],
    dismissals: [],
    decisions: [],
    gaps: [],
    ...over,
  });
}

export function entryOf(memory: ClinicMemory, type: MemoryType, key: string, qualifier: string | null = null): ClinicMemoryEntry | undefined {
  return memory.entries.find((e) => e.type === type && e.subject.key === key && e.subject.qualifier === qualifier);
}

export const weekdayOf = (date: string) => new Date(`${date}T12:00:00.000Z`).getUTCDay();

/** One snapshot per date, `flagged(index, date)` deciding which findings it carries. */
export function days(from: string, to: string, findings: (index: number, date: string) => SnapshotFinding[]): FindingSnapshotFact[] {
  const out: FindingSnapshotFact[] = [];
  let i = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(snapshot(d, findings(i++, d)));
  return out;
}

export const problem = (category = "retention") => snapshotFinding(category);

export const opportunity = (date: string) =>
  snapshotFinding("forward_schedule", {
    findingId: `finding.opportunity:opportunity.forward_capacity_match:${CLINIC}:${date}`,
    kind: "opportunity",
    polarity: "opportunity",
    role: "next",
  });

export function decision(over: Partial<ClinicDecisionFact> & { target: ClinicDecisionFact["target"] }): ClinicDecisionFact {
  return {
    id: `d_${over.target.id}_${over.decidedAt ?? "1"}`,
    clinicId: CLINIC,
    proposalKind: over.target.type === "proposal" ? "action_preference" : null,
    subject: "retention",
    decision: "accepted",
    decidedAt: "2026-09-10T09:00:00.000Z",
    basis: { level: "strong_evidence" },
    ...over,
  };
}

/** Every string anywhere in a value, for the no-prose and no-PII checks. */
export function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(strings);
  return [];
}
