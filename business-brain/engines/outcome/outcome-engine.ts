/**
 * Business Brain — Outcome Engine
 *
 * What happened after the clinic did the thing.
 *
 * This is the first stage past Action, and it closes a loop that has been open
 * since the module was built: every recommendation the Morning Briefing made was
 * followed by silence. It answers one question, deterministically —
 * "you completed this; here is what the data says followed" — and refuses to
 * answer the question nobody can, which is whether the one caused the other.
 *
 * ## Two claims, kept apart
 *
 * COMPLETED is someone's word. VERIFIED is the clinic's own data confirming the
 * intended result for the specific patients the action targeted. Both travel on
 * every Outcome, separately, so a reader is never shown the stronger one when
 * only the weaker is supported.
 *
 * ## The ladder, and where it stops
 *
 * `insufficient_evidence` and `observed_after`, and nothing above them.
 *
 *   insufficient_evidence  the action was completed; nothing measurable can be
 *                          said about what followed.
 *   observed_after         the headline metric was measurable on both sides, so
 *                          the sequence can be stated.
 *
 * `likely_contributed` needs a normal-variation test against this clinic's own
 * baseline plus concentration of the improvement in the targeted entities;
 * `strong_evidence` needs that repeated across periods. Neither is implemented,
 * and this engine may not emit them. The entity facts they will rest on ARE
 * recorded here, as facts, so that rung can be built later without re-deriving
 * history — but they are not promoted.
 *
 * ## Why it will not say "because"
 *
 * No control group, no randomisation, and one confounder that dominates: a
 * clinic working its recall list this week is a clinic paying attention this
 * week, and that attention moves numbers the action never touched. Worse, an
 * action is recommended BECAUSE a number was unusual, and unusual numbers
 * regress toward the mean on their own — so a causal model would report success
 * nearly every time and every report would read as confirmation.
 *
 * One asymmetry follows from the same honesty and is deliberate: a metric that
 * moved the WRONG way is recorded factually (`improved: false`) and never framed
 * as a consequence of the action. The ladder only climbs.
 *
 * ## Pure
 *
 * Completions, verifications and metrics in; outcomes out. No Supabase, no HTTP,
 * no model, no clock, no randomness — `now` is supplied by the caller, exactly
 * as every other engine in this module requires.
 */

import {
  CompletionSource,
  OutcomeAttribution,
  OutcomeStatus,
  type ActionCompletionRecord,
  type Metric,
  type Outcome,
  type OutcomeMetricMovement,
  type TargetVerification,
} from "../../domain";
import { BaselineDirection } from "../baseline";
import { OUTCOME_SPEC_BY_CATEGORY } from "./outcome-catalog";

export interface OutcomeEngineInput {
  /** Completions to assess, in any order. */
  readonly completions: readonly ActionCompletionRecord[];
  /**
   * Entity-level findings per completion, resolved by the adapter with a
   * clinic-scoped query. A completion absent from this map is treated as
   * unverified rather than as verified-with-zero.
   */
  readonly verifications: ReadonlyMap<string, TargetVerification>;
  /** The current run's metrics — the "after" side of any movement. */
  readonly metrics: readonly Metric[];
  /** Logical assessment time, injected. */
  readonly now: string;
}

export interface OutcomeResult {
  /** One outcome per completion, newest completion first. */
  readonly outcomes: readonly Outcome[];
}

