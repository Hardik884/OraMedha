/**
 * lib/messaging/reminder-subject.ts
 *
 * What a reminder was about, resolved at the moment it is marked sent, from the
 * same populations the send list is built from (actions/messaging.ts):
 *
 *   recall_invitation         the patient's longest-overdue pending follow-up
 *   treatment_plan_follow_up  the patient's most recently planned treatment
 *                             (the one the list names)
 *   payment_reminder          the patient's outstanding balance
 *
 * A subject that cannot be resolved is null — unknown, never "about nothing".
 * Nothing is asked of the staff member: the subject is filled automatically.
 */

import type { ActionDraftKind } from "@/business-brain";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = any;

export interface ReminderSubject {
  readonly subject_follow_up_id: string | null;
  readonly subject_treatment_id: string | null;
  readonly subject_amount: number | null;
}

const NONE: ReminderSubject = { subject_follow_up_id: null, subject_treatment_id: null, subject_amount: null };

export async function resolveReminderSubject(
  db: DbClient,
  params: { clinicId: string; patientId: string; kind: ActionDraftKind; today: string },
): Promise<ReminderSubject> {
  const { clinicId, patientId, kind, today } = params;

  if (kind === "recall_invitation") {
    const { data, error } = await db
      .from("follow_ups")
      .select("id")
      .eq("clinic_id", clinicId)
      .eq("patient_id", patientId)
      .eq("status", "pending")
      .is("deleted_at", null)
      .lt("due_date", today)
      .order("due_date", { ascending: true })
      .order("id", { ascending: true })
      .limit(1);
    if (error) return NONE;
    return { ...NONE, subject_follow_up_id: ((data ?? []) as { id: string }[])[0]?.id ?? null };
  }

  if (kind === "treatment_plan_follow_up") {
    const { data, error } = await db
      .from("treatments")
      .select("id")
      .eq("clinic_id", clinicId)
      .eq("patient_id", patientId)
      .eq("status", "planned")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(1);
    if (error) return NONE;
    return { ...NONE, subject_treatment_id: ((data ?? []) as { id: string }[])[0]?.id ?? null };
  }

  if (kind === "payment_reminder") {
    const { data, error } = await db.rpc("clinic_outstanding_balances");
    if (error) return NONE;
    const row = ((data ?? []) as { patient_id: string; balance: number | string }[]).find((r) => r.patient_id === patientId);
    // The aggregate lists only patients who owe something; absent is unknown here
    // (the balance may have been settled since the list was built), not zero.
    return { ...NONE, subject_amount: row === undefined ? null : Number(row.balance) };
  }

  return NONE;
}
