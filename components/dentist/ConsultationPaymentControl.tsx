"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, X } from "lucide-react";

import { updateConsultancyIncome } from "@/actions/consultants";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn, formatCurrency } from "@/lib/utils";

interface ConsultationPaymentControlProps {
  consultationId: string;
  /** Current fee. NULL means "not yet known", which is a real state here. */
  amount: number | null;
  isPaid: boolean;
}

/**
 * ConsultationPaymentControl — the editable fee and the Paid / Not Paid switch
 * on one external-consultation row.
 *
 * WHY BOTH ARE EDITABLE AFTER THE FACT
 *   A consultation is routinely booked before the fee is agreed and paid some
 *   time after that. When the amount was required at creation and fixed
 *   afterwards, the only ways to correct it were to invent a number at booking
 *   time or to delete and re-enter the row — and re-entering would drop the
 *   reserved time block along with it.
 *
 *   The two are separate controls because they are separate facts: knowing what
 *   a consultation is worth is not the same as having been paid for it, and
 *   collapsing them would make an unpaid invoice indistinguishable from an
 *   unpriced one. The dashboard Actions card counts the unpaid ones.
 *
 * Clearing the amount is allowed and means "not known yet" — which is why the
 * action treats an absent field and an explicit null differently.
 */
export function ConsultationPaymentControl({
  consultationId,
  amount,
  isPaid,
}: ConsultationPaymentControlProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(amount == null ? "" : String(amount));
  const [error, setError] = useState<string | null>(null);

  function save(next: { amount?: number | null; is_paid?: boolean }) {
    setError(null);
    startTransition(async () => {
      const res = await updateConsultancyIncome(consultationId, next);
      if (res.error) {
        setError(res.error);
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  function commitAmount() {
    const trimmed = draft.trim();
    if (trimmed === "") {
      save({ amount: null });
      return;
    }
    const value = Number(trimmed);
    if (!Number.isFinite(value) || value < 0) {
      setError("Enter a valid amount.");
      return;
    }
    save({ amount: value });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center justify-end gap-2">
        {editing ? (
          <>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={draft}
              autoFocus
              disabled={isPending}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitAmount();
                if (e.key === "Escape") {
                  setEditing(false);
                  setDraft(amount == null ? "" : String(amount));
                  setError(null);
                }
              }}
              placeholder="Not set"
              aria-label="Amount earned"
              className="h-8 w-28 text-right"
            />
            <Button size="xs" onClick={commitAmount} isLoading={isPending} aria-label="Save amount">
              <Check className="h-3 w-3" aria-hidden />
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={isPending}
              onClick={() => {
                setEditing(false);
                setDraft(amount == null ? "" : String(amount));
                setError(null);
              }}
              aria-label="Cancel"
            >
              <X className="h-3 w-3" aria-hidden />
            </Button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="group inline-flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-surface-muted transition-colors"
            aria-label="Edit amount earned"
          >
            <span
              className={cn(
                "font-medium tabular-nums",
                amount == null ? "text-text-disabled" : "text-text-primary"
              )}
            >
              {amount == null ? "Not set" : formatCurrency(amount)}
            </span>
            <Pencil
              className="h-3 w-3 text-text-disabled group-hover:text-text-secondary transition-colors"
              aria-hidden
            />
          </button>
        )}
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={isPaid}
        disabled={isPending}
        onClick={() => save({ is_paid: !isPaid })}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-50",
          isPaid
            ? "bg-success-bg text-success border-success-border"
            : "bg-surface text-text-secondary border-border hover:bg-surface-muted"
        )}
      >
        <span
          className={cn(
            "inline-block h-2.5 w-2.5 rounded-full border transition-colors",
            isPaid ? "bg-success border-success" : "bg-transparent border-border-strong"
          )}
          aria-hidden
        />
        {isPaid ? "Paid" : "Not Paid"}
      </button>

      {error && <p className="text-[11px] text-danger">{error}</p>}
    </div>
  );
}
