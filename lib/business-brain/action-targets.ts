/**
 * lib/business-brain/action-targets.ts
 *
 * Who an action was about, resolved SERVER-SIDE.
 *
 * ## Why the browser never supplies this
 *
 * Entity-level verification only means anything if the targets are the real
 * population the briefing displayed. A request body carrying a list of patient
 * ids would be a client-controlled claim about which patients a clinic worked —
 * and worse, a client-controlled set of ids to be matched against clinic data
 * later. So the server action sends nothing but the category, and this module
 * derives the population from the same readers the briefing itself used.
 *
 * Every reader below is already clinic-scoped and role-guarded, and resolves the
 * clinic from the caller's own session. This file adds no query of its own, which
 * is the point: one definition of "the patients this card is about", used by the
 * card, the send list and the completion record alike.
 *
 * ## Three categories, and honest silence for the rest
 *
 * The three are exactly the ones the Morning Briefing builds a patient list for.
 * The others target nobody identifiable — an idle chair has no population — and
 * returning an empty array for those is not a shortcoming, it is what makes the
 * completion record say "unverifiable" rather than "nobody was helped".
 */

import "server-only";

import { getOverdueFollowUps } from "@/actions/follow-ups";
import { getPatientsWithOutstandingBalance } from "@/actions/payments";
import { getPatientsWithPlannedTreatmentNoVisit } from "@/actions/treatments";

/**
 * Categories whose action has an identifiable patient population.
 *
 * Declared as a set rather than inferred, so adding a category to the briefing
 * cannot silently start producing empty target lists that read as verified.
 */
export const TARGETABLE_CATEGORIES: ReadonlySet<string> = new Set([
  "retention",
  "revenue_leakage",
  "treatment_acceptance",
]);

/**
 * The distinct patient ids an action in this category is about, right now.
 *
 * Returns an empty array for any category with no identifiable population, and
 * for any failure — a completion that cannot resolve its targets is still worth
 * recording as completed, and an empty target list is reported downstream as
 * "nothing to confirm" rather than as a failed verification.
 *
 * Deduplicated, because every population is per-patient: a patient with three
 * overdue follow-ups is one person to call, and counting them three times would
 * inflate both the denominator and any later confirmation rate.
 */
export async function resolveActionTargets(category: string): Promise<string[]> {
  if (!TARGETABLE_CATEGORIES.has(category)) return [];

  try {
    if (category === "retention") {
      const list = (await getOverdueFollowUps()).data ?? [];
      return distinct(list.map((f) => f.patient?.id));
    }
    if (category === "revenue_leakage") {
      const list = (await getPatientsWithOutstandingBalance()).data ?? [];
      return distinct(list.map((p) => p.id));
    }
    // treatment_acceptance
    const list = (await getPatientsWithPlannedTreatmentNoVisit()).data ?? [];
    return distinct(list.map((p) => p.id));
  } catch (error) {
    console.error("[resolveActionTargets]", category, error);
    return [];
  }
}

/** Distinct, defined ids, in first-seen order. */
function distinct(ids: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id === "string" && id.length > 0) seen.add(id);
  }
  return [...seen];
}
