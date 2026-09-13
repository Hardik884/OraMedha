"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, CheckCircle2, ChevronDown, MessageCircle, CalendarPlus, Bell } from "lucide-react";
import { completeAction } from "@/actions/business-brain";
import { cn } from "@/lib/utils";
import type { ActionCardView, PrimaryActionKind } from "@/lib/business-brain/briefing-view";
import type { ReminderSummary } from "@/lib/messaging/reminder-types";
import { AppointmentFormDialog } from "@/components/shared/AppointmentFormDialog";
import { FollowUpFormDialog } from "@/components/follow-ups/FollowUpFormDialog";
import { WhatsAppContactWorkflow } from "./WhatsAppContactWorkflow";

interface ActionCardProps {
  action: ActionCardView;
  /** This card's own patient-to-contact counts, when it has a WhatsApp action. */
  contactSummary?: ReminderSummary;
  /**
   * True when this category was already marked done today.
   *
   * Resolved on the server from the completion record, not from client state —
   * so it survives a refresh, which is the entire point of recording completions
   * durably. Shown as an acknowledgement, never as a reason to hide the card: the
   * card leaves when the underlying problem is actually solved, and saying it was
   * done is not the same as it being fixed.
   */
  completedToday?: boolean;
}

const ACTION_ICON: Record<PrimaryActionKind, typeof MessageCircle> = {
  contact_patients: MessageCircle,
  book_appointment: CalendarPlus,
  create_follow_up: Bell,
};

const PRIMARY_BTN_CLS =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-accent text-accent-foreground px-4 py-2.5 text-sm font-semibold shadow-sm hover:bg-accent-hover transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2";
const SECONDARY_BTN_CLS =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-border text-accent px-3.5 py-2 text-sm font-medium hover:bg-background transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20";

/**
 * One thing to do, right column.
 *
 * Hierarchy: an ACTION-oriented heading (never a restatement of the problem),
 * one or more buttons that perform the fix INLINE (no navigation away from
 * this page) — the FIRST one visually primary, any further ones secondary
 * beside it, never competing for top billing — and a "Steps" dropdown,
 * collapsed by default, holding the checklist and a lower-emphasis link to
 * the full list view. Only categories with at least one genuinely
 * single-click fix get a button at all; a card can offer more than one when
 * more than one applies (e.g. a planned-treatment patient can be contacted
 * about booking, or booked directly).
 *
 * Ticking the checklist is a progress aid only — it never removes the card. A
 * card leaves the briefing when the underlying problem is actually solved,
 * which the page discovers on its next load from live data, not from a
 * checkbox. So a ticked-but-unresolved problem stays visible, honestly, until
 * the real work lands — which is also why every inline action here calls
 * router.refresh() on completion: the next server read is the only thing
 * that legitimately moves a card or the health score.
 */