/** Metric ids are `<key>:<clinicId>:<date>`; the key never contains a colon. */
function metricValue(metrics: readonly Metric[], key: string): number | undefined {
  const found = metrics.find((m) => m.id.startsWith(`${key}:`));
  return found && Number.isFinite(found.value) ? found.value : undefined;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Was the movement in the direction that helps for this metric?
 *
 * A strict inequality: a metric that did not move at all has not improved, and
 * reporting a flat reading as an improvement would be the smallest possible lie
 * and the easiest to repeat.
 */
function didImprove(delta: number, direction: BaselineDirection): boolean {
  return direction === BaselineDirection.LOWER_IS_BETTER ? delta < 0 : delta > 0;
}

/**
 * Describe the target findings in words, or say plainly that nothing could be
 * checked.
 *
 * The `verifiable: false` case is the one worth reading carefully. "0 of 8
 * confirmed" and "this cannot be confirmed" are completely different statements,
 * and a clinic shown the first when the second is true would reasonably conclude
 * its work achieved nothing.
 */
function describeTargets(verification: TargetVerification | undefined): string {
  if (verification === undefined || !verification.verifiable) {
    return "The intended result of this action is not something the records can confirm, so nothing is claimed about it.";
  }
  if (verification.targeted === 0) {
    return "This action had no identifiable patients to target, so there is nothing to confirm.";
  }
  if (verification.resolvable === 0) {
    return `${verification.targeted} patient(s) were targeted, and none of those records is still available to check.`;
  }
  const missing = verification.targeted - verification.resolvable;
  const caveat =
    missing > 0
      ? ` ${missing} of the originally targeted record(s) is no longer available to check.`
      : "";
  return `${verification.confirmed} of ${verification.resolvable} targeted patient(s) show the intended result in the records since.${caveat}`;
}

/**
 * Assess what followed each completed action.
 *
 * Every completion produces exactly one Outcome. A completion the engine can say
 * nothing measurable about still produces one, at `insufficient_evidence` — the
 * alternative is dropping it, which would make "we could not measure this"
 * indistinguishable from "this never happened".
 */
export function deriveOutcomes(input: OutcomeEngineInput): OutcomeResult {
  const outcomes: Outcome[] = [];

  for (const completion of input.completions) {
    const spec = OUTCOME_SPEC_BY_CATEGORY.get(completion.category);
    const verification = input.verifications.get(completion.id);

    // ── The metric half ──────────────────────────────────────────────────────
    //
    // Three things must all hold: the category declares a headline metric, the
    // completion captured its reading at the time, and it is measurable now.
    // Any one absent and there is no sequence to state.
    let movement: OutcomeMetricMovement | undefined;
    if (
      spec?.metricKey != null &&
      spec.direction != null &&
      completion.metricKey === spec.metricKey &&
      completion.metricValueAtCompletion !== undefined &&
      Number.isFinite(completion.metricValueAtCompletion)
    ) {
      const after = metricValue(input.metrics, spec.metricKey);
      if (after !== undefined) {
        const before = completion.metricValueAtCompletion;
        const delta = round2(after - before);
        movement = {
          key: spec.metricKey,
          before: round2(before),
          after: round2(after),
          delta,
          improved: didImprove(delta, spec.direction),
        };
      }
    }

    // ── The rung ─────────────────────────────────────────────────────────────
    //
    // Exactly one thing decides it: whether a movement could be measured. The
    // entity facts do NOT raise it — promoting concentration in the targets to a
    // stronger claim is `likely_contributed`, which is not implemented and must
    // not be reached by accident.
    const attribution =
      movement === undefined
        ? OutcomeAttribution.INSUFFICIENT_EVIDENCE
        : OutcomeAttribution.OBSERVED_AFTER;

    outcomes.push({
      id: `outcome.${completion.id}`,
      completionId: completion.id,
      category: completion.category,
      constraintId: completion.constraintId,
      status: OutcomeStatus.COMPLETED,
      source: completion.source,
      completedAt: completion.completedAt,
      attribution,
      targets: verification,
      metric: movement,
      reasoning: reasonFor(completion, verification, movement),
      recordedAt: input.now,
    });
  }

  // Newest completion first, then by id so two runs over identical data produce
  // byte-identical output.
  outcomes.sort((a, b) =>
    a.completedAt === b.completedAt
      ? a.id.localeCompare(b.id)
      : a.completedAt < b.completedAt
        ? 1
        : -1,
  );

  return { outcomes };
}

/**
 * Why the assessment landed where it did.
 *
 * Factual throughout. States what was recorded, what was checked, and what
 * moved — never what it means, never what to do, and never that one thing
 * produced another.
 */
function reasonFor(
  completion: ActionCompletionRecord,
  verification: TargetVerification | undefined,
  movement: OutcomeMetricMovement | undefined,
): string {
  const how =
    completion.source === CompletionSource.DECLARED
      ? "Recorded as completed by a member of staff."
      : "Recorded as completed from clinic data rather than by a person.";

  const metricPart =
    movement === undefined
      ? "No headline measurement was available on both sides of the completion, so nothing is stated about what followed."
      // Worded to avoid the word "cause" even in denial: the no-causal-language
      // test scans for the token, and a guard sentence that has to be
      // special-cased makes the guard weaker for everyone who adds to it later.
      : `The headline measurement read ${movement.before} at the time of completion and reads ${movement.after} now. These are two readings in sequence, with no link asserted between them.`;

  return `${how} ${describeTargets(verification)} ${metricPart}`;
}
