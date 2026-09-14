"use server";

import { z } from "zod";
import type { ActionDraftKind } from "@/business-brain";
import type { ActionResult } from "@/types";
import { resolveSession } from "@/lib/auth/session";
import { isWhatsAppEnabled } from "@/lib/feature-flags";
import { messageTemplateFor } from "@/lib/messaging/templates";
import { fillTemplate } from "@/lib/messaging/whatsapp";
import { buildReachable, dedupeByPatientId, type Candidate } from "@/lib/messaging/reminders-core";
import {
  ALLOWED_KINDS,
  REMINDER_COOLDOWN_DAYS,
  type ReminderSummary,
  type WhatsAppRecipient,
  type WhatsAppSendList,
} from "@/lib/messaging/reminder-types";
import { formatCurrency, formatDate } from "@/lib/utils";
import { getOverdueFollowUps, todayForClinic } from "@/actions/follow-ups";
import { resolveReminderSubject } from "@/lib/messaging/reminder-subject";
import { getPatientsWithOutstandingBalance } from "@/actions/payments";
import { getPatientsWithPlannedTreatmentNoVisit } from "@/actions/treatments";
import { getClinicSettings } from "@/actions/clinic-settings";

/**
 * actions/messaging.ts
 *
 * The single source of truth for who receives a WhatsApp reminder.
 *
 * Every reminder kind resolves to ONE deduplicated, clinic-scoped population of
 * patients built here. The count the Morning Briefing shows ("Contact 12
 * patients") and the list a staff member opens are computed from that same
 * population, so they can never disagree — the old "16 said, 7 shown" gap came
 * from two code paths measuring different things (treatment rows vs. distinct
 * patients).
 *
 * Three filters are applied, in order, server-side:
 *   1. Distinct patients — one row per patient, never per treatment/follow-up.
 *   2. Reachable — a patient with no usable phone is dropped, because DentGrow
 *      cannot build a WhatsApp message for them. The underlying clinic problem
 *      stays on its own screen, reachable by other means.
 *   3. Not already reminded — a patient contacted for this kind inside the
 *      cooldown window is suppressed, so a refresh never re-offers a message the
 *      staff already sent.
 *
 * It only prepares. Nothing here sends a message. The staff member sends each
 * one by hand via the wa.me link the UI builds, then confirms it — which writes
 * a reminder_logs row through markReminderSent, closing filter (3).
 */

/** A near-term date to suggest in follow-up messages. Editable before sending. */
function suggestedDate(): string {
  return formatDate(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000));
}

/**
 * The distinct-patient population for a kind — deduped, one row per patient. Each
 * carries a plain `subject` (what it's about) and `reason` (why), shown in the
 * focused workflow. These are display strings only; the population, eligibility
 * and message templates are unchanged.
 */
async function candidatesFor(kind: ActionDraftKind): Promise<Candidate[]> {
  if (kind === "recall_invitation") {
    const list = (await getOverdueFollowUps()).data ?? [];
    // Ordered oldest-overdue first, so the row kept per patient is the one that
    // has been waiting longest. One reminder per patient, never per follow-up.
    return dedupeByPatientId(list, (f) => f.patient?.id)
      .filter((f) => f.patient)
      .map((f) => ({
        patientId: f.patient!.id,
        name: f.patient!.name,
        phone: f.patient!.phone,
        subject: "Follow-up",
        reason: "Follow-up is overdue",
        vars: { patient_name: f.patient!.name, suggested_date: suggestedDate() },
      }));
  }

  if (kind === "payment_reminder") {
    const list = (await getPatientsWithOutstandingBalance()).data ?? [];
    return list.map((p) => ({
      patientId: p.id,
      name: p.name,
      phone: p.phone,
      subject: "Outstanding balance",
      reason: `${formatCurrency(p.balance)} outstanding`,
      vars: { patient_name: p.name, amount_outstanding: formatCurrency(p.balance) },
    }));
  }

  // treatment_plan_follow_up
  const list = (await getPatientsWithPlannedTreatmentNoVisit()).data ?? [];
  return list.map((p) => ({
    patientId: p.id,
    name: p.name,
    phone: p.phone,
    subject: p.treatment_type,
    reason: "No next visit booked",
    vars: {
      patient_name: p.name,
      treatment_name: p.treatment_type,
      suggested_date: suggestedDate(),
    },
  }));
}

/**
 * The full computed picture for one kind: the total distinct-patient population
 * (with the problem, reachable or not) and the reachable recipients — everyone we
 * can message, each flagged with whether they were already contacted. Both public
 * entry points read from here so a count and a list are always the same set.
 *
 * Returns null when the caller is not allowed to see WhatsApp data at all.
 */
