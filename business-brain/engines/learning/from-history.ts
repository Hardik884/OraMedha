/**
 * Business Brain — Learning Engine: from one history read to engine inputs
 *
 * The single place an `ActionHistorySlice` becomes what the Outcome and Learning
 * Engines consume, so the adapter stays a reader and the engines stay pure.
 *
 * The base Outcome Engine's target verification is derived from the SAME
 * confirmations the windowed evidence reads: "confirmed since the completion" is
 * every recorded result up to the read's `asOf`, which is exactly what the
 * original per-completion verifier counted. One read, two consistent uses.
 */

import { CompletionSource, type ActionCompletionRecord, type TargetVerification } from "../../domain";
import type { ActionHistorySlice } from "../../ledger";
import type { OutcomeHistoryInput } from "../outcome/attribution";
import { dedupeCompletions } from "../outcome/outcome-engine";
import { EvidenceSource, EvidenceTiming } from "../../provenance/evidence-quality";

export interface HistoryInputs {
  readonly completions: readonly ActionCompletionRecord[];
  readonly verifications: ReadonlyMap<string, TargetVerification>;
  readonly history: OutcomeHistoryInput;
  /** Withheld kinds by name; truncated completions as `action_completion_truncated`. */
  readonly gaps: readonly string[];
}

export function inputsFromHistory(slice: ActionHistorySlice): HistoryInputs {
  const gaps = [
    ...slice.withheld,
    ...slice.truncated.map((k) => (k === "action_completion" ? "action_completion_truncated" : k)),
  ];
  // Duplicates of one briefing card are one action; see `dedupeCompletions`.
  const completions: ActionCompletionRecord[] = dedupeCompletions(slice.completions.map((c) => ({
    id: c.id,
    category: c.category,
    constraintId: c.constraintId,
    completedAt: c.completedAt,
    source: c.source === "inferred" ? CompletionSource.INFERRED : CompletionSource.DECLARED,
    targetPatientIds: c.targetPatientIds,
    ...(c.metricKey !== null && c.metricValue !== null ? { metricKey: c.metricKey, metricValueAtCompletion: c.metricValue } : {}),
  })));
  const kept = new Set(completions.map((c) => c.id));
  const verifications = new Map<string, TargetVerification>(
    slice.confirmations.filter((f) => kept.has(f.completionId)).map((f) => [
      f.completionId,
      {
        completionId: f.completionId,
        targeted: f.targeted,
        resolvable: f.resolvable,
        confirmed: f.delaysDays.length,
        observed: (f.results ?? []).filter((r) => r.source === EvidenceSource.OBJECTIVELY_OBSERVED).length,
        verifiable: f.verifiable,
        timing: f.timing ?? EvidenceTiming.UNKNOWN,
      },
    ]),
  );
  return {
    completions,
    verifications,
    gaps: [...new Set(gaps)].sort(),
    history: {
      clinicId: slice.clinicId,
      timezone: slice.timezone,
      metricDays: slice.metricDays,
      confirmations: new Map(slice.confirmations.filter((f) => kept.has(f.completionId)).map((f) => [f.completionId, f])),
      gaps,
    },
  };
}
