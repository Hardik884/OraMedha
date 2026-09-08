import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/layouts/PageHeader";
import { PatientDentalChartSection } from "@/components/dental-chart/PatientDentalChartSection";
import { getPatient } from "@/actions/patients";

export const metadata: Metadata = {
  title: "Dental Chart",
};

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}

/**
 * /dentist/patients/[id]/dental-chart
 *
 * The full-width dental chart.
 *
 * WHY A ROUTE AND NOT A MODAL
 *   The arch needs about 640px and both places that embed the chart render it
 *   inside a column, so it scrolls sideways in its own container. A modal would
 *   have solved the width, but the chart's own tooth-detail panel and
 *   bulk-update dialog are Dialogs too — opening one from inside another would
 *   put two focus traps and two body-scroll locks in play, and Escape would
 *   close both at once. A page has none of those problems and every existing
 *   interaction keeps working untouched.
 *
 * It renders the SAME PatientDentalChartSection the visit page does, so there
 * is one chart implementation, not a second "full" one that can drift.
 *
 * `?from` preserves the origin so Back returns where the user came from —
 * the same convention the bill route uses.
 */
export default async function DentistPatientDentalChartPage({ params, searchParams }: Props) {
  const [{ id }, { from }] = await Promise.all([params, searchParams]);
  if (!id) notFound();

  // Also the authorisation check: getPatient is dentist/receptionist-only and
  // scoped to the caller's clinic, so a patient outside it resolves to null.
  const patientResult = await getPatient(id);
  if (!patientResult.data) notFound();

  const patient = patientResult.data;

  const backHref = from
    ? `/dentist/appointments/${from}`
    : `/dentist/patients/${id}?tab=dental-chart`;

  return (
    <div className="p-6 lg:p-8 space-y-6 max-w-screen-2xl">
      <PageHeader
        title="Dental Chart"
        description={patient.name}
        backHref={backHref}
      />

      <PatientDentalChartSection patientId={id} patientName={patient.name} />
    </div>
  );
}
