/**
 * lib/appointments/visit-completion.ts
 *
 * Which appointments the visit page's "Mark as Complete" may close, and on what
 * evidence. Pure: the server action and the page both ask the same question.
 *
 * ## Completing without a recorded arrival
 *
 * A dentist who saw a patient that nobody checked in may still mark the visit
 * complete. The appointment goes straight to `completed` through the ordinary
 * completion cascade. It does NOT pass through `checked_in` or `in_progress`,
 * because those are events — an arrival and a call-in — that did not happen in
 * OraMedha, and walking the lifecycle used to stamp them with the moment of the
 * click: a queue row checked in "now", dated today even for last week's visit,
 * never called, closed in the same second. Such a visit now simply has no queue
 * row, which every reader already treats as "arrival not recorded".
 *
 * ## Correcting an inferred no-show
 *
 * The nightly job marks a still-`scheduled` appointment `no_show` once its day
 * has ended, with no actor. That is an inference — the patient may have been
 * seen by a clinic that never updates the status. For a short window a dentist
 * may correct it to `completed`. A no-show a person recorded is final, as before.
 */

import type { AppointmentStatus } from "@/types";

/** Statuses a dentist may complete directly from the visit page. */
export const DIRECT_COMPLETION_FROM: readonly AppointmentStatus[] = ["scheduled", "checked_in"];

/** Days after the nightly job's inference during which a dentist may correct it. */
export const INFERRED_NO_SHOW_CORRECTION_DAYS = 7;

export interface HistoryRowLike {
  readonly action: string;
  readonly new_value: unknown;
  readonly performed_by: string | null;
  readonly timestamp: string;
}

/**
 * The moment the appointment was marked no-show, and whether a person did it.
 * Null when no history row records the no-show — the evidence is missing, so it
 * is not treated as inferred.
 */
export function noShowEvidence(history: readonly HistoryRowLike[]): { at: string; inferred: boolean } | null {
  const marks = history
    .filter((h) => (h.new_value as { status?: string } | null)?.status === "no_show")
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const latest = marks[0];
  if (latest === undefined) return null;
  return { at: latest.timestamp, inferred: latest.performed_by === null };
}

/** Whether a no-show was inferred by the system recently enough to be corrected. */
export function isCorrectableNoShow(
  status: string,
  history: readonly HistoryRowLike[],
  now: string,
): boolean {
  if (status !== "no_show") return false;
  const evidence = noShowEvidence(history);
  if (evidence === null || !evidence.inferred) return false;
  const ageMs = Date.parse(now) - Date.parse(evidence.at);
  return ageMs >= 0 && ageMs <= INFERRED_NO_SHOW_CORRECTION_DAYS * 86_400_000;
}
