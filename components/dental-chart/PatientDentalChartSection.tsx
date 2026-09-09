/**
 * components/dental-chart/PatientDentalChartSection.tsx
 *
 * Server Component wrapper — fetches the patient's current (adult) dental
 * chart and renders the interactive client DentalChartCard. Used both as a
 * section on the Patient Visit page (with `appointmentId`, so new treatments
 * linked from a tooth attach to that visit) and as a tab on the Patient
 * Profile page (without `appointmentId` — TreatmentForm's own appointment
 * picker takes over there, same as PatientTreatmentsTab).
 *
 * Dentist-only, matching the dental chart's RLS/action access: a receptionist
 * or patient session simply won't be routed here (see the pages that render
 * this component).
 */

import { getPatientDentalChart } from "@/actions/dental-chart";
import { DentalChartCard } from "./DentalChartCard";

interface PatientDentalChartSectionProps {
  patientId: string;
  patientName?: string;
  appointmentId?: string;
  /**
   * Show the "View Full Dental Chart" expand toggle. It expands the SAME
   * chart inline (see DentalChartCard) — no navigation. Omitted on the
   * standalone /dentist/patients/[id]/dental-chart route itself, which is
   * already the full view: a button that expands the page you are on is
   * worse than no button.
   */
  canExpand?: boolean;
}

export async function PatientDentalChartSection({
  patientId,
  patientName,
  appointmentId,
  canExpand = false,
}: PatientDentalChartSectionProps) {
  const result = await getPatientDentalChart(patientId, "adult");

  if (result.error || !result.data) {
    return (
      <div className="bg-surface border border-border rounded-xl p-4">
        <h3 className="font-semibold text-text-primary mb-2">Dental Chart</h3>
        <p className="text-sm text-danger bg-danger-bg border border-danger-border rounded-md px-3 py-2">
          {result.error ?? "Failed to load dental chart."}
        </p>
      </div>
    );
  }

  return (
    <DentalChartCard
      canExpand={canExpand}
      patientId={patientId}
      patientName={patientName}
      appointmentId={appointmentId}
      initialChart={result.data}
    />
  );
}
