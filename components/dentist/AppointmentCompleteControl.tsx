"use client";

import { useState, useTransition } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { updateAppointmentStatus } from "@/actions/appointments";
import { queryKeys } from "@/lib/query/keys";
import { Button } from "@/components/ui/button";
import { CheckCircle2 } from "lucide-react";
import type { AppointmentStatus } from "@/types";

interface AppointmentCompleteControlProps {
  appointmentId: string;
  currentStatus?: AppointmentStatus;
  /**
   * True when the appointment is a no-show the nightly job inferred recently
   * enough to be corrected. Computed server-side from the appointment's history.
   */
  correctableNoShow?: boolean;
}

/**
 * AppointmentCompleteControl
 *
 * Patient Visit page action. Shows a single "Mark as Complete" button while the
 * appointment is still active (not completed / cancelled / no_show), and for a
 * no-show the system inferred within its correction window. All other
 * operational actions (Check In, Mark In Progress, Reschedule, Cancel) live in
 * the appointments table.
 *
 * One click is ONE completion. It no longer walks the appointment through
 * checked-in and in-progress on the way: those are an arrival and a call-in, and
 * inventing them stamped a check-in and a queue row at the moment of the click.
 * The server completes the visit directly and records only what happened — see
 * lib/appointments/visit-completion.ts.
 */
const COMPLETABLE: AppointmentStatus[] = ["scheduled", "checked_in", "in_progress"];

export function AppointmentCompleteControl({
  appointmentId,
  currentStatus = "scheduled",
  correctableNoShow = false,
}: AppointmentCompleteControlProps) {
  const queryClient = useQueryClient();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Only active appointments (or a correctable inferred no-show) can be completed.
  const canComplete = COMPLETABLE.includes(currentStatus) || (currentStatus === "no_show" && correctableNoShow);

  if (!canComplete) return null;

  function markComplete() {
    setError(null);
    startTransition(async () => {
      const res = await updateAppointmentStatus({
        appointment_id: appointmentId,
        new_status: "completed",
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.appointments.all });
    });
  }

  return (
    <div className="bg-surface border border-border rounded-xl p-5 space-y-3">
      <h3 className="text-sm font-semibold text-text-primary">Actions</h3>

      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}

      <Button
        type="button"
        size="sm"
        onClick={markComplete}
        isLoading={isPending}
        disabled={isPending}
      >
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
        Mark as Complete
      </Button>
    </div>
  );
}
