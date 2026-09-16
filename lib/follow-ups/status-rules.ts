/**
 * lib/follow-ups/status-rules.ts
 *
 * The one rule for changing a follow-up's status, shared by every server path
 * and mirrored by the database trigger in migration 20260918100000:
 *
 *   - only a PENDING follow-up changes status; completed and cancelled are final
 *   - the change is pending → completed or pending → cancelled
 *   - the dentist makes it (completeFollowUp / cancelFollowUp are dentist-only)
 *
 * The one receptionist path that closes a follow-up is not an edit at all: the
 * completion cascade marks it completed when its recall appointment is completed
 * ("Mark Done & Call Next"). The database allows exactly that and nothing else.
 */

export type FollowUpStatusValue = "pending" | "completed" | "cancelled";

/** A user-facing error for a status change the rules forbid, or null when allowed. */
export function followUpStatusChangeError(
  role: string,
  from: FollowUpStatusValue,
  to: FollowUpStatusValue,
): string | null {
  if (from === to) return null;
  if (from !== "pending") return `A ${from} follow-up cannot be reopened or changed.`;
  if (role !== "dentist") return "Only the dentist can complete or cancel a follow-up.";
  return null;
}
