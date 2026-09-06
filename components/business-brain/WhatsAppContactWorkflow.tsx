"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  MessageCircle,
  Copy,
  Check,
  Pencil,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
} from "lucide-react";
import type { ActionDraftKind } from "@/business-brain";
import { Dialog } from "@/components/ui/dialog";
import { getWhatsAppSendList, markReminderSent } from "@/actions/messaging";
import type { WhatsAppRecipient } from "@/lib/messaging/reminder-types";
import { firstUnsentIndex, nextUnsentIndex } from "@/lib/messaging/reminders-core";
import { buildWhatsAppLink } from "@/lib/messaging/whatsapp";

/**
 * The focused, one-patient-at-a-time WhatsApp workflow.
 *
 * Opened from the compact summary in the Morning Briefing, it walks the staff
 * member through the reachable patients for one reminder kind: review a clean
 * message preview, open WhatsApp, confirm the send, move to the next. The
 * Morning Briefing never shows the messages — this modal owns "who do I contact
 * and what do I say", WhatsApp owns "send it".
 *
 * State that matters survives: a confirmed send is written to reminder_logs
 * (markReminderSent), so reopening or refreshing restores progress. Skipping is
 * deliberately NOT recorded — a skipped patient stays pending and can be
 * revisited. Nothing here marks the underlying clinic problem resolved; that
 * only happens when the Business Brain sees the real data change.
 */
export function WhatsAppContactWorkflow({
  kind,
  title,
  open,
  onClose,
  onSent,
}: {
  kind: ActionDraftKind;
  title: string;
  open: boolean;
  onClose: () => void;
  /** Fired after a patient is confirmed sent, so the summary card can update live. */
  onSent?: (patientId: string) => void;
}) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [recipients, setRecipients] = useState<WhatsAppRecipient[]>([]);
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  // Load the reachable list once each time the workflow opens.
  useEffect(() => {
    if (!open) return;
    let active = true;
    setState("loading");
    getWhatsAppSendList(kind).then((res) => {
      if (!active) return;
      if (res.error || !res.data) {
        setState("error");
        return;
      }
      const list = [...res.data.recipients];
      const already = new Set(list.filter((r) => r.alreadySent).map((r) => r.patientId));
      setRecipients(list);
      setSent(already);
      setIndex(firstUnsentIndex(list, already) ?? 0);
      setState("ready");
    });
    return () => {
      active = false;
    };
  }, [kind, open]);

  const total = recipients.length;
  const contacted = sent.size;
  const allDone = total > 0 && contacted >= total;

  const advance = useCallback(
    (from: number) => {
      setSent((prevSent) => {
        const next = nextUnsentIndex(recipients, prevSent, from);
        if (next != null) setIndex(next);
        return prevSent;
      });
    },
    [recipients],
  );

  if (!open) return null;

  const progress =
    state === "ready" && total > 0
      ? allDone
        ? `${contacted} of ${total} contacted`
        : `Patient ${index + 1} of ${total} · ${contacted} of ${total} contacted`
      : undefined;

  return (
    <Dialog open={open} onClose={onClose} title={title} description={progress} size="md">
      <div className="px-6 py-5">
        {state === "loading" && <p className="text-sm text-text-disabled py-6 text-center">Loading patients…</p>}

        {state === "error" && (
          <p className="text-sm text-warning py-6 text-center">
            Couldn&apos;t load the list right now. The rest of OraMedha still works.
          </p>
        )}

        {state === "ready" && total === 0 && (
          <p className="text-sm text-text-secondary py-6 text-center">No one to contact right now.</p>
        )}

        {state === "ready" && total > 0 && allDone && (
          <div className="py-8 text-center">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-success-bg mb-3">
              <CheckCircle2 className="h-6 w-6 text-success" aria-hidden />
            </div>
            <h3 className="text-base font-semibold text-text-primary">All patients contacted</h3>
            <p className="text-sm text-text-secondary mt-1">{contacted} of {total} contacted.</p>
            <button
              type="button"
              onClick={onClose}
              className="mt-5 inline-flex items-center rounded-lg bg-text-primary text-accent-foreground px-4 py-2 text-sm font-medium hover:bg-accent-hover transition-colors cursor-pointer"
            >
              Done
            </button>
          </div>
        )}

        {state === "ready" && total > 0 && !allDone && (
          <PatientStep
            key={recipients[index].patientId}
            kind={kind}
            recipient={recipients[index]}
            done={sent.has(recipients[index].patientId)}
            message={drafts[recipients[index].patientId] ?? recipients[index].message}
            edited={drafts[recipients[index].patientId] != null}
            onMessageChange={(v) =>
              setDrafts((d) => ({ ...d, [recipients[index].patientId]: v }))
            }
            onSent={() => {
              const pid = recipients[index].patientId;
              setSent((s) => new Set(s).add(pid));
              onSent?.(pid);
              advance(index);
            }}
            onSkip={() => advance(index)}
            canPrev={index > 0}
            canNext={index < total - 1}
            onPrev={() => setIndex((i) => Math.max(0, i - 1))}
            onNext={() => setIndex((i) => Math.min(total - 1, i + 1))}
          />
        )}
      </div>
    </Dialog>
  );
}