export function ActionCard({ action, contactSummary, completedToday = false }: ActionCardProps) {
  const router = useRouter();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [stepsOpen, setStepsOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [doneError, setDoneError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  function markDone() {
    setDoneError(null);
    startSaving(async () => {
      const res = await completeAction({
        category: action.category,
        constraintId: action.problemId,
        // Sent only when the dentist actually wrote something. An empty string
        // would fail the schema, and more importantly a note nobody wrote is not
        // a note.
        note: note.trim().length > 0 ? note.trim() : undefined,
      });
      if (res.error) {
        setDoneError(res.error);
        return;
      }
      setNoteOpen(false);
      setNote("");
      // The server is the only thing that legitimately changes what this page
      // shows — including whether this card now reads as done.
      router.refresh();
    });
  }

  const hasList = action.checklist.length > 0;
  const hasSteps = hasList || !!action.moreInfoLink;

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // "Contact Patients" only shows when there's someone left to reach —
  // mirrors the gating the standalone "Patients to contact" section used to
  // apply. Unknown (summary not loaded) fails open rather than hiding a real
  // action. Every other action kind is always offered when listed.
  const contactAllowed = !!action.messageKind && (!contactSummary || contactSummary.reachableTotal > 0);
  const visibleActions = action.primaryActions.filter(
    (a) => a.kind !== "contact_patients" || contactAllowed,
  );

  return (
    <section className="bg-surface border border-border rounded-xl overflow-hidden flex flex-col h-full">
      <div className="px-5 py-4 flex-1">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-text-body bg-surface-muted rounded px-2 py-0.5">
            {action.ownerLabel}
          </span>
          <span className="text-[11px] text-text-disabled">{action.timeframeLabel}</span>
        </div>
        <h3 className="text-[15px] font-semibold text-text-primary leading-snug">{action.title}</h3>
        <p className="text-sm text-text-secondary mt-1 leading-relaxed">{action.reason}</p>

        {/* Compact supporting info — who's reachable, shown even while collapsed. */}
        {contactSummary && visibleActions.some((a) => a.kind === "contact_patients") && (
          <p className="text-xs text-text-disabled mt-2">
            {contactSummary.reachableTotal > 0
              ? `${contactSummary.reachableTotal} ${contactSummary.reachableTotal === 1 ? "patient" : "patients"} ready to contact${
                  contactSummary.contacted > 0 ? ` · ${contactSummary.contacted} already contacted` : ""
                }`
              : contactSummary.total > 0
                ? `${contactSummary.total} identified — no phone number on file`
                : null}
          </p>
        )}

        {/* Actions — the obvious things to click, all performed inline. The
            first is visually primary; any further ones sit beside it as
            secondary buttons, never competing for top billing. */}
        {visibleActions.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {visibleActions.map((primaryAction, index) => {
              const Icon = ACTION_ICON[primaryAction.kind];
              const isPrimary = index === 0;
              const btnCls = isPrimary ? PRIMARY_BTN_CLS : SECONDARY_BTN_CLS;

              if (primaryAction.kind === "contact_patients") {
                return (
                  <button key={primaryAction.kind} type="button" onClick={() => setContactOpen(true)} className={btnCls}>
                    <Icon className="h-4 w-4" aria-hidden />
                    {primaryAction.label}
                  </button>
                );
              }

              if (primaryAction.kind === "book_appointment") {
                return (
                  <AppointmentFormDialog
                    key={primaryAction.kind}
                    title="Book Appointment"
                    triggerVariant={isPrimary ? "default" : "outline"}
                    triggerSize={isPrimary ? "lg" : "md"}
                    triggerClassName="gap-2 font-semibold"
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                    {primaryAction.label}
                  </AppointmentFormDialog>
                );
              }

              // create_follow_up
              return (
                <FollowUpFormDialog
                  key={primaryAction.kind}
                  title="Follow-up Appointment"
                  triggerVariant={isPrimary ? "default" : "outline"}
                  triggerSize={isPrimary ? "lg" : "md"}
                  triggerClassName="gap-2 font-semibold"
                >
                  <Icon className="h-4 w-4" aria-hidden />
                  {primaryAction.label}
                </FollowUpFormDialog>
              );
            })}
          </div>
        )}
      </div>

      {/* Steps — collapsed by default, holds the checklist and the "full
          list" link. Same expand/collapse idiom as the "Needs attention"
          cards (ProblemCard) so the two columns feel consistent. Collapsed,
          the card shows only the heading, compact info and the primary
          button — nothing here inflates the card's default height. */}
      {hasSteps && (
        <div>
          <button
            type="button"
            onClick={() => setStepsOpen((v) => !v)}
            aria-expanded={stepsOpen}
            className="w-full flex items-center justify-between gap-3 px-5 py-2.5 border-t border-surface-muted text-left hover:bg-background transition-colors cursor-pointer"
          >
            <span className="text-sm text-text-body">{stepsOpen ? "Hide steps" : "Steps"}</span>
            <ChevronDown
              className={cn("h-4 w-4 text-text-disabled shrink-0 transition-transform", stepsOpen && "rotate-180")}
              aria-hidden
            />
          </button>
          {stepsOpen && (
            <div className="px-5 pb-5 pt-1 space-y-3 animate-fade-in">
              {hasList && (
                <ul className="space-y-1.5">
                  {action.checklist.map((item) => {
                    const isChecked = checked.has(item.id);
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          onClick={() => toggle(item.id)}
                          className="w-full flex items-start gap-2.5 py-1.5 text-left group cursor-pointer"
                        >
                          <span
                            className={cn(
                              "mt-0.5 shrink-0 h-4 w-4 rounded border flex items-center justify-center transition-colors",
                              isChecked
                                ? "bg-success border-success"
                                : "border-border-strong group-hover:border-text-disabled",
                            )}
                          >
                            {isChecked && <Check className="h-3 w-3 text-success-foreground" strokeWidth={3} />}
                          </span>
                          <span
                            className={cn(
                              "text-sm leading-relaxed transition-colors",
                              isChecked ? "text-text-disabled line-through" : "text-text-body",
                            )}
                          >
                            {item.label}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {!hasList && (
                <p className="text-sm text-text-secondary leading-relaxed">
                  No checklist for this one — use the link below to work through it directly.
                </p>
              )}
              {action.moreInfoLink && (
                <Link
                  href={action.moreInfoLink.href}
                  className="inline-flex items-center gap-1 text-sm font-medium text-accent underline underline-offset-2 hover:no-underline"
                >
                  {action.moreInfoLink.label} →
                </Link>
              )}
            </div>
          )}
        </div>
      )}

      {/* Done — the durable record that the work happened.
          
          Deliberately quiet and deliberately last: it must never read as an
          easier alternative to the primary button above it, and pressing it
          changes nothing on screen except an acknowledgement. The card still
          leaves only when the underlying problem is genuinely solved, which the
          page discovers on its next read. Saying you did it is not the same as
          it being fixed, and the UI must not blur the two. */}
      <div className="border-t border-surface-muted px-5 py-2.5">
        {completedToday ? (
          <p className="flex items-center gap-1.5 text-sm text-success">
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
            Marked as done today
          </p>
        ) : noteOpen ? (
          <div className="space-y-2">
            <label htmlFor={`note-${action.id}`} className="block text-xs font-medium text-text-secondary">
              Anything worth noting? (optional)
            </label>
            <input
              id={`note-${action.id}`}
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={280}
              placeholder="e.g. reached 4, the rest are away"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-body placeholder:text-text-disabled focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={markDone}
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent text-accent-foreground px-3 py-1.5 text-sm font-semibold disabled:opacity-60 cursor-pointer"
              >
                {saving ? "Saving…" : "Mark as done"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setNoteOpen(false);
                  setNote("");
                  setDoneError(null);
                }}
                disabled={saving}
                className="text-sm text-text-secondary hover:text-text-body cursor-pointer"
              >
                Cancel
              </button>
            </div>
            {doneError && <p className="text-xs text-danger">{doneError}</p>}
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={markDone}
              disabled={saving}
              className="inline-flex items-center gap-1.5 text-sm text-text-body hover:text-text-primary transition-colors disabled:opacity-60 cursor-pointer"
            >
              <Check className="h-4 w-4 shrink-0" aria-hidden />
              {saving ? "Saving…" : "Mark as done"}
            </button>
            <button
              type="button"
              onClick={() => setNoteOpen(true)}
              disabled={saving}
              className="text-xs text-text-disabled hover:text-text-secondary transition-colors cursor-pointer"
            >
              Add a note
            </button>
            {doneError && <span className="text-xs text-danger">{doneError}</span>}
          </div>
        )}
      </div>

      {/* Inline "Contact Patients" — same self-contained workflow the old
          standalone "Patients to contact" section used, now opened directly
          from the card whose diagnosis it resolves. */}
      {action.messageKind && (
        <WhatsAppContactWorkflow
          kind={action.messageKind}
          title="Contact Patients"
          open={contactOpen}
          onClose={() => {
            setContactOpen(false);
            // The only thing that legitimately moves a card or the health
            // score is the next server read — refresh without a full
            // navigation, same pattern AppointmentFormDialog/
            // FollowUpFormDialog already use on success.
            router.refresh();
          }}
        />
      )}
    </section>
  );
}
