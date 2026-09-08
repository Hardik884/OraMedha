/**
 * components/dental-chart/PatientDentalChartSection.tsx
 *
 * Server Component wrapper — fetches the patient's current (adult) dental
 * chart and renders the interactive client DentalChart. Used both as a
 * section on the Patient Visit page (with `appointmentId`, so new treatments
 * linked from a tooth attach to that visit) and as a tab on the Patient
 * Profile page (without `appointmentId` — TreatmentForm's own appointment
 * picker takes over there, same as PatientTreatmentsTab).
 *
 * Dentist-only, matching the dental chart's RLS/action access: a receptionist
 * or patient session simply won't be routed here (see the pages that render
 * this component).
 */

import Link from "next/link";
import { Maximize2 } from "lucide-react";

import { getPatientDentalChart } from "@/actions/dental-chart";
import { DentalChart } from "./DentalChart";

interface PatientDentalChartSectionProps {
  patientId: string;
  patientName?: string;
  appointmentId?: string;
  /**
   * Where "View Full Dental Chart" goes. Omitted on the full-chart page itself,
   * which is already the full view — a button linking to the page you are on is
   * worse than no button.
   */
  fullViewHref?: string;
}

export async function PatientDentalChartSection({
  patientId,
  patientName,
  appointmentId,
  fullViewHref,
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
    <div className="bg-surface border border-border rounded-xl p-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-text-primary">Dental Chart</h3>
          <p className="text-xs text-text-secondary mt-0.5">
            Click a tooth to view its condition and history, or link a treatment.
          </p>
        </div>

        {/*
          The arch needs ~640px and this card is a column on both pages that
          render it, so the chart scrolls sideways inside its own container.
          This opens the SAME component on a full-width page, where it fits —
          a dedicated route rather than a modal because the tooth detail panel
          and the bulk-update dialog are themselves Dialogs, and nesting them
          would put two focus traps and two body-scroll locks in play at once.
        */}
        {fullViewHref && (
          <Link
            href={fullViewHref}
            className="inline-flex items-center gap-1.5 shrink-0 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-surface-muted transition-colors"
          >
            <Maximize2 className="h-3 w-3" aria-hidden />
            View Full Dental Chart
          </Link>
        )}
      </div>
      <DentalChart
        patientId={patientId}
        patientName={patientName}
        appointmentId={appointmentId}
        initialChart={result.data}
      />
    </div>
  );
}
