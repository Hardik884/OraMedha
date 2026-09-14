import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/layouts/PageHeader";
import { TreatmentForm } from "@/components/dentist/TreatmentForm";
import { DeleteTreatmentButton } from "@/components/dentist/DeleteTreatmentButton";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { getTreatment } from "@/actions/treatments";
import { getPatientPayments } from "@/actions/payments";
import { PaymentList } from "@/components/dentist/PaymentList";
import { TreatmentDocumentsSection } from "@/components/dentist/TreatmentDocumentsSection";
import { MedicationTable } from "@/components/shared/MedicationTable";
import {
  formatDate,
  formatDateTime,
  formatCurrency,
  TREATMENT_STATUS_LABELS,
} from "@/lib/utils";
import type { TreatmentStatus, Payment, MedicationInput } from "@/types";

export const metadata: Metadata = {
  title: "Treatment",
};

interface Props {
  params: Promise<{ id: string }>;
}

const STATUS_VARIANT_MAP: Record<TreatmentStatus, "default" | "info" | "success" | "error"> = {
  planned: "default",
  in_progress: "info",
  completed: "success",
  cancelled: "error",
};

/**
 * /dentist/treatments/[id]
 *
 * Treatment detail + edit — dentist view.
 * Shows patient-visible notes, medications, and uploaded documents.
 * Includes payment summary for this treatment's appointment.
 */
export default async function DentistTreatmentDetailPage({ params }: Props) {
  const { id } = await params;
  if (!id) notFound();

  const result = await getTreatment(id);
  if (!result.data) notFound();

  const treatment = result.data;
  const medications: MedicationInput[] = Array.isArray(treatment.medications)
    ? (treatment.medications as unknown as MedicationInput[])
    : [];

  // Fetch appointment-level payments for payment summary
  const paymentsResult = await getPatientPayments(treatment.patient_id);
  const payments = (paymentsResult.data ?? []) as Payment[];
  const linkedPayments = treatment.appointment_id
    ? payments.filter((p) => p.appointment_id === treatment.appointment_id)
    : [];

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <PageHeader
        title="Treatment"
        backHref={`/dentist/patients/${treatment.patient_id}/treatments`}
      />

      {/* ── Info card ─────────────────────────────────────────── */}
      <div className="bg-surface border rounded-lg p-6 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">
              {treatment.treatment_type}
            </h2>
            <Link
              href={`/dentist/patients/${treatment.patient_id}`}
              className="text-sm text-accent hover:underline"
            >
              View Patient
            </Link>
          </div>
          <StatusBadge
            label={TREATMENT_STATUS_LABELS[treatment.status as TreatmentStatus]}
            variant={STATUS_VARIANT_MAP[treatment.status as TreatmentStatus]}
          />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 pt-4 border-t">
          <Detail label="Cost" value={formatCurrency(Number(treatment.cost))} />
          <Detail
            label="Performed"
            value={
              treatment.performed_at
                ? formatDateTime(treatment.performed_at)
                : "Not recorded"
            }
          />
          <Detail label="Added" value={formatDate(treatment.created_at)} />
        </div>

        {medications.length > 0 && (
          <div className="pt-4 border-t">
            <p className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2">
              Medications
            </p>
            <MedicationTable medications={medications} />
          </div>
        )}

        {treatment.patient_visible_notes && (
          <div className="pt-4 border-t">
            <p className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-1">
              Notes for patient (shown in portal)
            </p>
            <p className="text-sm text-text-secondary whitespace-pre-wrap">
              {treatment.patient_visible_notes}
            </p>
          </div>
        )}
      </div>

      {/* ── Documents ─────────────────────────────────────────── */}
      <TreatmentDocumentsSection treatmentId={id} />

      {/* ── Edit form ─────────────────────────────────────────── */}
      <TreatmentForm
        treatmentId={id}
        patientId={treatment.patient_id}
      />

      {/* ── Payment summary ───────────────────────────────────── */}
      {linkedPayments.length > 0 && (
        <div className="bg-surface border rounded-lg p-4 space-y-3">
          <h3 className="font-semibold text-text-primary text-sm">
            Payments for this Appointment
          </h3>
          <PaymentList payments={linkedPayments} role="dentist" />
        </div>
      )}

      {/* ── Delete ────────────────────────────────────────────── */}
      <div className="flex justify-end pt-2">
        <DeleteTreatmentButton
          treatmentId={id}
          treatmentType={treatment.treatment_type}
          patientId={treatment.patient_id}
        />
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-text-secondary uppercase tracking-wide">{label}</p>
      <p className="text-sm font-semibold text-text-primary mt-0.5">{value}</p>
    </div>
  );
}
