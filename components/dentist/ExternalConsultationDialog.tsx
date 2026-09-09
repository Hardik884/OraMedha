"use client";

import { useState, useTransition, type ReactNode } from "react";
import { recordConsultancyIncome } from "@/actions/consultants";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button, type ButtonVariant, type ButtonSize } from "@/components/ui/button";
import { Check, CircleDollarSign } from "lucide-react";
import { Field } from "@/components/ui/field";
import { CalendarPicker } from "@/components/ui/calendar-picker";
import { cn } from "@/lib/utils";

interface ExternalConsultationDialogProps {
  /** Class names applied to the trigger button. */
  triggerClassName?: string;
  /** When set, the trigger renders via the shared Button for consistent styling. */
  triggerVariant?: ButtonVariant;
  /** Trigger Button size (only used with triggerVariant). Defaults to "sm". */
  triggerSize?: ButtonSize;
  /** Trigger button content. */
  children: ReactNode;
}

/**
 * ExternalConsultationDialog
 *
 * Inline launcher for recording external consultancy income. Opens the shared
 * centered Dialog (identical UX to Appointments / Treatments / Payments /
 * Follow-ups) and reuses the existing recordConsultancyIncome server action —
 * no duplicated calculation, no duplicated persistence logic. Recording never
 * creates a patient, appointment, or clinic payment.
 */
export function ExternalConsultationDialog({
  triggerClassName,
  triggerVariant,
  triggerSize = "sm",
  children,
}: ExternalConsultationDialogProps) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [clinic, setClinic] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [isPaid, setIsPaid] = useState(false);
  const [notes, setNotes] = useState("");

  function resetForm() {
    setDate("");
    setStartTime("");
    setEndTime("");
    setClinic("");
    setDescription("");
    setAmount("");
    setIsPaid(false);
    setNotes("");
    setError(null);
  }

  function close() {
    if (isPending) return;
    setOpen(false);
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const res = await recordConsultancyIncome({
        date,
        external_clinic: clinic.trim() || undefined,
        description: description.trim() || undefined,
        // Optional: the slot is often reserved before the fee is agreed. An
        // empty box means "not known yet", which is not the same as zero.
        amount: amount.trim() === "" ? undefined : Number(amount),
        is_paid: isPaid,
        start_time: startTime || undefined,
        end_time: endTime || undefined,
        notes: notes.trim() || undefined,
      });
      if (res.error || !res.data) {
        setError(res.error ?? "Failed to record external consultation.");
        return;
      }
      resetForm();
      setOpen(false);
    });
  }

  return (
    <>
      {triggerVariant ? (
        <Button
          type="button"
          variant={triggerVariant}
          size={triggerSize}
          className={triggerClassName}
          onClick={() => setOpen(true)}
        >
          {children}
        </Button>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className={triggerClassName}>
          {children}
        </button>
      )}

      <Dialog
        open={open}
        onClose={close}
        title="Add External Consultation"
        description="Record income earned at another clinic. This is tracked separately from clinic payments."
        size="lg"
        busy={isPending}
      >
        <div className="p-6 space-y-4">
          {error && (
            <div
              role="alert"
              className="rounded-lg bg-danger-bg border border-danger-border px-4 py-3 text-xs text-danger"
            >
              {error}
            </div>
          )}

          <Field label="Date" htmlFor="ext-date" required>
            <CalendarPicker id="ext-date" value={date} onChange={setDate} placeholder="Select date" clearable />
          </Field>

          {/*
            Reserving the time.

            Filling both ends writes a consultancy_schedules block for that
            exact date and range — the table getAvailableSlots already subtracts
            from, so the slots disappear from the dentist, receptionist and
            patient-portal booking screens alike. Leaving them empty records the
            consultation without touching the schedule, which is what an
            after-the-fact entry needs.
          */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start Time" htmlFor="ext-start">
              <Input
                id="ext-start"
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
              />
            </Field>
            <Field label="End Time" htmlFor="ext-end">
              <Input
                id="ext-end"
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
              />
            </Field>
          </div>
          <p className="-mt-2 text-xs text-text-secondary">
            {startTime && endTime
              ? "This time will be blocked — no appointment can be booked in it."
              : "Optional. Set both to block the time so no appointment can be booked in it."}
          </p>

          <Field label="Clinic Name" htmlFor="ext-clinic">
            <Input
              id="ext-clinic"
              value={clinic}
              onChange={(e) => setClinic(e.target.value)}
              placeholder="e.g. Smile Care Dental"
            />
          </Field>

          <Field label="Treatment Performed" htmlFor="ext-desc">
            <Input
              id="ext-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Root canal consultation"
            />
          </Field>

          {/* Amount is OPTIONAL and stays editable after saving — see the
              External Consultations list. */}
          <Field label="Amount Earned (₹)" htmlFor="ext-amount">
            <Input
              id="ext-amount"
              type="number"
              min={0}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Leave blank if not yet known"
            />
          </Field>

          <Field label="Payment" htmlFor="ext-paid">
            <div className="flex items-center gap-2">
              <Button
                id="ext-paid"
                type="button"
                role="switch"
                aria-checked={isPaid}
                size="sm"
                onClick={() => setIsPaid((v) => !v)}
                className={cn(
                  isPaid
                    ? "bg-success text-success-foreground hover:bg-success-hover"
                    : "bg-surface-muted text-text-primary border border-border-strong hover:bg-border"
                )}
              >
                {isPaid ? <Check className="h-3.5 w-3.5" aria-hidden /> : <CircleDollarSign className="h-3.5 w-3.5" aria-hidden />}
                {isPaid ? "Paid" : "Not Paid"}
              </Button>
            </div>
          </Field>

          <Field label="Notes" htmlFor="ext-notes">
            <Textarea
              id="ext-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Optional"
            />
          </Field>
        </div>

        <div className="px-6 py-4 bg-background border-t border-border flex items-center justify-end gap-3">
          <Button type="button" variant="outline" size="sm" onClick={close} disabled={isPending}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={save} isLoading={isPending} disabled={isPending}>
            Save
          </Button>
        </div>
      </Dialog>
    </>
  );
}
