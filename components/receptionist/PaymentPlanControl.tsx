"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock } from "lucide-react";
import { setPaymentPlan } from "@/actions/payments";
import { CalendarPicker } from "@/components/ui/calendar-picker";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/utils";

/**
 * Marks a patient's outstanding balance as under an agreed payment plan.
 *
 * The balance itself is unaffected everywhere it is shown — this is not a
 * discount and not a write-off. It exists so the Business Brain can size how
 * much of the clinic's outstanding total is already being collected on
 * schedule versus genuinely needs chasing, rather than treating a patient
 * paying ₹5,000/month by arrangement the same as one who has stopped paying.
 */
export function PaymentPlanControl({
  patientId,
  paymentPlanUntil,
}: {
  patientId: string;
  paymentPlanUntil: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(() => defaultDate());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const active = paymentPlanUntil !== null && paymentPlanUntil >= todayIso();

  function submit() {
    setError(null);
    startTransition(async () => {
      const res = await setPaymentPlan(patientId, date);
      if (res.error) {
        setError(res.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  function clear() {
    setError(null);
    startTransition(async () => {
      const res = await setPaymentPlan(patientId, null);
      if (res.error) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  if (active) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="inline-flex items-center gap-1 text-[11px] text-text-secondary bg-surface-muted rounded-full px-2 py-0.5">
          <CalendarClock className="h-3 w-3" aria-hidden />
          Payment plan to {formatDate(paymentPlanUntil)}
        </span>
        <button
          type="button"
          onClick={clear}
          disabled={pending}
          className="text-[11px] text-text-disabled hover:text-text-body underline underline-offset-2 cursor-pointer disabled:opacity-50"
        >
          Remove
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[11px] text-text-disabled hover:text-text-body underline underline-offset-2 cursor-pointer"
      >
        On a payment plan?
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <CalendarPicker
        value={date}
        min={todayIso()}
        onChange={setDate}
        placeholder="Pick a date"
        className="h-8 w-40 px-2.5 py-1 text-xs"
      />
      <button
        type="button"
        onClick={submit}
        disabled={pending}
        className={cn(
          "rounded-md bg-accent text-accent-foreground px-2 py-1 text-xs font-medium cursor-pointer",
          pending && "opacity-50",
        )}
      >
        Save
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="text-xs text-text-secondary hover:text-text-body cursor-pointer"
      >
        Cancel
      </button>
      {error && <span className="text-[11px] text-danger">{error}</span>}
    </div>
  );
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Three months out — a reasonable starting point for a first-time plan. */
function defaultDate(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 3);
  return d.toISOString().slice(0, 10);
}
