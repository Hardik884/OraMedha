"use client";

import { useState, useTransition } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { TreatmentFormDialog } from "./TreatmentFormDialog";
import { PaymentFormDialog } from "./PaymentFormDialog";
import { FollowUpFormDialog } from "@/components/follow-ups/FollowUpFormDialog";
import { RescheduleModal } from "@/components/shared/RescheduleModal";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { updateAppointmentStatus, cancelAppointment } from "@/actions/appointments";
import { queryKeys } from "@/lib/query/keys";
import { VALID_APPOINTMENT_TRANSITIONS } from "@/types";
import { ACTION_BUTTON, ACTION_BUTTON_DANGER } from "@/lib/ui/action-styles";
import {
  Eye,
  Stethoscope,
  Bell,
  CreditCard,
  CalendarClock,
  CheckCircle2,
  LogIn,
  PlayCircle,
  X,
} from "lucide-react";
import type { AppointmentStatus } from "@/types";

interface AppointmentQuickActionsProps {
  appointmentId: string;
  patientId: string;
  patientName: string;
  baseHref: string;
  currentStatus: AppointmentStatus;
  currentScheduledAt: string;
  clinicToday?: string;
}

/**
 * AppointmentQuickActions
 *
 * Operational quick actions for an upcoming appointment on Today's Dashboard.
 * Reuses the shared inline dialogs (Treatment / Follow-up / Payment), the
 * RescheduleModal, the ConfirmDialog, and the updateAppointmentStatus /
 * cancelAppointment actions — no new business logic. Every action keeps the
 * user on the dashboard and refreshes in place.
 *
 * Status buttons (Check In / Mark In Progress / Mark as Complete / Cancel) are
 * derived from VALID_APPOINTMENT_TRANSITIONS, so they only appear when the
 * transition is actually allowed for the current status.
 */
export function AppointmentQuickActions({
  appointmentId,
  patientId,
  patientName,
  baseHref,
  currentStatus,
  currentScheduledAt,
  clinicToday,
}: AppointmentQuickActionsProps) {
  const queryClient = useQueryClient();
  const [isPending, startTransition] = useTransition();
  const [showReschedule, setShowReschedule] = useState(false);
  const [showCancel, setShowCancel] = useState(false);

  const validNext = VALID_APPOINTMENT_TRANSITIONS[currentStatus] ?? [];
  const canCheckIn = validNext.includes("checked_in");
  const canStart = validNext.includes("in_progress");
  const canComplete = validNext.includes("completed");
  const canCancel = validNext.includes("cancelled");
  const canReschedule = ["scheduled", "checked_in"].includes(currentStatus);

  function transitionTo(status: AppointmentStatus) {
    startTransition(async () => {
      const result = await updateAppointmentStatus({
        appointment_id: appointmentId,
        new_status: status,
      });
      if (!result.error) {
        queryClient.invalidateQueries({ queryKey: queryKeys.appointments.all });
      }
    });
  }

  function handleCancel() {
    startTransition(async () => {
      const result = await cancelAppointment(appointmentId);
      if (!result.error) {
        setShowCancel(false);
        queryClient.invalidateQueries({ queryKey: queryKeys.appointments.all });
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/*
        FRONT-DESK ACTIONS COME FIRST.

        These three move the visit through its lifecycle and are what the desk
        reaches for dozens of times a day. They used to sit at the END of the
        row, behind View / Treatment / Follow-up / Payment — so on a narrow
        screen the row wrapped and the one button that mattered was on the
        second line, in a position that moved depending on which of the others
        happened to render.

        Only one of the three is ever shown at once (the statuses are mutually
        exclusive), so the leftmost slot holds "the next thing to do to this
        appointment" and nothing else.
      */}
      {canCheckIn && (
        <button
          type="button"
          className={ACTION_BUTTON}
          onClick={() => transitionTo("checked_in")}
          disabled={isPending}
        >
          <LogIn className="h-3 w-3" aria-hidden />
          Check In
        </button>
      )}

      {canStart && (
        <button
          type="button"
          className={ACTION_BUTTON}
          onClick={() => transitionTo("in_progress")}
          disabled={isPending}
        >
          <PlayCircle className="h-3 w-3" aria-hidden />
          Mark In Progress
        </button>
      )}

      {canComplete && (
        <button
          type="button"
          className={ACTION_BUTTON}
          onClick={() => transitionTo("completed")}
          disabled={isPending}
        >
          <CheckCircle2 className="h-3 w-3" aria-hidden />
          Mark as Complete
        </button>
      )}

      <Link href={`${baseHref}/appointments/${appointmentId}`} className={ACTION_BUTTON}>
        <Eye className="h-3 w-3" aria-hidden />
        View
      </Link>

      <TreatmentFormDialog
        appointmentId={appointmentId}
        patientId={patientId}
        triggerClassName={ACTION_BUTTON}
      >
        <Stethoscope className="h-3 w-3" aria-hidden />
        Treatment
      </TreatmentFormDialog>

      <FollowUpFormDialog
        patientId={patientId}
        patientName={patientName}
        appointmentId={appointmentId}
        triggerClassName={ACTION_BUTTON}
      >
        <Bell className="h-3 w-3" aria-hidden />
        Follow-up
      </FollowUpFormDialog>

      <PaymentFormDialog
        patientId={patientId}
        patientName={patientName}
        appointmentId={appointmentId}
        triggerClassName={ACTION_BUTTON}
      >
        <CreditCard className="h-3 w-3" aria-hidden />
        Payment
      </PaymentFormDialog>

      {canReschedule && (
        <button type="button" className={ACTION_BUTTON} onClick={() => setShowReschedule(true)}>
          <CalendarClock className="h-3 w-3" aria-hidden />
          Reschedule
        </button>
      )}

      {canCancel && (
        <button
          type="button"
          className={ACTION_BUTTON_DANGER}
          onClick={() => setShowCancel(true)}
          disabled={isPending}
        >
          <X className="h-3 w-3" aria-hidden />
          Cancel
        </button>
      )}

      {showReschedule && (
        <RescheduleModal
          appointmentId={appointmentId}
          currentScheduledAt={currentScheduledAt}
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
