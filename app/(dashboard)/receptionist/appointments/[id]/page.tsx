import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/layouts/PageHeader";
import { CheckInButton } from "@/components/receptionist/CheckInButton";
import { AppointmentStatusBadge } from "@/components/shared/AppointmentStatusBadge";
import { RescheduleReceptionistPanel } from "@/components/receptionist/RescheduleReceptionistPanel";
import { CancelAppointmentButton } from "@/components/shared/CancelAppointmentButton";
import { AppointmentHistoryTimeline } from "@/components/shared/AppointmentHistoryTimeline";
import { ClinicalTextCard } from "@/components/shared/ClinicalTextCard";
import { MedicalHistoryCard } from "@/components/shared/MedicalHistoryCard";
import { AppointmentInvestigativeReportsSection } from "@/components/shared/AppointmentInvestigativeReportsSection";
import { getAppointment } from "@/actions/appointments";
import { getOutstandingBalance } from "@/actions/payments";
import { createServerClient } from "@/lib/supabase/server";
import { formatDateTimeInTimezone, formatCurrency, APPOINTMENT_SOURCE_LABELS, calculateAge, cn } from "@/lib/utils";
import type { AppointmentStatus } from "@/types";

export const metadata: Metadata = {
  title: "Appointment",
};

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * /receptionist/appointments/[id]
 *
 * Appointment detail — receptionist view.
 * Primary action: Check In (creates queue entry).
 * Secondary actions: Reschedule, Cancel.
 * No status advancement beyond check-in (dentist-only).
 * No internal_notes shown.
 */
export default async function ReceptionistAppointmentDetailPage({ params }: Props) {
  const { id } = await params;
  if (!id) notFound();

  const result = await getAppointment(id);
  if (!result.data) notFound();

  const appt = result.data;
  const status = appt.status as AppointmentStatus;
  const isTerminal = ["completed", "cancelled", "no_show"].includes(status);
  const isCheckedIn = status === "checked_in";

  const age = calculateAge(appt.patient.date_of_birth);
  const genderLabel = appt.patient.gender
    ? appt.patient.gender.charAt(0).toUpperCase() + appt.patient.gender.slice(1)
    : "—";

  // Fetch remaining balance
  const balanceResult = await getOutstandingBalance(appt.patient_id);
  const remainingBalance = balanceResult.data ?? 0;

  // Fetch clinic timezone for correct date/time display and RescheduleModal
  const supabase = await createServerClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = supabase;
  const { data: { user } } = await supabase.auth.getUser();

  let clinicTimezone = "Asia/Kolkata";
  let clinicToday: string | undefined;
  if (user) {
    const { data: profile } = await db
      .from("profiles")
      .select("clinic_id")
      .eq("id", user.id)
      .single();
    const clinicId = (profile as { clinic_id: string } | null)?.clinic_id;
    if (clinicId) {
      const { data: settings } = await db
        .from("clinic_settings")
        .select("timezone")
        .eq("clinic_id", clinicId)
        .maybeSingle();
      clinicTimezone = (settings as { timezone?: string } | null)?.timezone ?? "Asia/Kolkata";
      clinicToday = new Intl.DateTimeFormat("en-CA", {
        timeZone: clinicTimezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <PageHeader title="Appointment" backHref="/receptionist/appointments" />

      {/* ── Summary ──────────────────────────────────────────── */}
      <div className="bg-surface border rounded-lg p-6 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Link
              href={`/receptionist/patients/${appt.patient_id}`}
              className="text-lg font-semibold text-text-primary hover:text-accent"
            >
              {appt.patient.name}
            </Link>
            {appt.patient.phone && (
              <p className="text-sm text-text-secondary">{appt.patient.phone}</p>
            )}
          </div>
          <AppointmentStatusBadge status={status} />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 border-t">
          <Detail label="Date & Time" value={formatDateTimeInTimezone(appt.scheduled_at, clinicTimezone)} />
          <Detail label="Duration" value={`${appt.duration_minutes} min`} />
          <Detail label="Age" value={age !== null ? `${age} years` : "—"} />
          <Detail label="Gender" value={genderLabel} />
        </div>

        <div className="pt-4 border-t">
          <Detail label="Source" value={APPOINTMENT_SOURCE_LABELS[appt.source] ?? appt.source} />
        </div>

        <div className="pt-4 border-t">
          <Detail 
            label="Remaining Balance" 
            value={formatCurrency(remainingBalance)}
            highlight={remainingBalance > 0}
          />
        </div>

      </div>

      {/* ── Chief Complaints (receptionist can record before consult) ── */}
      <ClinicalTextCard
        appointmentId={appt.id}
        field="chief_complaints"
        title="Chief Complaints"
        placeholder="Enter chief complaints..."
        initialValue={appt.chief_complaints}
        canEdit
        rows={4}
      />

      {/* ── Medical History ──────────────────────────────────── */}
      <MedicalHistoryCard
        appointmentId={appt.id}
        initial={appt.medical_history}
        canEdit
      />

      {/* ── Investigative and Diagnostic Reports ──────────────── */}
      <AppointmentInvestigativeReportsSection appointmentId={appt.id} patientId={appt.patient_id} />

      {/* ── Actions ──────────────────────────────────────────── */}
      {!isTerminal && (
        <div className="bg-surface border rounded-lg p-4 space-y-3">
          <h3 className="text-sm font-semibold text-text-primary">Actions</h3>
          <div className="flex flex-wrap gap-3">
            {/* Check-in — only for scheduled appointments */}
            {status === "scheduled" && (
              <CheckInButton
                appointmentId={appt.id}
                isCheckedIn={isCheckedIn}
              />
            )}
            {isCheckedIn && (
              <div className="px-4 py-2 bg-success-bg text-success text-sm font-medium rounded-md border border-success-border">
                ✓ Checked In
              </div>
            )}

            {/* Reschedule */}
            <RescheduleReceptionistPanel
              appointmentId={appt.id}
              currentScheduledAt={appt.scheduled_at}
              clinicToday={clinicToday}
            />

            {/* Cancel */}
            <CancelAppointmentButton
              appointmentId={appt.id}
              redirectHref="/receptionist/appointments"
            />
          </div>
        </div>
      )}

      {/* ── History ──────────────────────────────────────────── */}
      <AppointmentHistoryTimeline history={appt.history} timezone={clinicTimezone} />
    </div>
  );
}

function Detail({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div>
      <p className="text-xs font-medium text-text-secondary uppercase tracking-wide">
        {label}
      </p>
      <p className={cn(
        "text-sm font-semibold mt-0.5",
        highlight ? "text-danger" : "text-text-primary"
      )}>
        {value}
      </p>
    </div>
  );
}
