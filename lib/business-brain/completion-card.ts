/**
 * Which briefing card a completion may be recorded against.
 *
 * A card's constraint id is `constraint.<category>:<clinic>:<date>`, and the
 * browser sends it back when Done is pressed. It is checked, not trusted: one
 * naming another clinic or category — or days old, from a stale page — would be
 * stored against history it never belonged to, and the learning engines refuse a
 * clinic's whole history on a cross-tenant id. The database enforces the shape
 * (`chk_action_completions_constraint_id`); this enforces the meaning.
 */

import { addDays } from "@/business-brain";

/** A completion may name a briefing card from at most this many days ago. */
export const COMPLETION_CARD_MAX_AGE_DAYS = 7;

const CARD = /^constraint\.([a-z_]+):([0-9a-f-]{36}):(\d{4}-\d{2}-\d{2})$/;

/**
 * True when `constraintId` is a card this clinic's briefing could have shown for
 * `category` recently. `today` is the clinic-local business date; tomorrow is
 * allowed for a page left open across midnight in a timezone ahead of the server.
 */
export function isCurrentCompletionCard(constraintId: string, category: string, clinicId: string, today: string): boolean {
  const card = CARD.exec(constraintId);
  if (card === null) return false;
  const [, cardCategory, cardClinic, cardDate] = card;
  return (
    cardCategory === category &&
    cardClinic === clinicId.toLowerCase() &&
    cardDate <= addDays(today, 1) &&
    cardDate >= addDays(today, -COMPLETION_CARD_MAX_AGE_DAYS)
  );
}
