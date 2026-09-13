/**
 * lib/business-brain/outcomes-view.ts
 *
 * The projection behind "what happened after".
 *
 * Same split as `briefing-view.ts` and `wins-view.ts`: the Outcome Engine states
 * measurements, this file writes the sentences. Copy in the engine would put
 * product wording behind a determinism guarantee it does not need; arithmetic
 * here would put it somewhere untested.
 *
 * ## The one rule this file exists to enforce
 *
 * Every sentence keeps two claims apart:
 *
 *   COMPLETED — someone said they did it.
 *   VERIFIED  — the clinic's data confirms the intended result for the specific
 *               patients the action targeted.
 *
 * And none of them joins those to a third claim the data cannot support. No
 * "because", no "caused", no "resulted in", no "thanks to", no "led to". The
 * strongest connective available is temporal: "since", "now", "after".
 *
 * ## Why a worsening is never rendered
 *
 * A metric that moved the wrong way is recorded honestly by the engine
 * (`improved: false`) and is NOT turned into a line here. The asymmetry is
 * deliberate: the data cannot support a causal claim in either direction, and
 * the harm of telling a clinic their work made something worse far exceeds the
 * benefit of occasionally being right. So the movement line appears only when the
 * movement helped; otherwise the completion is reported on its own.
 */

import type { Outcome } from "@/business-brain";
import { OutcomeAttribution } from "@/business-brain";

/** One completed action, ready to render. */
export interface OutcomeView {
  readonly id: string;
  readonly category: string;
  /** What was done, in three or four words. */
  readonly title: string;
  /** When, as a clinic would say it: "Today", "Yesterday", "12 Sep". */
  readonly whenLabel: string;
  /**
   * The verified entity fact, or null when nothing could be confirmed.
   *
   * Null is common and correct — most categories have no confirmable population —
   * and it renders as absence rather than as a zero.
   */
  readonly verified: string | null;
  /**
   * The subsequent measurement, or null.
   *
   * Present only at `observed_after` AND only when the movement helped. Phrased
   * as a sequence throughout.
   */
  readonly movement: string | null;
  /** Whether the clinic's data confirmed anything at all about the targets. */
  readonly isVerified: boolean;
}

/** What each category's action was, in the clinic's words rather than the key. */
const TITLE: Readonly<Record<string, string>> = {
  retention: "Worked the overdue recall list",
  revenue_leakage: "Followed up outstanding payments",
  treatment_acceptance: "Chased unbooked treatment plans",
  reactivation: "Contacted patients who had stopped coming",
  capacity: "Worked on filling chair time",
  forward_schedule: "Worked on next week's schedule",
  scheduling: "Worked on lost appointments",
  patient_flow: "Worked on waiting times",
  schedule_accuracy: "Reviewed booking lengths",
  acquisition: "Followed up new-patient enquiries",
};

/** How each tracked metric reads aloud, for the movement line. */
const METRIC_NOUN: Readonly<Record<string, string>> = {
  "followups.overdue": "The overdue recall list",
  "revenue.outstanding": "The amount owed",
  "treatment.accepted_pending_scheduling": "The number of patients with no next visit",
  "patients.reactivation_candidates": "The number of patients who had stopped coming",
};

const CURRENCY_METRICS: ReadonlySet<string> = new Set(["revenue.outstanding"]);

function formatMetric(key: string, value: number): string {
  if (CURRENCY_METRICS.has(key)) return `₹${Math.round(value).toLocaleString("en-IN")}`;
  return String(Math.round(value));
}

/** "Today", "Yesterday", or a short date. */
export function whenLabel(completedAt: string, now: string): string {
  const days = wholeDaysBetween(completedAt, now);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(completedAt).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  });
}

function wholeDaysBetween(from: string, to: string): number {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / 86_400_000);
}

