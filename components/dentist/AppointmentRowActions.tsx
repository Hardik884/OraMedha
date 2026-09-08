"use client";

/**
 * AppointmentRowActions
 *
 * Inline actions for a row in the appointments table: View (navigates to the
 * Patient Visit), Reschedule and Cancel. Reschedule and Cancel open inline
 * dialogs and reuse the existing server actions + RescheduleModal /
 * ConfirmDialog — no navigation, no duplicated logic.
 */

import { useState, useTransition } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, CalendarClock, X, LogIn, PlayCircle } from "lucide-react";
import { cancelAppointment, updateAppointmentStatus } from "@/actions/appointments";
import { queryKeys } from "@/lib/query/keys";
import { RescheduleModal } from "@/components/shared/RescheduleModal";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { ACTION_BUTTON, ACTION_BUTTON_DANGER } from "@/lib/ui/action-styles";
import type { AppointmentStatus } from "@/types";

interface AppointmentRowActionsProps {
  appointmentId: string;
  scheduledAt: string;
  status: AppointmentStatus;
  clinicToday: string;
  viewHref: string;
}

const RESCHEDULABLE: string[] = ["scheduled", "checked_in"];
const CANCELLABLE: string[] = ["scheduled", "checked_in", "in_progress"];

export function AppointmentRowActions({
  appointmentId,
  scheduledAt,
  status,
  clinicToday,
  viewHref,
}: AppointmentRowActionsProps) {
  const queryClient = useQueryClient();
  const [showReschedule, setShowReschedule] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const canReschedule = RESCHEDULABLE.includes(status);
  const canCancel = CANCELLABLE.includes(status);
  const canCheckIn = status === "scheduled";
  const canMarkInProgress = status === "checked_in";

  function handleCancel() {
    setError(null);
    startTransition(async () => {
      const result = await cancelAppointment(appointmentId);
      if (result.error) {
        setError(result.error);
        setShowCancel(false);
        return;
      }
      setShowCancel(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.appointments.all });
    });
  }

  function handleStatus(newStatus: AppointmentStatus) {
    setError(null);
    startTransition(async () => {
      const result = await updateAppointmentStatus({
        appointment_id: appointmentId,
        new_status: newStatus,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.appointments.all });
    });
  }

  return (
    <div className="flex items-center justify-end gap-1.5">
      {/* Front-desk lifecycle actions lead the row — see the same note in
          AppointmentQuickActions. Only one is ever shown at a time. */}
      {canCheckIn && (
        <button
          type="button"
          onClick={() => handleStatus("checked_in")}
          disabled={isPending}
          className={ACTION_BUTTON}
        >
          <LogIn className="h-3 w-3" aria-hidden />
          Check In
        </button>
      )}

      {canMarkInProgress && (
        <button
          type="button"
          onClick={() => handleStatus("in_progress")}
          disabled={isPending}
          className={ACTION_BUTTON}
        >
          <PlayCircle className="h-3 w-3" aria-hidden />
          Mark In Progress
        </button>
      )}

      <Link href={viewHref} className={ACTION_BUTTON}>
        <Eye className="h-3 w-3" aria-hidden />
        View
      </Link>

      {canReschedule && (
        <button type="button" onClick={() => setShowReschedule(true)} className={ACTION_BUTTON}>
          <CalendarClock className="h-3 w-3" aria-hidden />
          Reschedule
        </button>
      )}

      {canCancel && (
        <button
          type="button"
          onClick={() => setShowCancel(true)}
          className={ACTION_BUTTON_DANGER}
        >
          <X className="h-3 w-3" aria-hidden />
          Cancel
        </button>
      )}

      {error && <span className="text-xs text-danger">{error}</span>}

      {showReschedule && (
        <RescheduleModal
          appointmentId={appointmentId}
          currentScheduledAt={scheduledAt}
          clinicToday={clinicToday}
          onClose={() => setShowReschedule(false)}
        />
      )}

      <ConfirmDialog
        open={showCancel}
        title="Cancel Appointment"
        description="Are you sure you want to cancel this appointment? This cannot be undone."
        confirmLabel="Yes, cancel it"
        variant="danger"
        onConfirm={handleCancel}
        onCancel={() => setShowCancel(false)}
        isLoading={isPending}
      />
    </div>
  );
}