function PatientStep({
  kind,
  recipient,
  done,
  message,
  edited,
  onMessageChange,
  onSent,
  onSkip,
  canPrev,
  canNext,
  onPrev,
  onNext,
}: {
  kind: ActionDraftKind;
  recipient: WhatsAppRecipient;
  done: boolean;
  message: string;
  edited: boolean;
  onMessageChange: (v: string) => void;
  onSent: () => void;
  onSkip: () => void;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const link = useMemo(() => buildWhatsAppLink(recipient.phone, message), [recipient.phone, message]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable; no-op */
    }
  }

  async function confirmSent() {
    if (saving) return;
    setSaving(true);
    await markReminderSent(kind, recipient.patientId);
    setSaving(false);
    setAwaitingConfirm(false);
    onSent();
  }

  return (
    <div>
      {/* Who + why */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-text-primary leading-tight">{recipient.name}</h3>
          <p className="text-sm text-text-body mt-0.5">{recipient.subject}</p>
        </div>
        {done && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-success-hover bg-success-bg rounded-full px-2 py-0.5 shrink-0">
            <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
            Contacted
          </span>
        )}
      </div>
      <p className="mt-2 inline-block text-xs text-text-secondary bg-surface-muted rounded px-2 py-0.5">
        {recipient.reason}
      </p>

      {/* Message: clean preview, edit only on demand */}
      <div className="mt-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wider text-text-disabled">Message</span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={copy}
              className="inline-flex items-center gap-1 text-xs font-medium text-text-secondary hover:text-accent transition-colors cursor-pointer"
            >
              {copied ? <Check className="h-3 w-3 text-success" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              onClick={() => setEditing((e) => !e)}
              className="inline-flex items-center gap-1 text-xs font-medium text-text-secondary hover:text-accent transition-colors cursor-pointer"
            >
              <Pencil className="h-3 w-3" aria-hidden />
              {editing ? "Done" : edited ? "Edited" : "Edit message"}
            </button>
          </div>
        </div>
        {editing ? (
          <textarea
            value={message}
            onChange={(e) => onMessageChange(e.target.value)}
            rows={6}
            autoFocus
            className="mt-1.5 w-full resize-none rounded-lg border border-border bg-surface px-3 py-2.5 text-sm leading-relaxed text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/15"
          />
        ) : (
          <p className="mt-1.5 rounded-lg border border-border bg-background px-3 py-2.5 text-sm leading-relaxed text-text-strong whitespace-pre-wrap">
            {message}
          </p>
        )}
      </div>

      {/* Primary action / confirmation */}
      {awaitingConfirm ? (
        <div className="mt-4 rounded-lg border border-border bg-background p-3">
          <p className="text-sm font-medium text-text-primary">Did you send this message?</p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={confirmSent}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-lg bg-success text-success-foreground px-3.5 py-2 text-sm font-medium hover:bg-success-hover transition-colors cursor-pointer disabled:opacity-60"
            >
              <Check className="h-4 w-4" strokeWidth={2.5} aria-hidden />
              {saving ? "Saving…" : "Yes, mark as sent"}
            </button>
            <button
              type="button"
              onClick={() => setAwaitingConfirm(false)}
              className="inline-flex items-center rounded-lg border border-border text-text-body px-3.5 py-2 text-sm font-medium hover:bg-surface transition-colors cursor-pointer"
            >
              No, keep pending
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex items-center gap-3">
          {link ? (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setAwaitingConfirm(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-success text-success-foreground px-4 py-2.5 text-sm font-medium hover:bg-success-hover transition-colors cursor-pointer"
            >
              <MessageCircle className="h-4 w-4" aria-hidden />
              Open WhatsApp
            </a>
          ) : (
            <span className="text-sm text-text-disabled">No usable phone number for this patient.</span>
          )}
          <button
            type="button"
            onClick={onSkip}
            className="inline-flex items-center text-sm font-medium text-text-secondary hover:text-accent transition-colors cursor-pointer"
          >
            Skip
          </button>
        </div>
      )}

      {/* Manual navigation — the primary flow rarely needs it */}
      <div className="mt-6 pt-4 border-t border-surface-muted flex items-center justify-between">
        <button
          type="button"
          onClick={onPrev}
          disabled={!canPrev}
          className="inline-flex items-center gap-1 text-sm font-medium text-text-body hover:text-text-primary transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Previous
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!canNext}
          className="inline-flex items-center gap-1 text-sm font-medium text-text-body hover:text-text-primary transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Next
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