async function buildReminderData(
  kind: ActionDraftKind,
): Promise<{ total: number; reachable: WhatsAppRecipient[] } | null> {
  const { db, profile } = await resolveSession();
  if (!profile || profile.role === "patient") return null;
  if (!isWhatsAppEnabled(profile.clinic_id)) return null;

  const template = messageTemplateFor(kind);
  if (!template) return null;

  const candidates = await candidatesFor(kind);
  const total = candidates.length;
  if (total === 0) return { total, reachable: [] };

  // Patients already reminded for this kind inside the cooldown. They stay in the
  // list (flagged alreadySent) so the workflow shows honest progress rather than
  // re-offering a message the staff member has already sent.
  const since = new Date(Date.now() - REMINDER_COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: logs } = await db
    .from("reminder_logs")
    .select("patient_id")
    .eq("clinic_id", profile.clinic_id)
    .eq("kind", kind)
    .gte("sent_at", since);
  const remindedRecently = new Set(
    ((logs ?? []) as { patient_id: string }[]).map((l) => l.patient_id),
  );

  // Patients who have WITHDRAWN consent to be contacted. Read from the
  // data-processing consent ledger (20260903000200), which is the mechanism
  // that did not exist when the WhatsApp allow-list was introduced — the flag's
  // own comment noted "there is no patient-consent field in the schema yet".
  //
  // Only an explicit withdrawal removes anyone. `communications` defaults to
  // granted (see lib/data-consent.ts) because an appointment reminder is the
  // thing a patient booked an appointment in order to receive, so a patient who
  // has never been asked is not silently dropped from their own recall.
  const { data: withdrawals } = await db
    .from("patient_data_consent_state")
    .select("patient_id, decision")
    .eq("clinic_id", profile.clinic_id)
    .eq("category", "communications")
    .eq("decision", "withdrawn");

  const optedOut = new Set(
    ((withdrawals ?? []) as { patient_id: string }[]).map((w) => w.patient_id),
  );

  const settings = (await getClinicSettings()).data;
  const clinicVars = {
    clinic_name: settings?.clinic_name ?? "our clinic",
    clinic_phone: settings?.phone ?? "the clinic",
  };

  // Everyone reachable (valid phone, message filled and free of {{markers}} —
  // never generate a broken action), flagged with whether they were already sent.
  const reachable = buildReachable(
    candidates,
    remindedRecently,
    (vars) => fillTemplate(template.body, { ...clinicVars, ...vars }),
    optedOut,
  );

  return { total, reachable };
}

/**
 * The send list for one kind. `recipients` is every reachable patient (paged if
 * asked), each carrying `alreadySent`, and `total` is the full reachable length —
 * so the focused workflow can walk all of them, show progress, and never silently
 * drop a patient.
 */
export async function getWhatsAppSendList(
  kind: ActionDraftKind,
  paging?: { limit?: number; offset?: number },
): Promise<ActionResult<WhatsAppSendList>> {
  try {
    if (!ALLOWED_KINDS.includes(kind)) {
      return { data: null, error: "Unsupported message type." };
    }
    const data = await buildReminderData(kind);
    if (!data) return { data: null, error: "WhatsApp reminders are not available." };

    const offset = Math.max(0, paging?.offset ?? 0);
    const recipients =
      paging?.limit != null
        ? data.reachable.slice(offset, offset + Math.max(0, paging.limit))
        : data.reachable;

    return { data: { recipients, total: data.reachable.length }, error: null };
  } catch (err) {
    console.error("[getWhatsAppSendList] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

/**
 * Counts for every messageable kind, for the briefing. `total` drives the plain
 * problem count on the left ("14 patients have planned treatment"); `reachableTotal`
 * and `contacted` drive the compact summary card ("7 / 16 contacted") and the
 * focused workflow.
 */
export async function getReminderSummaries(): Promise<ActionResult<ReminderSummary[]>> {
  try {
    const { profile } = await resolveSession();
    if (!profile || profile.role === "patient") return { data: null, error: "Forbidden" };
    if (!isWhatsAppEnabled(profile.clinic_id)) return { data: [], error: null };

    const summaries: ReminderSummary[] = [];
    for (const kind of ALLOWED_KINDS) {
      const data = await buildReminderData(kind);
      if (!data) continue;
      summaries.push({
        kind,
        total: data.total,
        reachableTotal: data.reachable.length,
        contacted: data.reachable.filter((r) => r.alreadySent).length,
      });
    }
    return { data: summaries, error: null };
  } catch (err) {
    console.error("[getReminderSummaries] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}

const markSentSchema = z.object({
  kind: z.enum(["recall_invitation", "payment_reminder", "treatment_plan_follow_up"]),
  patientId: z.string().uuid(),
});

/**
 * Record that a staff member sent this patient the reminder for `kind`. Writes a
 * reminder_logs row (clinic-scoped by RLS), which removes the patient from the
 * kind's list for the cooldown window — this is what makes "Mark as sent"
 * survive a refresh instead of being ephemeral client state.
 *
 * The row also records what the reminder was about — the follow-up, the planned
 * treatment or the balance — resolved here from the same populations the send
 * list uses (migration 20260918100600), so an outcome is matched to the right
 * subject. Nothing extra is asked of the staff member.
 */
export async function markReminderSent(
  kind: ActionDraftKind,
  patientId: string,
): Promise<ActionResult<null>> {
  try {
    const parsed = markSentSchema.safeParse({ kind, patientId });
    if (!parsed.success) return { data: null, error: "Invalid input." };

    const { db, profile } = await resolveSession();
    if (!profile) return { data: null, error: "Unauthorized" };
    if (profile.role === "patient") return { data: null, error: "Forbidden" };
    if (!isWhatsAppEnabled(profile.clinic_id)) {
      return { data: null, error: "WhatsApp reminders are not enabled for this clinic." };
    }

    const subject = await resolveReminderSubject(db, {
      clinicId: profile.clinic_id,
      patientId: parsed.data.patientId,
      kind: parsed.data.kind,
      today: await todayForClinic(db, profile.clinic_id),
    });

    const { error } = await db.from("reminder_logs").insert({
      clinic_id: profile.clinic_id,
      patient_id: parsed.data.patientId,
      kind: parsed.data.kind,
      sent_by: profile.id,
      ...subject,
    });
    if (error) {
      console.error("[markReminderSent]", error);
      return { data: null, error: "Couldn't record the reminder." };
    }
    return { data: null, error: null };
  } catch (err) {
    console.error("[markReminderSent] unexpected:", err);
    return { data: null, error: "Unexpected error" };
  }
}
