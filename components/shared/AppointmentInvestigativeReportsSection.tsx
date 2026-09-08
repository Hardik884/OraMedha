import { getAppointmentDocuments } from "@/actions/treatments";
import { InvestigativeReports } from "@/components/shared/InvestigativeReports";
import type { TreatmentDocument } from "@/types";

interface AppointmentInvestigativeReportsSectionProps {
  appointmentId: string;
  patientId: string;
  /** Staff can upload/remove; patients (portal) are view-only. */
  canManage?: boolean;
}

/**
 * AppointmentInvestigativeReportsSection
 *
 * Server Component — loads appointment-scoped radiographic documents (with
 * short-lived signed URLs) and renders the client manager.
 */
export async function AppointmentInvestigativeReportsSection({
  appointmentId,
  patientId,
  canManage = true,
}: AppointmentInvestigativeReportsSectionProps) {
  const result = await getAppointmentDocuments(appointmentId);
  const documents = (result.data ?? []) as Array<TreatmentDocument & { url: string | null }>;

  return (
    <InvestigativeReports
      appointmentId={appointmentId}
      patientId={patientId}
      documents={documents}
      canManage={canManage}
    />
  );
}