/**
 * The verified entity sentence, or null.
 *
 * Returns null rather than "0 of 8" when nothing could be checked. The two read
 * identically to a scanner and mean opposite things, and a clinic shown a zero
 * where the truth is "we cannot tell" would reasonably conclude its work failed.
 */
function verifiedLine(outcome: Outcome): string | null {
  const targets = outcome.targets;
  if (targets === undefined || !targets.verifiable) return null;
  if (targets.resolvable === 0) return null;

  const noun = targets.resolvable === 1 ? "patient" : "patients";
  return `${targets.confirmed} of ${targets.resolvable} ${noun} contacted have since been seen to`;
}

/**
 * The subsequent measurement, or null.
 *
 * "Since then" is the strongest connective permitted. It states that one reading
 * followed another and stops — which is the whole of what the data supports.
 */
function movementLine(outcome: Outcome): string | null {
  const metric = outcome.metric;
  if (outcome.attribution !== OutcomeAttribution.OBSERVED_AFTER) return null;
  if (metric === undefined) return null;
  // The asymmetry. A worsening is never rendered; see the file header.
  if (!metric.improved) return null;

  const noun = METRIC_NOUN[metric.key];
  if (noun === undefined) return null;

  return `Since then, ${noun.toLowerCase()} has gone from ${formatMetric(metric.key, metric.before)} to ${formatMetric(metric.key, metric.after)}`;
}

/** Project assessed outcomes into the history list. Pure. */
export function buildOutcomeViews(
  outcomes: readonly Outcome[],
  now: string,
): readonly OutcomeView[] {
  return outcomes.map((outcome) => {
    const verified = verifiedLine(outcome);
    return {
      id: outcome.id,
      category: outcome.category,
      title: TITLE[outcome.category] ?? "Completed an action",
      whenLabel: whenLabel(outcome.completedAt, now),
      verified,
      movement: movementLine(outcome),
      isVerified: verified !== null,
    };
  });
}

/**
 * The "what happened after" line attached to a positive outcome, or null.
 *
 * Deliberately conservative, and deliberately narrow: it fires only when the
 * clinic completed an action in the SAME dimension the win is about, within the
 * window the win describes, and that action's targets could actually be
 * confirmed.
 *
 * It does not claim the action produced the win, and the wording carries no
 * connective that could be read that way. Two facts sit next to each other:
 * something was done, and these specific patients have since been seen to. That
 * is the honest limit of what OraMedha can say today — the attribution ladder
 * that could say more (`likely_contributed`) is not built, and inventing its
 * conclusion here would be the exact failure the ladder exists to prevent.
 */
export function outcomeContextFor(
  metricKey: string,
  windowDays: number,
  outcomes: readonly Outcome[],
  now: string,
): string | null {
  const nowMs = Date.parse(now);
  const windowMs = Math.max(1, windowDays) * 86_400_000;

  // The most recent completion whose tracked metric is the win's own metric, and
  // whose targets were genuinely confirmable.
  const relevant = outcomes
    .filter((o) => o.metric?.key === metricKey)
    .filter((o) => o.targets !== undefined && o.targets.verifiable && o.targets.resolvable > 0)
    .filter((o) => {
      const at = Date.parse(o.completedAt);
      return !Number.isNaN(at) && at <= nowMs && nowMs - at <= windowMs;
    })
    .sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1));

  const outcome = relevant[0];
  if (outcome === undefined || outcome.targets === undefined) return null;

  const action = (TITLE[outcome.category] ?? "An action was completed").toLowerCase();
  const targets = outcome.targets;
  const noun = targets.resolvable === 1 ? "patient" : "patients";

  return (
    `You ${action} ${whenLabel(outcome.completedAt, now).toLowerCase()}. ` +
    `Of the ${targets.resolvable} ${noun} that covered, ${targets.confirmed} have since been seen to. ` +
    // Deliberately avoids the word "cause" and its relatives even while denying
    // them, so the no-causal-language scan needs no exceptions.
    `These are two things that both happened; nothing here shows a link between them.`
  );
}
