/**
 * Pattern: unclustered_signal
 *
 * The safety net. Any signal that no other pattern claimed becomes its own
 * minimal diagnosis so that nothing silently disappears between the Signal Engine
 * and whatever consumes diagnoses next.
 *
 * It runs after the registry, because it needs to know what the other matchers
 * claimed. Patterns are overlapping views rather than a partition, so "claimed"
 * means "contributed to at least one diagnosis", not "consumed".
 *
 * Its single hypothesis restates the signal's own measured condition and is always
 * `undetermined`: one observation in isolation cannot imply a cause. That is the
 * whole point of the pattern catalogue — correlation is what licenses reasoning
 * about causes, and there is none here.
 *
 * Unlike every other pattern, this one can produce several diagnoses for one
 * clinic-day, so its ids carry the signal type as a qualifier.
 *
 * ## The one exception: signals that are declared supporting-only
 *
 * A signal in {@link SUPPORTING_ONLY} is skipped here rather than promoted. These
 * are rules whose own documentation says they are not a finding on their own —
 * they exist to sharpen another pattern's discrimination, and in isolation they
 * are genuinely ambiguous. Carrying one forward as "Unclustered signal: patients
 * are waiting a long time for an appointment" would state as a standalone
 * observation exactly the claim its evaluator refuses to make.
 *
 * The list is deliberately tiny and deliberately explicit. The default remains
 * that nothing disappears silently; this is the narrow case where surfacing a
 * signal alone would say something the signal does not support.
 */

import {
  DiagnosisPattern,
  SignalCategory,
  SignalType,
  type Diagnosis,
  type Signal,
} from "../../../domain";
import { buildDiagnosis } from "../support/diagnosis-builder";
import { signalTypeOf } from "../support/signal-index";
import type { MatcherContext, MatcherOutcome } from "./types";

/**
 * Signals that must never be reported on their own.
 *
 * `long_booking_lead_time` strengthens `capacity_ceiling` and nothing else. A long
 * median wait to be seen is equally consistent with a booked-out clinic and with
 * patients simply choosing later dates; only read alongside near-full capacity
 * does it mean the first. Its evaluator says so in as many words, and this list is
 * what makes that statement true of the pipeline rather than just of the comment.
 */
const SUPPORTING_ONLY: ReadonlySet<string> = new Set<string>([
  SignalType.SCHEDULING_LONG_BOOKING_LEAD_TIME,
]);

/** Signals claimed by no pattern become one minimal diagnosis each. */
export function matchUnclustered(
  ctx: MatcherContext,
  claimedSignalIds: ReadonlySet<string>,
): MatcherOutcome {
  const orphans = ctx.signals.all.filter(
    (signal) =>
      !claimedSignalIds.has(signal.id) && !SUPPORTING_ONLY.has(signalTypeOf(signal)),
  );
  if (orphans.length === 0) {
    return {
      kind: "not_matched",
      reason: `Every emitted signal contributed to at least one pattern; no unclustered signal remains.`,
    };
  }

  const diagnoses: Diagnosis[] = [];
  const suppressed: string[] = [];
  for (const signal of orphans) {
    const outcome = buildDiagnosis(ctx, draftFor(signal));
    if (outcome.kind === "diagnosis") diagnoses.push(outcome.diagnosis);
    else suppressed.push(`${signalTypeOf(signal)}: ${outcome.reason}`);
  }

  if (diagnoses.length === 0) {
    return {
      kind: "not_matched",
      reason: `All ${orphans.length} unclustered signal(s) were suppressed. ${suppressed.join(" ")}`,
    };
  }
  return { kind: "matched", diagnoses };
}

function draftFor(signal: Signal) {
  const type = signalTypeOf(signal);
  return {
    pattern: DiagnosisPattern.UNCLUSTERED_SIGNAL,
    category: signal.category ?? SignalCategory.OPERATIONAL,
    title: `Unclustered signal: ${signal.title}`,
    summary: `${signal.description} No other signal in this run correlates with it, so it is carried forward on its own rather than as part of a wider pattern.`,
    contributing: [signal],
    // The signal itself is the pattern's only requirement, and it is present.
    requiredSignals: [type],
    optionalSignals: [],
    idQualifier: type,
    hypotheses: [
      {
        slug: "measured_condition",
        statement: `The condition the signal measures holds: ${signal.description}`,
        status: "undetermined" as const,
        supporting: [
          {
            slug: "signal-evidence",
            description: `Carried from the signal's own evidence: ${(signal.evidence ?? [])
              .map((item) => item.description)
              .join("; ")}`,
            data: { signalId: signal.id, severity: signal.severity },
          },
        ],
        requires: ["LONGER_HISTORY_WINDOW" as const],
      },
    ],
    discriminators: [
      {
        key: "LONGER_HISTORY_WINDOW" as const,
        separates: ["measured_condition"],
      },
    ],
    evidence: [
      {
        slug: "unclustered",
        description: `This signal contributed to no pattern in the catalogue, so no correlation licenses reasoning about a cause. It is reported to keep it visible to later phases.`,
        data: { signalType: type },
      },
    ],
  };
}
