import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/layouts/PageHeader";
import { AppointmentCompleteControl } from "@/components/dentist/AppointmentCompleteControl";
import { AppointmentHistoryTimeline } from "@/components/shared/AppointmentHistoryTimeline";
import { AppointmentStatusBadge } from "@/components/shared/AppointmentStatusBadge";
import { AppointmentTreatmentsSection } from "@/components/dentist/AppointmentTreatmentsSection";
import { VisitBillingSection } from "@/components/billing/VisitBillingSection";
import { PatientFinancialTimeline } from "@/components/dentist/PatientFinancialTimeline";
import { AppointmentFollowUpsSection } from "@/components/dentist/AppointmentFollowUpsSection";
import { ClinicalTextCard } from "@/components/shared/ClinicalTextCard";
import { MedicalHistoryCard } from "@/components/shared/MedicalHistoryCard";
import { AppointmentInvestigativeReportsSection } from "@/components/shared/AppointmentInvestigativeReportsSection";
import { PatientDentalChartSection } from "@/components/dental-chart/PatientDentalChartSection";
import { getAppointment } from "@/actions/appointments";
import { getOutstandingBalance } from "@/actions/payments";
import { createServerClient } from "@/lib/supabase/server";
import { formatDateTimeInTimezone, formatCurrency, APPOINTMENT_SOURCE_LABELS, calculateAge } from "@/lib/utils";
import type { AppointmentStatus } from "@/types";

export const metadata: Metadata = {
  title: "Patient Visit",
};

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * /dentist/appointments/[id]
 *
 * Server Component — full appointment detail + lifecycle controls.
 *
 * Shows:
 * - Appointment metadata (patient, time, source, duration, notes)
 * - AppointmentStatusControl (advance/cancel/reschedule — client component)
 * - AppointmentHistoryTimeline (audit trail)
 * - Link to patient profile
 */
export default async function DentistAppointmentDetailPage({ params }: Props) {
  const { id } = await params;
  if (!id) notFound();

  const result = await getAppointment(id);
  if (!result.data) notFound();

  const appt = result.data;
  const age = calculateAge(appt.patient.date_of_birth);
  const genderLabel = appt.patient.gender
    ? appt.patient.gender.charAt(0).toUpperCase() + appt.patient.gender.slice(1)
    : "—";

  // Fetch remaining balance
  const balanceResult = await getOutstandingBalance(appt.patient_id);
  const remainingBalance = balanceResult.data ?? 0;

  // Fetch clinic timezone for correct date/time display and for RescheduleModal
  const supabase = await createServerClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = supabase;
  const { data: { user } } = await supabase.auth.getUser();

  let clinicTimezone = "Asia/Kolkata";
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
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <PageHeader title="Patient Visit" backHref="/dentist/appointments" />

      {/* ── Summary card ─────────────────────────────────────── */}
      <div className="bg-surface border rounded-lg p-6 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Link
              href={`/dentist/patients/${appt.patient_id}`}
              className="text-lg font-semibold text-text-primary hover:text-accent transition-colors"
            >
              {appt.patient.name}
            </Link>
            {appt.patient.phone && (
              <p className="text-sm text-text-secondary">{appt.patient.phone}</p>
            )}
          </div>
          <AppointmentStatusBadge status={appt.status as AppointmentStatus} />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 border-t">
          <Detail label="Date & Time" value={formatDateTimeInTimezone(appt.scheduled_at, clinicTimezone)} />
          <Detail
            label="Source"
            value={APPOINTMENT_SOURCE_LABELS[appt.source] ?? appt.source}
          />
          <Detail label="Age" value={age !== null ? `${age} years` : "—"} />
          <Detail label="Gender" value={genderLabel} />
        </div>

        <div className="pt-4 border-t">
          <Detail 
            label="Remaining Balance" 
            value={formatCurrency(remainingBalance)}
            highlight={remainingBalance > 0}
          />
        </div>
      </div>

      {/* ── Chief Complaints ─────────────────────────────────── */}
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

      {/*
        ── Dental Chart ──────────────────────────────────────
        Sits between the history and the findings deliberately: the chart is
        what the clinician reads the mouth against while examining, so it comes
        before the findings that examination produces, and after the history
        that frames it.
      */}
      <PatientDentalChartSection
        patientId={appt.patient_id}
        patientName={appt.patient.name}
        appointmentId={appt.id}
        fullViewHref={`/dentist/patients/${appt.patient_id}/dental-chart?from=${appt.id}`}
      />

      {/* ── Oral & Radiographic Findings (dentist only) ──────── */}
      <ClinicalTextCard
        appointmentId={appt.id}
        field="oral_findings"
        title="Oral & Radiographic Findings"
        placeholder="Record intra-oral examination and radiographic findings…"
        initialValue={appt.oral_findings}
        canEdit
        rows={4}
      />

      {/* ── Investigative and Diagnostic Reports ──────────────── */}
      <AppointmentInvestigativeReportsSection appointmentId={appt.id} patientId={appt.patient_id} />

      {/* ── Provisional Diagnosis (dentist only) ─────────────── */}
      <ClinicalTextCard
        appointmentId={appt.id}
        field="provisional_diagnosis"
        title="Provisional Diagnosis"
        placeholder="Enter provisional diagnosis..."
        initialValue={appt.provisional_diagnosis}
        canEdit
        rows={3}
      />

      {/* ── Treatments: Current Treatment + Past Treatment History ── */}
      <AppointmentTreatmentsSection
        appointmentId={appt.id}
        patientId={appt.patient_id}
        patientName={appt.patient.name}
      />

      {/* ── The patient's running account, across every visit ─
           Placed ABOVE the per-visit panel on purpose: a follow-up visit has no
           treatments or payments of its own yet, so the panel below renders
           empty and reads as "nothing owed". This is the context that stops
           that misreading. */}
      <PatientFinancialTimeline
        patientId={appt.patient_id}
        appointmentId={appt.id}
        followUpId={appt.follow_up_id}
      />

      {/* ── Billing & Payments for this appointment: [Bill] [Payments] ─
           Payments panel is the existing AppointmentPaymentsSection,
           reused unmodified. ── */}
      <VisitBillingSection
        appointmentId={appt.id}
        patientId={appt.patient_id}
        patientName={appt.patient.name}
        baseHref="/dentist"
      />

      {/* ── Follow-up appointments linked to this visit ─────── */}
      <AppointmentFollowUpsSection
        appointmentId={appt.id}
        patientId={appt.patient_id}
        patientName={appt.patient.name}
      />

      {/* ── Workflow action: Mark as Complete (only while active) ── */}
      <AppointmentCompleteControl
        appointmentId={appt.id}
        currentStatus={appt.status as AppointmentStatus}
      />

      {/* ── Audit history timeline ───────────────────────────── */}
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

// Add cn utility import at the top with other imports
import { cn } from "@/lib/utils";
